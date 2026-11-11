// 桌宠动了，桌面小部件**不能**跟着跑。
//
// 小部件常驻桌面：用户自己把它拖到哪儿，它就该待在哪儿。
// 以前它跟着桌宠跑——拖一下桌宠，小部件就跳到桌宠旁边（头顶），
// 用户刚摆好的位置全白费。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-widget-position');

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

/** 主进程里小部件那个窗口的位置（认 URL：小部件加载的是插件自己的 widget 页面）。 */
async function widgetBounds(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('widget.html')
    );
    if (!win) return null;
    const [x, y] = win.getPosition();
    return { x, y };
  });
}

test.describe('桌面小部件的位置', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('拖动桌宠时，小部件待在原地', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'xituan');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('system'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("系统状态")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'system', null, {
        timeout: 10000,
      });

      // 把它变成桌面小部件。
      await expect(panel.locator('#widget')).toBeVisible();
      await panel.evaluate(() => document.querySelector('#widget')?.click());
      await expect
        .poll(async () => await widgetBounds(app), { timeout: 15000 })
        .not.toBeNull();
      const before = await widgetBounds(app);

      // 拖桌宠：走的是拖拽用的那条 IPC，和真拖一样。
      for (let i = 0; i < 5; i++) {
        await pet.evaluate(() => window.pet.moveWindowBy(40, 30));
        await pet.waitForTimeout(30);
      }

      // 小部件没动。
      expect(await widgetBounds(app)).toEqual(before);
    } finally {
      await app.close();
    }
  });
});
