// 录屏插件的端到端验证。
//
// 覆盖真实链路：开面板 → 打开录屏 → 开始录制 → 录一会儿 → 停止 → 产出文件。
// 这套用例**需要一块真的屏幕**：抓屏在无显示器的机器上跑不起来。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMp4Tracks } from './helpers/mp4.js';

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

/**
 * 读面板上的状态行。
 *
 * 录完一段之后，面板窗口会失焦收起来，这时候问它要东西**可能等不到回话**
 * （Chromium 会把藏起来的页面的渲染进程冻住）。所以这里自己加个时限，
 * 读不到就当没有——状态行只是用来给失败消息补一句说明的。
 */
async function readStatus(panel) {
  return Promise.race([
    panel
      .evaluate(() => document.getElementById('plugin-status')?.textContent || '')
      .catch(() => ''),
    new Promise((resolve) => setTimeout(() => resolve('（状态读不到了）'), 3000)),
  ]);
}

/**
 * 关掉应用。
 *
 * 录完一段之后应用退出会多等一会儿：Windows 的屏幕捕获会话要慢慢松手
 * （实测 17 秒到一百多秒，等够它自己就放开了，不是卡死）。
 * 等 10 秒还不走就**掐掉**：这是测试用的临时实例，用户数据在临时目录里，
 * 留着它只会拖慢后面的用例。
 */
async function closeApp(app) {
  // **等它自己关干净**：只掐掉主进程的话，它的 GPU、音频服务这些子进程
  // 会变成没人管的孤儿，还占着用户数据目录——后面的用例会被它们拖慢。
  await app.close().catch(() => {});
}

test.describe('录屏插件', () => {
  // 这套用例比平常的 UI 用例慢：真机录屏要起应用、等 Live2D、录几秒，
  // 录完应用还要慢慢收尾（Windows 的屏幕捕获会话松手要十几秒）。
  test.setTimeout(300000);

  test.beforeAll(async () => {
    // 上一次跑完的应用可能还占着这个目录（它要慢慢收尾），
    // 删不掉就算了——下面每一步都自己把参数设一遍，不靠目录里的旧配置。
    await rm(USER_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
    await mkdir(OUT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    // 应用还在收尾，文件可能还占着（Windows 上删不掉的文件会一直重试）。
    // 删不掉就算了——这个目录是 gitignore 掉的临时目录，
    // 留着也不碍事；为它把整条用例判成失败才碍事。
    await Promise.race([
      rm(USER_DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  });

  test('全屏录制产出 mp4；没有麦克风时给的是明确提示', async () => {
    // 两段录放在**同一个应用实例**里：每段录完应用都要收尾一会儿
    // （Windows 的屏幕捕获会话松手要十几秒），起两次应用太慢。
    const { app, pet } = await launch();
    try {
      let panel = await openRecorder(app, pet);
      // 参数都自己设一遍：目录里可能还留着上一次的配置。
      await clickButton(panel, '全屏');
      await clickButton(panel, '视频');
      await setInput(panel, OUT_DIR);

      // —— 第一段：默认开着扬声器，系统声音（loopback）得录进去 ——
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 3000));
      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 2500));

      const files = await readdir(OUT_DIR);
      const mp4 = files.find((f) => f.endsWith('.mp4'));
      // 出错时把插件的状态也带上：光说「没有 mp4」根本不知道卡在哪一步。
      const status = await readStatus(panel);
      expect(mp4, `应该产出 mp4：${files.join('、')}；插件状态：${status}`).toBeTruthy();
      const buffer = await readFile(join(OUT_DIR, mp4));
      // mp4 的第一个 box 是 ftyp：看它就知道文件头是对的。
      expect(buffer.subarray(4, 8).toString('latin1')).toBe('ftyp');
      expect(buffer.length).toBeGreaterThan(1000);

      const { tracks } = parseMp4Tracks(buffer);
      const video = tracks.find((t) => t.type === 'vide');
      expect(video, '得有一个画面轨').toBeTruthy();
      expect(video.width).toBeGreaterThan(0);
      expect(video.height).toBeGreaterThan(0);
      expect(
        tracks.some((t) => t.type === 'soun'),
        `得有一个声音轨：${JSON.stringify(tracks)}`
      ).toBe(true);

      // —— 第二段：开麦克风、关扬声器 ——
      // 这台机器没有音频输入设备：正好用来验「拿不到麦克风」这条路。
      // 面板可能已经收起（失焦就收），重新打开一次。
      panel = await openRecorder(app, pet);
      await toggle(panel, '麦克风', true);
      await toggle(panel, '扬声器', false);
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 2500));

      const micStatus = await readStatus(panel);
      expect(micStatus, `状态里应该说清楚为什么没声音：${micStatus}`).toContain('麦克风');

      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      await closeApp(app);
    }
  });
});
