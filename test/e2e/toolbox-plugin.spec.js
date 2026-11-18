// 工具箱插件的端到端验证。
//
// 工具都在 iframe 页面里实时算（不碰大模型、不碰网络），
// 盯的是整条链：面板里搜到「工具箱」→ 打开 → 五个工具都能真的算出来。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-toolbox');

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
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开插件面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  if (!panel) throw new Error('面板窗口没有出现');
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => window.__panel?.ready === true, null, {
    timeout: 15000,
  });
  return panel;
}

test.beforeEach(async () => {
  await rm(USER_DATA, { recursive: true, force: true });
});

test.afterEach(async () => {
  await rm(USER_DATA, { recursive: true, force: true });
});

test('搜到工具箱并打开：五个选项卡，JSON 格式化，正则与 Token 实时算', async () => {
  const { app, pet } = await launch();
  try {
    const panel = await openPanel(app, pet);

    // 搜索「工具箱」，结果里点开插件。
    await panel.evaluate(() => {
      const input = document.getElementById('query');
      input.value = '工具箱';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await panel.waitForFunction(() => window.__panel?.resultIds?.includes('toolbox') === true, null, {
      timeout: 10000,
    });
    await panel.evaluate(() => {
      const row = [...document.querySelectorAll('#results li')].find((li) =>
        li.textContent.includes('工具箱')
      );
      if (!row) throw new Error('找不到「工具箱」那一行');
      row.click();
    });
    await panel.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 10000 });

    const frame = () => panel.frameLocator('#plugin-frame');
    await expect(frame().locator('.tab')).toHaveCount(6);

    // JSON：格式化后输入框里是缩进好的文本。
    await frame().locator('#jsonInput').fill('{"b":1,"a":[1,2]}');
    await frame().locator('#jsonFormat').click();
    await expect(frame().locator('#jsonInput')).toHaveValue('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}');
    await expect(frame().locator('#jsonStatus')).toContainText('对象');

    // Token：实时统计（防抖 120ms，toContainText 会轮询等）。
    await frame().locator('.tab[data-tool="token"]').click();
    await frame().locator('#tokenInput').fill('你好世界 hello world');
    await expect.poll(
      async () => frame().locator('#stTokens').textContent(),
      { timeout: 5000 }
    ).not.toBe('0');

    // 正则：2 处匹配。
    await frame().locator('.tab[data-tool="regex"]').click();
    await frame().locator('#regexPattern').fill('\\d+');
    await frame().locator('#regexText').fill('a12b345');
    await expect(frame().locator('#regexStatus')).toContainText('2 处匹配', { timeout: 5000 });

    // 时间戳：秒自动认成秒，出结果行。
    await frame().locator('.tab[data-tool="time"]').click();
    await frame().locator('#tsInput').fill('1730000000');
    await expect(frame().locator('#tsResult')).toBeVisible({ timeout: 5000 });
    await expect(frame().locator('#timeStatus')).toContainText('秒');

    // 编解码：Base64 编码，再换成原文验解码。
    await frame().locator('.tab[data-tool="codec"]').click();
    await frame().locator('#codecInput').fill('你好');
    await frame().locator('[data-codec="base64Encode"]').click();
    await expect(frame().locator('#codecOutput')).toHaveValue('5L2g5aW9');
    await frame().locator('#codecInput').fill('5L2g5aW9');
    await frame().locator('[data-codec="base64Decode"]').click();
    await expect(frame().locator('#codecOutput')).toHaveValue('你好');

    // 颜色：输一个 HEX，RGB 那行跟着换。
    await frame().locator('.tab[data-tool="color"]').click();
    await expect(frame().locator('#hexInput')).toHaveValue('#4f8cff');
    await frame().locator('#hexInput').fill('#ff0000');
    await expect(frame().locator('#rgbValue')).toContainText('rgb(255, 0, 0)');
    await expect(frame().locator('#hslValue')).toContainText('hsl(0, 100%, 50%)');
  } finally {
    await app.close();
  }
});
