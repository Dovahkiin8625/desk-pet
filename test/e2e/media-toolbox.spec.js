// 媒体工具箱：面板入口能打开剪辑编辑器大窗口（file:// 独立窗口）。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-media-toolbox');

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

/** 按 URL 片段在所有窗口里找某一个。 */
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

/** 打开面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel?.());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes('/renderer/panel/index.html')) {
          await win.waitForLoadState('domcontentloaded');
          return win;
        }
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('面板没有出现');
}

test.describe('媒体工具箱', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test('面板里能找到插件，点入口按钮能打开编辑器大窗口', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'meiti');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('media-toolbox'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("媒体工具箱")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'media-toolbox', null, {
        timeout: 10000,
      });
      await panel.click('text=打开媒体编辑器');

      const editor = await findWindow(app, 'media-toolbox/pages/editor.html');
      expect(editor, '编辑器窗口没有出现').not.toBeNull();
      await editor.waitForLoadState('domcontentloaded');
      // 核心骨架都在（说明 JS 没在初始化时炸）
      await expect(editor.locator('#stageCanvas')).toBeAttached();
      await expect(editor.locator('.tl-header-row')).toHaveCount(3);
      await expect(editor.locator('#importBtn')).toBeAttached();
      // preload 的桥就位
      const bridge = await editor.evaluate(() => typeof window.mt?.invoke);
      expect(bridge).toBe('function');
      // 导出接口已就绪
      const ffmpeg = await editor.evaluate(() => window.mt.invoke({ id: 'ffmpeg.check' }));
      expect(ffmpeg?.ok, ffmpeg?.message).toBe(true);
    } finally {
      await app.close();
    }
  });
});
