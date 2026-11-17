// 截图插件的端到端验证。
//
// 覆盖一件事：**在桌面上框一块 → 识别文字**这一整条路是通的。
//
// 识别的内容不验：屏幕上有什么字取决于当时开着什么窗口。
// 验的是「识别跑完了」——要么认出几行，要么一个字也没有，
// 两种都说明那条路走通了。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-screenshot');

/** 启动应用（E2E 模式：不抢单实例锁，用临时 userData）。 */
async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes(part)) return win;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** 打开插件面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  if (!panel) throw new Error('面板窗口没有出现');
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => window.__panel?.ready === true, null, { timeout: 15000 });
  return panel;
}

/** 找出主屏上的那个遮罩（竖屏那块便携屏不要）。 */
async function findOverlay(app) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (!win.url().includes('overlay.html')) continue;
        const size = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        if (size.w >= size.h) return win;
      } catch {
        /* 窗口还没准备好 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

test.beforeEach(async () => {
  await rm(USER_DATA, { recursive: true, force: true });
});

test.afterEach(async () => {
  await rm(USER_DATA, { recursive: true, force: true });
});

test('截图插件：桌面上框一块 → 识别文字', async () => {
  const { app, pet } = await launch();
  try {
    const panel = await openPanel(app, pet);
    await panel.fill('#query', '截图');
    await panel.waitForFunction(
      () => window.__panel?.resultIds?.includes('screenshot'),
      null,
      { timeout: 10000 }
    );
    await panel.click('#results li:has-text("截图")');
    await panel.waitForFunction(() => window.__panel?.pluginId === 'screenshot', null, {
      timeout: 10000,
    });

    const frame = panel.frameLocator('#plugin-frame');
    await frame.locator('#shotBtn').click();

    // 遮罩铺在桌面上：每一块屏一个窗口。
    const overlay = await findOverlay(app);
    expect(overlay, '遮罩窗口没有出现').toBeTruthy();

    // 拖一块：工具条就该出现在选区下面。
    const size = await overlay.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await overlay.mouse.move(size.w * 0.3, size.h * 0.3);
    await overlay.mouse.down();
    await overlay.mouse.move(size.w * 0.6, size.h * 0.5, { steps: 8 });
    await overlay.mouse.up();
    await expect(overlay.locator('.tools')).toBeVisible({ timeout: 10000 });

    // 识别：跑完了就算成（认出几行，或一个字也没有）。
    await overlay.locator('.tools button:has-text("识别文本")').click();
    const result = await findWindow(app, 'result.html');
    expect(result, '结果窗口没有出现').toBeTruthy();
    await result.waitForLoadState('domcontentloaded');
    await expect(result.locator('#text')).not.toBeEmpty({ timeout: 60000 });
  } finally {
    await app.close();
  }
});
