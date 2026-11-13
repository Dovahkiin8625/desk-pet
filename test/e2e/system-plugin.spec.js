// 系统状态插件的端到端验证。
//
// 验的是**用户在界面上真能看见的东西**：
// - 面板里是三条用量（CPU / 内存 / GPU），不是一段纯文本；
// - 底下那行字摆着温度与电源；
// - 过热提醒的开关在右边的抽屉里；
// - 独立窗口里装的是同一份页面。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-system');

/** 启动桌宠。 */
async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: USER_DATA, DESK_PET_E2E: '1' },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes(part)) return w;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开面板并走到系统状态的页面。 */
async function openSystemPlugin(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  await panel.fill('#query', '系统状态');
  await panel.waitForFunction(() => window.__panel?.resultIds?.includes('system'), null, {
    timeout: 10000,
  });
  await panel.click('#results li:has-text("系统状态")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'system', null, { timeout: 10000 });
  return panel;
}

test.describe('系统状态插件', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('面板里是三条用量，不是一段纯文本', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openSystemPlugin(app, pet);
      const frame = panel.frameLocator('#plugin-frame');

      // 三条用量：CPU、内存、GPU。
      await expect(frame.locator('.meter')).toHaveCount(3, { timeout: 20000 });
      await expect(frame.locator('.meter .name').first()).toHaveText('CPU');
      await expect(frame.locator('.meter .name').nth(1)).toHaveText('内存');
      await expect(frame.locator('.meter .name').nth(2)).toHaveText('GPU');

      // 底下那行字：温度与电源。
      await expect(frame.locator('#info')).toContainText('温度', { timeout: 20000 });
    } finally {
      await app.close();
    }
  });

  test('过热提醒在右边的抽屉里', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openSystemPlugin(app, pet);
      const frame = panel.frameLocator('#plugin-frame');

      // 抽屉关着的时候，那个开关看不见。
      await expect(frame.locator('#hotAlert')).toBeHidden();

      await frame.locator('#gearBtn').click();
      await expect(frame.locator('#hotAlert')).toBeVisible({ timeout: 10000 });
      await expect(frame.locator('.dp-field')).toContainText('过热时提醒我');
    } finally {
      await app.close();
    }
  });

  test('独立窗口里装的是同一份页面', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openSystemPlugin(app, pet);
      await panel.evaluate(() => document.querySelector('#detach')?.click());

      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').toBeTruthy();
      await pluginWin.waitForLoadState('domcontentloaded');

      const frame = pluginWin.frameLocator('#plugin-frame');
      await expect(frame.locator('.meter')).toHaveCount(3, { timeout: 20000 });
      await expect(frame.locator('#info')).toContainText('温度', { timeout: 20000 });
    } finally {
      await app.close();
    }
  });
});
