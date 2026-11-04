// 录屏插件的端到端验证。
//
// 覆盖真实链路：开面板 → 打开录屏 → 开始录制 → 录一会儿 → 停止 → 产出文件。
// 这套用例**需要一块真的屏幕**：抓屏在无显示器的机器上跑不起来。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-recorder');
const OUT_DIR = join(USER_DATA, 'out');

async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: USER_DATA, DESK_PET_E2E: '1' },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/**
 * 在所有窗口里按 URL 找某一个。
 *
 * **不能**用 waitForEvent('window')：桌宠打招呼时会冒出一个气泡窗口，
 * 那个事件可能先到。
 */
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

/** 打开插件面板，找到「录屏」并打开它。 */
async function openRecorder(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  if (!panel) throw new Error('面板窗口没有出现');
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, { timeout: 15000 });
  // 用拼音搜：'luping' 是这个插件独有的关键词，不会搜到别的东西。
  await panel.fill('#query', 'luping');
  await panel.waitForFunction(() => (window.__panel?.resultIds || []).includes('screen-recorder'), null, {
    timeout: 15000,
  });
  await panel.click('#results li:has-text("录屏")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, { timeout: 10000 });
  return panel;
}

/**
 * 点面板里的一个按钮（按文字找）。
 *
 * **用 evaluate 派发 click，不用 Playwright 的 click**：面板失焦就会收起，
 * Playwright 的命中检测会一直重试到超时（见 test/e2e/panel.spec.js 的 clickIn）。
 */
async function clickButton(panel, label) {
  await panel.evaluate((text) => {
    const btn = [...document.querySelectorAll('#plugin-body .block-buttons button')].find((b) =>
      b.textContent.includes(text)
    );
    if (!btn) throw new Error(`面板里没有按钮：${text}`);
    btn.click();
  }, label);
}

/** 勾一个开关（按文字找）。 */
async function toggle(panel, label, checked) {
  await panel.evaluate(
    ({ text, want }) => {
      const row = [...document.querySelectorAll('#plugin-body .block-toggle')].find((l) =>
        l.textContent.includes(text)
      );
      const box = row?.querySelector('input[type="checkbox"]');
      if (!box) throw new Error(`面板里没有开关：${text}`);
      if (box.checked !== want) box.click();
    },
    { text: label, want: checked }
  );
}

/** 改输入框的值并提交。 */
async function setInput(panel, value) {
  await panel.evaluate((text) => {
    const row = document.querySelector('#plugin-body .block-input');
    if (!row) throw new Error('面板里没有输入框');
    row.querySelector('input').value = text;
    row.querySelector('button').click();
  }, value);
}

test.describe('录屏插件', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(OUT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('全屏录制产出 mp4', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      // 输出目录指到临时目录里，别把文件丢进用户的视频文件夹。
      await setInput(panel, OUT_DIR);
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 3000));
      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 2500));

      const files = await readdir(OUT_DIR);
      const mp4 = files.find((f) => f.endsWith('.mp4'));
      expect(mp4, `应该产出 mp4：${files.join('、')}`).toBeTruthy();
      const buffer = await readFile(join(OUT_DIR, mp4));
      // mp4 的第一个 box 是 ftyp：看它就知道文件头是对的。
      expect(buffer.subarray(4, 8).toString('latin1')).toBe('ftyp');
      expect(buffer.length).toBeGreaterThan(1000);
    } finally {
      await app.close();
    }
  });
});
