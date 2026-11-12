// 宽版与窄版：同一个插件，在面板里与在独立窗口里是两种形态。
//
// 宽窄由**可用宽度**决定（断点 560px）：
// - 面板窄（420 宽）→ 永远是窄版；
// - 独立窗口宽（默认 640～860）→ 宽版：条目型内容分两列，一屏看完更多；
// - 用户把窗口拖到 560 以下 → 退回窄版。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-responsive');

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

test.describe('宽版与窄版', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('宽窄由宽度决定：面板窄版、独立窗口宽版、拖窄了又变窄版', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("待办")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });

      // 待办是空的时画的是「空态」块，没有列表——先加一条，列表才在。
      await panel.fill('#plugin-body input[type="text"]', '写测试');
      await panel.press('#plugin-body input[type="text"]', 'Enter');
      await panel.waitForFunction(() => document.querySelector('.block-list'), null, { timeout: 10000 });

      // 面板里：单列（容器查询不命中）。
      const inPanel = await panel.evaluate(() => {
        const list = document.querySelector('.block-list');
        return list ? getComputedStyle(list).columnCount : 'none';
      });
      expect(inPanel).toBe('auto');

      // 独立窗口：两列。
      await panel.click('#detach');
      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(win, '待办的独立窗口没有出现').not.toBeNull();
      await win.waitForLoadState('domcontentloaded');
      await win.waitForFunction(() => document.querySelector('.block-list'), null, { timeout: 10000 });
      const inWindow = await win.evaluate(
        () => getComputedStyle(document.querySelector('.block-list')).columnCount
      );
      expect(inWindow).toBe('2');

      // 拖窄到 560 以下：退回窄版。
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.getURL().includes('/renderer/plugin-window/index.html')
        );
        w.setSize(500, 500);
      });
      await new Promise((r) => setTimeout(r, 400));
      const narrowed = await win.evaluate(
        () => getComputedStyle(document.querySelector('.block-list')).columnCount
      );
      expect(narrowed).toBe('auto');
    } finally {
      await app.close();
    }
  });
});
