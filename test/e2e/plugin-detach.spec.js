// 插件能不能分离成独立窗口——**每个**插件都能。
//
// 录屏的清单里没写 `window` 段：以前它的面板上没有「在新窗口打开」按钮，
// 现在必须有，而且点了要真能开出一个窗口。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-detach');

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

test.describe('插件分离成独立窗口', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('清单里没写 window 段的插件（录屏）也能分离成独立窗口', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'luping');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('screen-recorder'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("录屏")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, {
        timeout: 10000,
      });

      // 按钮在（以前它被藏掉了）。
      await expect(panel.locator('#detach')).toBeVisible();

      // 点了要真能开出一个窗口——以前这里会报「这个插件不能分离成独立窗口」。
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '录屏的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');
      await pluginWin.waitForFunction(() => document.getElementById('title')?.textContent === '录屏', null, {
        timeout: 15000,
      });
    } finally {
      await app.close();
    }
  });

  test('独立窗口：比面板宽，拖过的尺寸被记住，⛶ 能恢复默认', async () => {
    const { app, pet } = await launch();
    /** 独立窗口当前的尺寸。 */
    const windowSize = () =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.getURL().includes('/renderer/plugin-window/index.html')
        );
        return w ? w.getSize() : null;
      });
    /** 在面板里打开待办，并分离成独立窗口。 */
    const detachTodos = async () => {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("待办")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });
      await panel.click('#detach');
      return panel;
    };

    try {
      await detachTodos();
      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(win, '待办的独立窗口没有出现').not.toBeNull();
      await win.waitForLoadState('domcontentloaded');

      // 独立窗口比面板宽得多（清单里待办是 640×600）。
      const size = await windowSize();
      expect(size[0]).toBeGreaterThanOrEqual(620);

      // 拖过之后：尺寸被记住（重新打开还是这个大小）。
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.getURL().includes('/renderer/plugin-window/index.html')
        );
        w.setSize(700, 500);
      });
      await new Promise((r) => setTimeout(r, 800)); // 等去抖写盘
      await win.click('#close');
      await new Promise((r) => setTimeout(r, 500));

      // 面板在分离时收起来了：再打开一次，回到搜索视图。
      await detachTodos();
      const win2 = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(win2, '待办的独立窗口没有再出现').not.toBeNull();
      await win2.waitForLoadState('domcontentloaded');
      const size2 = await windowSize();
      expect(size2[0]).toBe(700);
      expect(size2[1]).toBe(500);

      // ⛶：恢复成清单里的尺寸（待办 640×600）。
      await win2.click('#reset-size');
      await new Promise((r) => setTimeout(r, 500));
      const size3 = await windowSize();
      expect(size3[0]).toBe(640);
      expect(size3[1]).toBe(600);

      // 那条记忆被忘掉了：插件作者以后改了清单里的尺寸，用户才看得到。
      const prefs = JSON.parse(await readFile(join(USER_DATA, 'plugins.json'), 'utf8'));
      expect(prefs.windowSizes?.todos, '恢复默认后不该还记着尺寸').toBeUndefined();
    } finally {
      await app.close();
    }
  });

  test('拖完立刻关掉窗口：主进程不该被带崩', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("待办")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });
      await panel.click('#detach');

      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(win, '待办的独立窗口没有出现').not.toBeNull();
      await win.waitForLoadState('domcontentloaded');

      // 拖一下，然后**马上**关掉：去抖写盘还没轮到，窗口就没了。
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.getURL().includes('/renderer/plugin-window/index.html')
        );
        w.setSize(700, 500);
      });
      await win.click('#close');

      // 等过去去抖的那一下（400ms），再看主进程还活着没有。
      await new Promise((r) => setTimeout(r, 1200));
      const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      expect(alive).toBeGreaterThan(0);

      // 应用还能用：面板照常能开。
      await pet.evaluate(() => window.pet.openPanel?.());
      await new Promise((r) => setTimeout(r, 800));
      const panel2 = await findWindow(app, '/renderer/panel/index.html');
      expect(panel2, '面板开不出来了').not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
