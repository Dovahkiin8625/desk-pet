// 设置页「插件」分区的详情抽屉。
//
// 盯的是三件事：
//   1. 点一行，右边滑出抽屉，里面是**那个插件**的详情（不是别人的）；
//   2. 勾选框**不**打开抽屉——它只管开关；
//   3. 抽屉里的开关与清单里的勾选框是同一件事：拨了会落盘。
import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-plugin-drawer');

async function launch(userData) {
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: userData, DESK_PET_E2E: '1' },
  });
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开设置窗口并切到「插件」那一节。 */
async function openPluginSection(app) {
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  await settings.click('#tab-plugins');
  await settings.waitForSelector('#panel-plugins:not([hidden])', { timeout: 10000 });
  await settings.waitForFunction(
    () => document.querySelectorAll('#pluginList .plugin-row').length > 0,
    null,
    { timeout: 10000 }
  );
  return settings;
}

/** 从磁盘上读回插件的启用状态。 */
async function readPrefs(dir) {
  return JSON.parse(await readFile(join(dir, 'plugins.json'), 'utf8').catch(() => '{}'));
}

test.describe('设置页的插件抽屉', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('点一行，右边滑出抽屉，里面是那个插件的详情', async () => {
    const app = await launch(USER_DATA);
    try {
      const settings = await openPluginSection(app);

      // 抽屉一开始是收着的。
      expect(await settings.isVisible('#pluginDrawer'), '抽屉一开始就在').toBe(false);

      // 点「天气」那一行（按名字找，不靠行号）。
      const row = settings.locator('#pluginList .plugin-row', { hasText: '天气' }).first();
      await row.click();

      await settings.waitForSelector('#pluginDrawer:not([hidden])', { timeout: 5000 });
      expect(await settings.textContent('#pluginDrawerName')).toContain('天气');
      expect(await settings.textContent('#pluginDrawerId')).toBe('weather');
      // 介绍是清单里写的介绍。
      const desc = await settings.textContent('#pluginDrawerDesc');
      expect(desc.length, '抽屉里没有介绍').toBeGreaterThan(0);

      // 抽屉在**右边**。
      const box = await settings.locator('#pluginDrawer').boundingBox();
      const win = await settings.locator('body').boundingBox();
      expect(box.x + box.width, '抽屉没贴在右边').toBeGreaterThan(win.width - 2);

      // Esc 收起来。
      await settings.keyboard.press('Escape');
      await settings.waitForSelector('#pluginDrawer', { state: 'hidden', timeout: 5000 });
    } finally {
      await app.close();
    }
  });

  test('列表行没有开关：点它只是打开抽屉', async () => {
    const userData = join(USER_DATA, 'checkbox');
    await rm(userData, { recursive: true, force: true });
    const app = await launch(userData);
    try {
      const settings = await openPluginSection(app);

      // 行上不该有任何控件——启用与注册都在抽屉里拨。
      expect(await settings.locator('#pluginList .plugin-row input, #pluginList .plugin-row button').count(), '行上还有控件').toBe(0);

      const row = settings.locator('#pluginList .plugin-row', { hasText: '天气' }).first();
      await row.click();

      // 点行 = 打开抽屉。
      await settings.waitForSelector('#pluginDrawer:not([hidden])', { timeout: 5000 });
      expect(await settings.textContent('#pluginDrawerName')).toContain('天气');
    } finally {
      await app.close();
    }
  });

  test('抽屉里的「启用」开关：拨了，行上那个「已关闭」标记跟着变', async () => {
    const userData = join(USER_DATA, 'drawer-toggle');
    await rm(userData, { recursive: true, force: true });
    const app = await launch(userData);
    try {
      const settings = await openPluginSection(app);

      const row = settings.locator('#pluginList .plugin-row', { hasText: '天气' }).first();
      await row.click();
      await settings.waitForSelector('#pluginDrawer:not([hidden])', { timeout: 5000 });

      // 关掉它：行上出现「已关闭」，落盘。
      await settings.locator('#pluginDrawerEnabled').click();
      await settings.waitForFunction(
        () => document.querySelector('#pluginList .plugin-row[data-plugin-id="weather"]')?.classList.contains('off'),
        null,
        { timeout: 5000 }
      );
      expect(await settings.locator('#pluginList .plugin-row[data-plugin-id="weather"] .p-state').textContent()).toBe('已关闭');
      let prefs = await readPrefs(userData);
      expect(prefs.disabled || [], '抽屉里的开关没有落盘').toContain('weather');

      // 再拨回来：「已关闭」消失，落盘。
      await settings.locator('#pluginDrawerEnabled').click();
      await settings.waitForFunction(
        () => !document.querySelector('#pluginList .plugin-row[data-plugin-id="weather"]')?.classList.contains('off'),
        null,
        { timeout: 5000 }
      );
      expect(await settings.locator('#pluginList .plugin-row[data-plugin-id="weather"] .p-state').count()).toBe(0);
      prefs = await readPrefs(userData);
      expect(prefs.disabled || [], '插件还关着').not.toContain('weather');
    } finally {
      await app.close();
    }
  });
});
