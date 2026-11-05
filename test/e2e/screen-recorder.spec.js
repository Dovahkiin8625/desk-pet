// 录屏插件的端到端验证。
//
// 覆盖真实链路：开面板 → 打开录屏 → 开始录制 → 录一会儿 → 停止 → 产出文件。
// 这套用例**需要一块真的屏幕**：抓屏在无显示器的机器上跑不起来。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMp4Tracks } from './helpers/mp4.js';

/**
 * 找出目录里**最新**的那个录制文件。
 *
 * 不能拿「第一个」：几条用例共用同一个输出目录，
 * 后一条会读到前一条的文件（实测：选区那条读到了全屏那条的文件，
 * 于是「框的是 499×375，录出来是 2560×1440」——其实录对了，只是拿错了文件）。
 */
async function newestRecording(dir, ext = '.mp4') {
  const names = await readdir(dir);
  const candidates = names.filter((n) => n.endsWith(ext));
  if (!candidates.length) return null;
  const stamped = await Promise.all(
    candidates.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs }))
  );
  stamped.sort((a, b) => b.at - a.at);
  return stamped[0].name;
}

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
  // **一律用 polling（定时器）而不是默认的 requestAnimationFrame**：
  // 面板失焦后会收起，藏起来的页面不再跑 rAF，按 rAF 轮询就永远等不到。
  await panel.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, {
    timeout: 15000,
    polling: 100,
  });
  // 用拼音搜：'luping' 是这个插件独有的关键词，不会搜到别的东西。
  await panel.fill('#query', 'luping');
  await panel.waitForFunction(() => (window.__panel?.resultIds || []).includes('screen-recorder'), null, {
    timeout: 15000,
    polling: 100,
  });
  await panel.click('#results li:has-text("录屏")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, {
    timeout: 10000,
    polling: 100,
  });
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

  test('全屏录制产出 mp4；麦克风可用就录，不可用就说清楚', async () => {
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
      const mp4 = await newestRecording(OUT_DIR);
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
      // 这台机器**有没有**麦克风是不一定的（插着耳机就有），
      // 两种情况都要照顾到：
      //   - 有麦克风 → 录出来的文件要有声音轨；
      //   - 没麦克风 → 状态里要说清楚为什么没声音，不能静默。
      panel = await openRecorder(app, pet);
      await toggle(panel, '麦克风', true);
      await toggle(panel, '扬声器', false);
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 2500));
      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 2500));

      const micFile = await newestRecording(OUT_DIR);
      const micTracks = parseMp4Tracks(await readFile(join(OUT_DIR, micFile))).tracks;
      const hasSound = micTracks.some((t) => t.type === 'soun');

      // 面板收起的时候是不收异步更新的（藏起来的页面不刷新），
      // 所以要重新打开一次才能看到插件留下的提示。
      panel = await openRecorder(app, pet);
      const micStatus = await readStatus(panel);
      expect(
        hasSound || micStatus.includes('麦克风'),
        `要么录到了声音（${JSON.stringify(micTracks)}），要么说清楚为什么没声音：${micStatus}`
      ).toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test('GIF 模式产出 GIF 文件', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      // 参数都自己设一遍：几条用例共用同一个 userData，配置是连着的。
      await clickButton(panel, '全屏');
      await clickButton(panel, 'GIF');
      await setInput(panel, OUT_DIR);
      await clickButton(panel, '开始录制');
      await new Promise((r) => setTimeout(r, 3000));
      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 3000));

      const files = await readdir(OUT_DIR);
      const gif = await newestRecording(OUT_DIR, '.gif');
      const status = await readStatus(panel);
      expect(gif, `应该产出 GIF：${files.join('、')}；插件状态：${status}`).toBeTruthy();

      const buffer = await readFile(join(OUT_DIR, gif));
      expect(buffer.subarray(0, 6).toString('latin1')).toBe('GIF89a');
      expect(buffer[buffer.length - 1]).toBe(0x3b, 'GIF 的结尾标记');
      expect(buffer.length).toBeGreaterThan(1000);
    } finally {
      await closeApp(app);
    }
  });

  test('选区录制：框一块，录出来的就是那一块', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      // 参数都自己设一遍：几条用例共用同一个 userData，配置是连着的。
      await clickButton(panel, '全屏');
      await clickButton(panel, '视频');
      await clickButton(panel, '选区');
      await setInput(panel, OUT_DIR);
      await clickButton(panel, '开始录制');

      // 遮罩应该盖住一块屏幕，等用户在上面拉框。
      const picker = await findWindow(app, 'picker.html');
      expect(picker, '遮罩窗口应该出现').not.toBeNull();
      await picker.waitForLoadState('domcontentloaded');

      await picker.mouse.move(200, 200);
      await picker.mouse.down();
      await picker.mouse.move(600, 500, { steps: 8 });
      await picker.mouse.up();

      // 遮罩上写着选区有多大（物理像素）。
      const label = await picker.textContent('#size');
      const [selWidth, selHeight] = (label || '').match(/(\d+)\s*×\s*(\d+)/)?.slice(1).map(Number) || [];
      expect(selWidth, `遮罩上没写出选区大小：${label}`).toBeGreaterThan(0);

      // 用 evaluate 派发 click：点了之后遮罩立刻就没了，
      // 用 Playwright 的 click 的话，它会等一个已经不存在的窗口。
      await picker.evaluate(() => document.getElementById('ok').click());

      // 遮罩必须在开始录制**之前**关掉：不然那层暗色会被录进画面。
      await new Promise((r) => setTimeout(r, 1500));
      const stillThere = await findWindow(app, 'picker.html');
      expect(stillThere, '遮罩应该已经关掉了').toBeNull();

      await new Promise((r) => setTimeout(r, 2000));
      await clickButton(panel, '停止录制');
      await new Promise((r) => setTimeout(r, 3000));

      const files = await readdir(OUT_DIR);
      const mp4 = await newestRecording(OUT_DIR);
      const status = await readStatus(panel);
      expect(mp4, `应该产出 mp4：${files.join('、')}；插件状态：${status}`).toBeTruthy();

      const { tracks } = parseMp4Tracks(await readFile(join(OUT_DIR, mp4)));
      const video = tracks.find((t) => t.type === 'vide');
      expect(video, '得有一个画面轨').toBeTruthy();
      // 录下来的画面应该和框出来的那块**同一个比例**：
      // 尺寸不一定相等（录制用的是屏幕的原始分辨率），比例对就说明框对了。
      const selected = selWidth / selHeight;
      const recorded = video.width / video.height;
      expect(
        Math.abs(selected - recorded),
        `框的是 ${selWidth}×${selHeight}，录出来是 ${video.width}×${video.height}`
      ).toBeLessThan(0.05);
    } finally {
      await closeApp(app);
    }
  });
});
