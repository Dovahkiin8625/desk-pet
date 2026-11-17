// 桌宠天气特效。
//
// 天气插件的「桌宠天气效果」：开关与效果选择放在正文里（不在设置抽屉里），
// 每个效果选项带一个小方框预览；点正文里的「预览效果」按钮，桌宠那边盖一层画布演粒子。
// 这里钉两件事：
//   1. 「桌宠天气效果」开关与效果选项（带小方框预览）出现在正文里，改完落盘；
//   2. 点「预览效果」后 window.__pet.weatherEffect 记下正在播的效果——
//      选「下雪」时播的就是下雪。
import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-weather-effect');

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

/** 打开面板并走到天气插件的页面。 */
async function openWeatherPage(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  await panel.fill('#query', '天气');
  await panel.waitForFunction(
    () => window.__panel?.resultIds?.includes('weather'),
    null,
    { timeout: 15000, polling: 200 }
  );
  await panel.click('#results li[data-plugin-id="weather"]');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'weather', null, {
    timeout: 15000,
    polling: 200,
  });
  return panel;
}

test.describe('桌宠天气特效', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });
  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('正文里有开关与带小方框预览的效果选项；改完落盘；点预览桌宠会播', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openWeatherPage(app, pet);
      // 「查一下天气」按钮在正文里。
      const refresh = panel.locator('.block-buttons button', { hasText: '查一下天气' });
      await expect(refresh).toBeVisible();

      // 效果选择器底部有满宽的「预览」按钮。
      const effects0 = panel.locator('.block-effects');
      await expect(effects0).toBeVisible();
      const preview = effects0.locator('.effects-preview');
      await expect(preview).toBeVisible();
      await expect(preview).toHaveText(/预览/);

      // 先点一次预览：默认「自动」——具体哪种按当时的天气/季节，只要桌宠上播了。
      await preview.click();
      await pet.waitForFunction(() => window.__pet?.weatherEffect?.active === true, null, {
        timeout: 5000,
      });
      const auto = await pet.evaluate(() => window.__pet.weatherEffect);
      expect(['rain', 'wind', 'snow', 'sun', 'leaves']).toContain(auto.name);

      // 正文里有「桌宠天气效果」区：开关 + 六个效果选项，每个选项带小方框预览画布。
      const effects = effects0;
      const toggle = effects.locator('.effects-toggle input[type="checkbox"]');
      await expect(toggle).toBeVisible();
      const options = effects.locator('.effect-option');
      await expect(options).toHaveCount(6);
      await expect(effects.locator('.effect-preview')).toHaveCount(6);
      // 设置抽屉里**不该**再有这两项（它们归正文管）。
      await panel.click('#settings');
      await expect(panel.locator('.dp-drawer')).toHaveClass(/open/);
      const drawerKeys = await panel.evaluate(() =>
        [...document.querySelectorAll('.dp-drawer-body .block-settings .config-row')].map(
          (row) => row.dataset.settingKey
        )
      );
      expect(drawerKeys).not.toContain('effectEnabled');
      expect(drawerKeys).not.toContain('effect');
      await panel.click('#settings');

      // 选「下雪」：选项落盘 + 选中态换过去。
      await effects.locator('.effect-option[data-value="下雪"]').click();
      await expect(effects.locator('.effect-option[data-value="下雪"]')).toHaveClass(/selected/);
      const effectChoice = await readChoice('weather', 'effect');
      expect(effectChoice, '「效果」选择没有落盘').toBe('下雪');

      // 等「下雪」那次重渲染彻底落定，再点开关（否则点击可能落在被换掉的旧节点上）。
      await panel.waitForTimeout(400);

      // 打开「桌宠天气效果」开关 → 落盘到 plugins.json。
      await toggle.check();
      const enabled = await readChoice('weather', 'effectEnabled');
      expect(enabled, '「桌宠天气效果」开关没有落盘').toBe(true);

      // 再点预览 → 播的就是下雪。
      await preview.click();
      await pet.waitForFunction(() => window.__pet?.weatherEffect?.name === 'snow', null, {
        timeout: 5000,
      });
      const plays = await pet.evaluate(() => window.__pet.weatherEffect.plays);
      expect(plays).toBeGreaterThanOrEqual(2);
    } finally {
      await app.close();
    }
  });
});

/** 轮询 plugins.json，直到某个插件的某个配置项落盘成期望的值为止。 */
async function readChoice(pluginId, key) {
  const deadline = Date.now() + 10000;
  let value = null;
  while (Date.now() < deadline) {
    const raw = await readFile(join(USER_DATA, 'plugins.json'), 'utf8').catch(() => '{}');
    value = JSON.parse(raw)?.config?.[pluginId]?.[key] ?? null;
    if (value !== null && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
  return value;
}
