// 插件能不能分离成独立窗口——**每个**插件都能。
//
// 录屏的清单里没写 `window` 段：以前它的面板上没有「在新窗口打开」按钮，
// 现在必须有，而且点了要真能开出一个窗口。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
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
});
