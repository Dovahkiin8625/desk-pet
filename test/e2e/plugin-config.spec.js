// 插件自己的配置。
//
// 配置归插件自己的页面管：声明了配置项的插件，它的页面上有那些控件，
// 桌宠的【设置】里没有。这里钉两件事：
//   1. 配置控件出现在**插件自己的页面**上；
//   2. 改完的值落盘（plugins.json 的 config 段），重开还在。
import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-plugin-config');

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
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开设置窗口并切到插件分区。 */
async function openPlugins(app, pet) {
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  await settings.click('#tab-plugins');
  await settings.waitForFunction(
    () => document.querySelectorAll('#pluginList .plugin-row').length > 0,
    null,
    { timeout: 15000 }
  );
  return settings;
}

/** 打开面板并走到某个插件的页面。 */
async function openPluginPage(app, pet, keyword, pluginId) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  await panel.fill('#query', keyword);
  await panel.waitForFunction(
    `window.__panel?.resultIds?.includes(${JSON.stringify(pluginId)})`,
    null,
    { timeout: 15000, polling: 200 }
  );
  await panel.click(`#results li[data-plugin-id="${pluginId}"]`);
  await panel.waitForFunction(
    `window.__panel?.pluginId === ${JSON.stringify(pluginId)}`,
    null,
    { timeout: 15000, polling: 200 }
  );
  return panel;
}

/** 从磁盘上读回插件的启用状态与配置。 */
async function readPluginPrefs() {
  const raw = await readFile(join(USER_DATA, 'plugins.json'), 'utf8').catch(() => '{}');
  return JSON.parse(raw);
}

test.describe('插件自己的配置', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('配置控件在插件自己的页面上；改完落盘', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPluginPage(app, pet, '番茄钟', 'pomodoro');

      // 番茄钟声明了两个时长：默认 25 与 5。
      const values = await panel.evaluate(() =>
        [...document.querySelectorAll('#plugin-body .block-settings .config-row')].map((row) => [
          row.dataset.settingKey,
          row.querySelector('input,select').value,
        ])
      );
      expect(values, '番茄钟的配置控件没画在它的页面上').toEqual([
        ['focusMinutes', '25'],
        ['breakMinutes', '5'],
      ]);

      // 改成 45 分钟。
      await panel.evaluate(() => {
        const input = document.querySelector(
          '#plugin-body .block-settings .config-row[data-setting-key="focusMinutes"] input'
        );
        input.value = '45';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // 落盘：值在 plugins.json 的 config 段里。
      const deadline = Date.now() + 10000;
      let config = null;
      while (Date.now() < deadline && !config) {
        const prefs = await readPluginPrefs();
        config = prefs?.config?.pomodoro?.focusMinutes ?? null;
        if (config === null) await new Promise((r) => setTimeout(r, 150));
      }
      expect(config, '改完的时长没有落盘').toBe(45);
    } finally {
      await app.close();
    }
  });

  test('桌宠的【设置】里没有插件的配置', async () => {
    const { app, pet } = await launch();
    try {
      const settings = await openPlugins(app, pet);
      const count = await settings.evaluate(
        () => document.querySelectorAll('#pluginList .plugin-config, #pluginList .config-row').length
      );
      expect(count, '插件的配置不该出现在桌宠的设置里').toBe(0);
    } finally {
      await app.close();
    }
  });

  test('【设置】里能开关插件注册到 agent', async () => {
    const { app, pet } = await launch();
    try {
      const settings = await openPlugins(app, pet);
      const row = settings.locator('#pluginList .plugin-row[data-plugin-id="pomodoro"]');
      const agentBox = row.locator('.p-agent input');
      await expect(agentBox, '有工具的插件该有「注册到 agent」开关').toBeChecked();

      // 默认是接给 agent 的：工具表里能看到它的工具。
      const before = await settings.evaluate(() => window.pet.listAgentTools());
      expect(before.map((t) => t.name)).toContain('pomodoro.start');

      // 关掉：工具从表里摘掉，状态落盘。
      await agentBox.uncheck();
      await settings.waitForFunction(
        () => !document.querySelector('#pluginList .plugin-row[data-plugin-id="pomodoro"] .p-agent input')
          ?.checked,
        null,
        { timeout: 10000, polling: 200 }
      );
      const after = await settings.evaluate(() => window.pet.listAgentTools());
      expect(after.map((t) => t.name)).not.toContain('pomodoro.start');

      const deadline = Date.now() + 10000;
      let prefs = null;
      while (Date.now() < deadline) {
        prefs = await readPluginPrefs();
        if (prefs?.agentDisabled?.includes('pomodoro')) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(prefs?.agentDisabled, '开关状态没有落盘').toContain('pomodoro');

      // 再打开：工具回来。
      await agentBox.check();
      await settings.waitForFunction(
        () => document.querySelector('#pluginList .plugin-row[data-plugin-id="pomodoro"] .p-agent input')
          ?.checked,
        null,
        { timeout: 10000, polling: 200 }
      );
      const back = await settings.evaluate(() => window.pet.listAgentTools());
      expect(back.map((t) => t.name)).toContain('pomodoro.start');
    } finally {
      await app.close();
    }
  });

  test('【设置】的工具页按插件分组，内置单独一组', async () => {
    const { app, pet } = await launch();
    try {
      const settings = await openPlugins(app, pet);
      await settings.click('#tab-chat');
      await settings.waitForSelector('#panel-chat:not([hidden])', { timeout: 10000 });
      await settings.click('#chat-tab-tools');
      await settings.waitForSelector('#chat-sub-tools:not([hidden])', { timeout: 10000 });

      // 分组下拉框：全部分组 + 内置 + 每个插件。
      const options = await settings.$$eval('#toolGroup option', (list) =>
        list.map((o) => ({ value: o.value, label: o.textContent }))
      );
      expect(options[0].value, '第一个选项该是「全部分组」').toBe('');
      expect(options.map((o) => o.value)).toContain('builtin');
      expect(options.map((o) => o.value)).toContain('plugin:pomodoro');

      // 分组标题：内置一组，插件各一组（插件用自己的名字，不暴露 id）。
      const titles = await settings.$$eval('#toolGroups .tool-group-title', (list) =>
        list.map((h) => h.textContent)
      );
      expect(titles, '没有内置这一组').toContain('内置');
      expect(titles, '没有插件这一组').toContain('番茄钟');

      // 筛到内置那一组：只剩内置的工具。
      await settings.selectOption('#toolGroup', 'builtin');
      const names = await settings.$$eval('#toolGroups li[data-tool-name]', (list) =>
        list.map((li) => li.dataset.toolName)
      );
      expect(names.length, '内置组是空的').toBeGreaterThan(0);
      expect(names.join(' '), '筛选后混进了别的组的工具').not.toContain('pomodoro.');

      // 筛到插件那一组：只剩那个插件的工具。
      await settings.selectOption('#toolGroup', 'plugin:pomodoro');
      const pluginNames = await settings.$$eval('#toolGroups li[data-tool-name]', (list) =>
        list.map((li) => li.dataset.toolName)
      );
      expect(pluginNames.length, '插件组是空的').toBeGreaterThan(0);
      for (const name of pluginNames) {
        expect(name, '插件组里混进了别的工具').toContain('pomodoro.');
      }
    } finally {
      await app.close();
    }
  });
});
