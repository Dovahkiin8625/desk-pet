// 录屏插件的端到端验证。
//
// 覆盖真实链路：开面板 → 打开录屏 → 开始录制 → 录一会儿 → 停止 → 产出文件。
// 这套用例**需要一块真的屏幕**：抓屏在无显示器的机器上跑不起来。
//
// 录屏现在有**自己的页面**（plugins/screen-recorder/pages/studio.html），
// 面板工作台里它装在 iframe 中——所以下面大部分操作都发生在 iframe 里
// （frame），不在面板的 DOM 里。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

/** 插件自己的页面（面板工作台里的那个 iframe）。 */
function studio(panel) {
  return panel.frameLocator('#plugin-frame');
}

/**
 * 点插件页面里的一个元素。
 *
 * 用 evaluate 派发 click，不用 Playwright 的 click：面板失焦就会收起，
 * Playwright 的命中检测会一直重试到超时（见 test/e2e/panel.spec.js 的 clickIn）。
 */
async function clickStudio(frame, selector) {
  await frame.locator(selector).evaluate((el) => el.click());
}

/** 等插件页面拿到主进程给的第一份数据。 */
async function waitStudioReady(frame) {
  await frame.locator('.studio').evaluate(
    () =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.__studio?.state) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - started > 20000) {
            clearInterval(timer);
            reject(new Error('插件页面没拿到数据'));
          }
        }, 100);
      })
  );
}

/** 读插件页面底部那行状态。 */
async function studioStatus(frame) {
  return frame.locator('#statusText').textContent().catch(() => '');
}

/** 改插件页面里的一个输入框，并触发它的 change。 */
async function setStudioInput(frame, selector, value) {
  await frame.locator(selector).evaluate(
    (el, next) => {
      // 先聚焦：页面重画时不会覆盖**正在输入**的框（见 studio.js 的 renderDrawer）。
      el.focus();
      el.value = next;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
}

/** 选一个下拉框的选项。 */
async function selectStudio(frame, selector, value) {
  await frame.locator(selector).evaluate(
    (el, next) => {
      el.value = next;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
}

/**
 * 设好输出目录。
 *
 * 输出目录在**设置抽屉**里（主页面没有——这是有意的），
 * 所以要先点开右上角的齿轮。
 */
async function setOutputDir(frame, dir) {
  await clickStudio(frame, '#gearBtn');
  await frame.locator('#outputDir').evaluate(
    (el, value) => {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    dir
  );
  // 等配置真的存下来了（写盘是异步的）。
  //
  // **locator.evaluate 的第一个参数是元素**，自己传的值是第二个——
  // 写反了的话，拿到的是元素而不是路径，等一辈子也等不到。
  await frame.locator('.studio').evaluate(
    (_el, value) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.__studio?.state?.outputDir === value) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - started > 15000) {
            clearInterval(timer);
            reject(new Error('输出目录没存上'));
          }
        }, 100);
      }),
    dir
  );
}

/** 切到某个 tab（本地切换，不等主进程）。 */
async function switchTab(frame, mode) {
  await clickStudio(frame, `.tab[data-mode="${mode}"]`);
  await frame.locator(`.pane[data-pane="${mode}"]`).evaluate((el) => {
    if (el.hidden) throw new Error(`tab 没切到 ${mode}`);
  });
}

/** 等录制按钮变成「停止录制」。 */
async function waitRecording(frame) {
  await frame.locator('#recordBtn').evaluate(
    () =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (document.getElementById('recordBtn')?.textContent.includes('停止')) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - started > 15000) {
            clearInterval(timer);
            reject(new Error('录制没开始'));
          }
        }, 100);
      })
  );
}

/** 进程还在吗。 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程在，只是我们没权限动它（当它还在）。
    return err?.code === 'EPERM';
  }
}

/** 等进程真的没了（最多等 timeout 毫秒）。 */
async function waitProcessGone(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !processAlive(pid);
}

/**
 * 关掉应用。
 *
 * 正常情况下几秒就关掉了。万一卡住（Windows 的屏幕捕获会话收尾有时候很慢），
 * 等 20 秒还不走，就把**这棵树**掐掉：只掐主进程的话，它的 GPU、音频服务
 * 这些子进程会变成没人管的孤儿，还占着用户数据目录，把后面的用例拖慢。
 *
 * 还要**确认进程真的没了**：用例之间共用同一个 userData 目录，
 * 上一个用例的进程要是还活着，它既占着全局快捷键（下一条用例注册不上），
 * 又能往那个目录里写东西（把下一条用例刚写好的配置改掉）。
 * 所以窗口关掉之后还要等它退出；等不出来就掐掉整棵树。
 */
async function closeApp(app) {
  const pid = app.process().pid;
  const closed = await Promise.race([
    app.close().then(() => true).catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 20000)),
  ]);
  // 窗口关掉了，还要确认**进程**真的没了：
  // 用例之间共用同一个 userData 目录，上一个用例的进程要是还活着，
  // 它既占着全局快捷键（下一条用例注册不上），
  // 又能往那个目录里写东西（把下一条用例刚写好的配置改掉）。
  if (closed && (await waitProcessGone(pid, 5000))) return;
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    app.process().kill();
  }
  await waitProcessGone(pid, 5000);
}

/**
 * 解开录下来的文件，看某一时刻的画面是不是「有内容」。
 *
 * **为什么在浏览器里解**：坏掉的那种文件（录到一半画面改了尺寸）
 * 用 ffmpeg 解是一堆报错，而测试机上不一定装了 ffmpeg；
 * 浏览器自带解码器，它解不出来的时候画面就是一片死灰——
 * 正好就是要断言的那个现象。
 *
 * 判据是**画面的起伏**（标准差）：一块纯色的画面起伏是 0，
 * 有内容的画面起伏明显。坏掉的文件解出来是一整块死灰，起伏接近 0。
 *
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {string} file 录出来的文件
 * @param {number} [atRatio] 看整段里的哪一处（0～1）
 * @returns {Promise<{ok:boolean,mean?:number,std?:number,why?:string}>}
 */
async function probeFrame(app, file, atRatio = 0.85) {
  // 探针页面要跟视频**在同一个目录**：页面的源是 file://，
  // 视频也得是 file://，否则浏览器不让放（连 canvas 都会被污染）。
  const probe = join(OUT_DIR, 'probe.html');
  await writeFile(
    probe,
    '<!doctype html><meta charset="utf-8">' +
      '<video id="v" muted></video><canvas id="c" width="64" height="64"></canvas>',
    'utf8'
  );
  return app.evaluate(
    async ({ BrowserWindow }, { probePath, url, atRatio }) => {
      const win = new BrowserWindow({ show: false });
      try {
        await win.loadFile(probePath);
        return await win.webContents.executeJavaScript(
        `(async () => {
          const v = document.getElementById('v');
          const c = document.getElementById('c');
          const ctx = c.getContext('2d', { willReadFrequently: true });
          const fail = (why) => ({ ok: false, why });
          v.src = ${JSON.stringify(url)};
          const meta = await new Promise((res) => {
            v.onloadedmetadata = () => res({ ok: true });
            v.onerror = () => res(fail('解码失败（错误码 ' + (v.error && v.error.code) + '）'));
            setTimeout(() => res(fail('等不到元数据')), 10000);
          });
          if (!meta.ok) return meta;
          const seek = await new Promise((res) => {
            v.onseeked = () => res({ ok: true });
            v.onerror = () => res(fail('跳不过去'));
            v.currentTime = v.duration * ${atRatio};
            setTimeout(() => res(fail('等不到那一帧')), 10000);
          });
          if (!seek.ok) return seek;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          let sumSq = 0;
          for (let i = 0; i < d.length; i += 4) {
            const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            sum += l;
            sumSq += l * l;
          }
          const n = d.length / 4;
          const mean = sum / n;
          return {
            ok: true,
            width: v.videoWidth,
            height: v.videoHeight,
            mean: Math.round(mean),
            std: Math.round(Math.sqrt(Math.max(0, sumSq / n - mean * mean))),
          };
        })()`
        );
      } finally {
        win.destroy();
      }
    },
    { probePath: probe, url: pathToFileURL(file).href, atRatio }
  );
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

  test('界面：三个 tab、设置在抽屉里、主页面没有输出目录', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);

      // 三个 tab 都在。
      const tabs = await frame.locator('.tab').evaluateAll((els) => els.map((e) => e.dataset.mode));
      expect(tabs).toEqual(['screen', 'region', 'window']);

      // 设置是**右上角的一张图**（不是一行字）。
      expect(await frame.locator('#gearBtn img').count(), '设置按钮应该是一张图').toBeGreaterThan(0);

      // 抽屉默认是关着的。
      expect(await frame.locator('#drawer').evaluate((el) => el.hidden)).toBe(true);

      // 输出目录**只在抽屉里**：主页面上没有这个输入框。
      const onMainPage = await frame
        .locator('.studio-body')
        .evaluate((body) => Boolean(body.querySelector('#outputDir')));
      expect(onMainPage, '主页面不该有输出目录').toBe(false);

      // 点齿轮 → 抽屉滑出来，里面有输出目录与两个快捷键。
      await clickStudio(frame, '#gearBtn');
      await frame.locator('#drawer').evaluate((el) => {
        if (el.hidden) throw new Error('抽屉没打开');
      });
      expect(await frame.locator('#outputDir').count()).toBe(1);
      expect(await frame.locator('#hotkeyStart').count()).toBe(1);
      expect(await frame.locator('#hotkeyStop').count()).toBe(1);
    } finally {
      await closeApp(app);
    }
  });

  test('设置抽屉：按功能分三块（存放位置 / 快捷键 / 录制质量）', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);

      await clickStudio(frame, '#gearBtn');
      await frame.locator('#drawer').evaluate((el) => {
        if (el.hidden) throw new Error('抽屉没打开');
      });

      // 三块，标题就是那三件事。
      const titles = await frame
        .locator('#drawer .set-group .dp-section-title')
        .evaluateAll((els) => els.map((e) => e.textContent.trim()));
      expect(titles, '抽屉里应该有存放位置、快捷键、录制质量三块').toEqual([
        '存放位置',
        '快捷键',
        '录制质量',
      ]);

      // 第一块：存放位置 + 打开输出文件夹。
      const outputBlock = frame.locator('#drawer .set-group').first();
      expect(await outputBlock.locator('#outputDir').count()).toBe(1);
      expect(await outputBlock.locator('#openDir').count()).toBe(1);
      // 目录没设时要说清楚会存到哪儿（系统的视频文件夹）。
      const hint = await outputBlock.locator('#outputDirHint').innerText();
      expect(hint, '要告诉用户没设目录时存到哪儿').toMatch(/视频文件夹/);

      // 第二块：两个快捷键，各带一个「改」。
      const hotkeyBlock = frame.locator('#drawer .set-group').nth(1);
      expect(await hotkeyBlock.locator('#hotkeyStart').count()).toBe(1);
      expect(await hotkeyBlock.locator('#hotkeyStop').count()).toBe(1);
      expect(await hotkeyBlock.locator('#recordStartKey').count()).toBe(1);
      expect(await hotkeyBlock.locator('#recordStopKey').count()).toBe(1);
      // 键帽上显示的是人看的写法（Ctrl），不是 Electron 的写法（Control）。
      const keyText = await frame.locator('#hotkeyStart').innerText();
      expect(keyText, '快捷键应该显示成 Ctrl + Shift + R').toBe('Ctrl + Shift + R');

      // 第三块：录制质量。视频与 GIF 分开两块，当前格式的那块标「当前」。
      const qualityBlock = frame.locator('#drawer .set-group').nth(2);
      expect(await qualityBlock.locator('#fps').count()).toBe(1);
      expect(await qualityBlock.locator('#gifWidth').count()).toBe(1);
      expect(await qualityBlock.locator('#gifFps').count()).toBe(1);
      const active = await frame
        .locator('#drawer .q-block')
        .evaluateAll((els) => els.map((e) => e.dataset.active));
      expect(active, '默认是视频：视频那块该是当前的').toEqual(['true', 'false']);
      expect(await frame.locator('#qVideoTag').innerText()).toBe('当前');
      expect(await frame.locator('#qGifTag').innerText()).toBe('当前不用');

      // 刷新是动作，不在设置里：它在顶栏上。
      expect(await frame.locator('#drawer #refreshBtn').count(), '刷新不该在抽屉里').toBe(0);
      expect(await frame.locator('.studio-bar #refreshBtn').count(), '刷新应该在顶栏上').toBe(1);
    } finally {
      await closeApp(app);
    }
  });

  test('面板工作台里显示得全：底部没有被窗口裁掉', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);
      // 等预览图上屏：图片一到位，页面内容的高度就变了，
      // 面板要跟着把窗口撑开——这一步是「显示得全」的关键。
      await new Promise((r) => setTimeout(r, 2500));

      // 面板窗口（主进程那边量到的实际高度）。
      const bounds = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/renderer/panel/index.html')
        );
        return win?.getBounds() || null;
      });
      expect(bounds, '拿不到面板窗口').toBeTruthy();

      // iframe 的下沿要在窗口里面：
      // 以前 iframe 按内容摆、窗口却有上限，超出的那一截被窗口裁掉，
      // 底部的按钮看得见却点不到。
      const frameBox = await panel.evaluate(() => {
        const el = document.getElementById('plugin-frame');
        const r = el.getBoundingClientRect();
        return { bottom: r.bottom, height: r.height, viewHeight: window.innerHeight };
      });
      expect(
        frameBox.bottom,
        `iframe 的下沿 ${frameBox.bottom} 超出了窗口（${frameBox.viewHeight}）`
      ).toBeLessThanOrEqual(frameBox.viewHeight + 1);

      // 页面底部够得着：滚到底之后，状态栏整个在可视区里。
      await frame.locator('.studio').evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      const footVisible = await frame.locator('.studio-foot').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom <= window.innerHeight + 1 && r.top >= -1;
      });
      expect(footVisible, '页面底部的状态栏够不着（被裁掉了）').toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test('切 tab 不卡：切换是本地做的，不等主进程', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);

      // 切到窗口再切回来，量一量**本地切换**花了多久：
      // 切 tab 只是改几个元素的 hidden 属性，不该过一次 IPC。
      const ms = await frame.locator('.tab[data-mode="window"]').evaluate((el) => {
        const started = performance.now();
        el.click();
        const shown = !document.querySelector('.pane[data-pane="window"]').hidden;
        return { ms: performance.now() - started, shown };
      });
      expect(ms.shown, '点了就该换过去').toBe(true);
      expect(ms.ms, `切 tab 花了 ${ms.ms.toFixed(1)}ms`).toBeLessThan(100);

      const back = await frame.locator('.tab[data-mode="screen"]').evaluate((el) => {
        const started = performance.now();
        el.click();
        const shown = !document.querySelector('.pane[data-pane="screen"]').hidden;
        return { ms: performance.now() - started, shown };
      });
      expect(back.shown).toBe(true);
      expect(back.ms, `切回来花了 ${back.ms.toFixed(1)}ms`).toBeLessThan(100);
    } finally {
      await closeApp(app);
    }
  });

  test('全屏：每块屏都画预览图，点一下就选中', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);

      // 每块屏一张卡片，每张都带预览图。
      const cards = await frame.locator('.screen-card').evaluateAll((els) =>
        els.map((el) => ({
          id: el.dataset.id,
          label: el.querySelector('.label')?.textContent || '',
          meta: el.querySelector('.meta')?.textContent || '',
          active: el.classList.contains('active'),
          hasImage: Boolean(el.querySelector('img')?.getAttribute('src')),
        }))
      );
      expect(cards.length, '一块屏都该有卡片').toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.hasImage, `${card.label} 该有预览图`).toBe(true);
        expect(card.meta, `${card.label} 该标出分辨率`).toMatch(/\d+×\d+/);
        expect(card.label, '卡片该有名字').not.toBe('');
      }
      // **一定要有一块是选中的**：第一次用时配置里还没存过，
      // 全是灰的看不出现在录的是哪块。
      expect(cards.filter((c) => c.active).length, '有且只有一块是选中的').toBe(1);

      if (cards.length > 1) {
        const other = cards.find((c) => !c.active);
        // 点一下就换选中——**不等主进程**（等一次往返就是一次卡顿）。
        const started = Date.now();
        await clickStudio(frame, `.screen-card[data-id="${other.id}"]`);
        const elapsed = Date.now() - started;
        expect(elapsed, `点预览图不该等主进程（花了 ${elapsed}ms）`).toBeLessThan(300);

        const activeId = await frame
          .locator('.screen-card.active')
          .evaluate((el) => el.dataset.id);
        expect(activeId, '选中该换到刚点的那块').toBe(other.id);

        // 存进配置了：配置写在 userData 里，存盘是异步的，等一下。
        const cfgPath = join(USER_DATA, 'screen-recorder.json');
        const deadline = Date.now() + 10000;
        let saved = null;
        while (Date.now() < deadline) {
          try {
            saved = JSON.parse(await readFile(cfgPath, 'utf8'));
            if (saved.sourceId) break;
          } catch {
            /* 还没写出来 */
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(saved?.sourceId, '选中的那块屏该存进配置').toBe(other.id);
      }
    } finally {
      await closeApp(app);
    }
  });

  test('独立窗口里也是同一份界面：预览图与选中状态都在', async () => {
    // 独立窗口走的是**另一个 preload**（src/preload/plugin.cjs），
    // 首份数据是宿主推过来的——推早了、页面还没订阅就得有人补上。
    // 这一条守的就是那条补发路径。
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      await waitStudioReady(studio(panel));

      // 分离成独立窗口
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '录屏的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');

      const winFrame = pluginWin.frameLocator('#plugin-frame');
      // 预览图在独立窗口里也要有（数据到了，图也就到了）。
      await winFrame
        .locator('.screen-card img')
        .first()
        .waitFor({ state: 'visible', timeout: 30000 });
      const cards = await winFrame.locator('.screen-card').evaluateAll((els) =>
        els.map((el) => ({
          label: el.querySelector('.label')?.textContent || '',
          active: el.classList.contains('active'),
          hasImage: Boolean(el.querySelector('img')?.getAttribute('src')),
        }))
      );
      expect(cards.length, '一块屏都该有卡片').toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.hasImage, `${card.label} 该有预览图`).toBe(true);
      }
      expect(cards.filter((c) => c.active).length, '有且只有一块是选中的').toBe(1);
    } finally {
      await closeApp(app);
    }
  });

  test('全屏录制产出 mp4；麦克风可用就录，不可用就说清楚', async () => {
    // 两段录放在**同一个应用实例**里：每段录完应用都要收尾一会儿
    // （Windows 的屏幕捕获会话松手要十几秒），起两次应用太慢。
    const { app, pet } = await launch();
    try {
      let panel = await openRecorder(app, pet);
      let frame = studio(panel);
      await waitStudioReady(frame);
      // 参数都自己设一遍：目录里可能还留着上一次的配置。
      await switchTab(frame, 'screen');
      await clickStudio(frame, '#formatGroup button[data-format="video"]');
      await setOutputDir(frame, OUT_DIR);

      // —— 第一段：默认开着扬声器，系统声音（loopback）得录进去 ——
      await clickStudio(frame, '#recordBtn');
      await waitRecording(frame);
      await new Promise((r) => setTimeout(r, 3000));
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 2500));

      const files = await readdir(OUT_DIR);
      const mp4 = await newestRecording(OUT_DIR);
      // 出错时把插件的状态也带上：光说「没有 mp4」根本不知道卡在哪一步。
      const status = await studioStatus(frame);
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
      frame = studio(panel);
      await waitStudioReady(frame);
      await selectStudio(frame, '#micSelect', '0');
      await selectStudio(frame, '#speakerSelect', 'off');
      await clickStudio(frame, '#recordBtn');
      await waitRecording(frame);
      await new Promise((r) => setTimeout(r, 2500));
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 2500));

      const micFile = await newestRecording(OUT_DIR);
      const micTracks = parseMp4Tracks(await readFile(join(OUT_DIR, micFile))).tracks;
      const hasSound = micTracks.some((t) => t.type === 'soun');

      const micStatus = await studioStatus(frame);
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
      const frame = studio(panel);
      await waitStudioReady(frame);
      // 参数都自己设一遍：几条用例共用同一个 userData，配置是连着的。
      await switchTab(frame, 'screen');
      await clickStudio(frame, '#formatGroup button[data-format="gif"]');
      await setOutputDir(frame, OUT_DIR);
      await clickStudio(frame, '#recordBtn');
      await waitRecording(frame);
      await new Promise((r) => setTimeout(r, 3000));
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 3000));

      const files = await readdir(OUT_DIR);
      const gif = await newestRecording(OUT_DIR, '.gif');
      const status = await studioStatus(frame);
      expect(gif, `应该产出 GIF：${files.join('、')}；插件状态：${status}`).toBeTruthy();

      const buffer = await readFile(join(OUT_DIR, gif));
      expect(buffer.subarray(0, 6).toString('latin1')).toBe('GIF89a');
      expect(buffer[buffer.length - 1]).toBe(0x3b, 'GIF 的结尾标记');
      expect(buffer.length).toBeGreaterThan(1000);
    } finally {
      await closeApp(app);
    }
  });

  test('刚开始就喊停：录制不会卡住，还能再录一次', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);
      await switchTab(frame, 'screen');
      await clickStudio(frame, '#formatGroup button[data-format="video"]');
      await setOutputDir(frame, OUT_DIR);

      await clickStudio(frame, '#recordBtn');
      // 「停止录制」一出现就点：这时捕获页很可能还在取流，
      // 停止会落在「开始」还没走完的那段路上。
      await waitRecording(frame);
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 2000));

      // 应该回到「开始录制」：没卡在「已经在录了」。
      const label = await frame.locator('#recordBtn').textContent();
      expect(label, '录了又停之后应该还能再录').toContain('开始录制');

      // 而且真的还能再录一段。
      await clickStudio(frame, '#recordBtn');
      await waitRecording(frame);
      await new Promise((r) => setTimeout(r, 2500));
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 3000));
      expect(await newestRecording(OUT_DIR), '第二段应该存下来了').toBeTruthy();
    } finally {
      await closeApp(app);
    }
  });

  test('快捷键：打开过录屏就一直有效，面板收起来也不注销', async () => {
    const { app, pet } = await launch();
    try {
      // **这个键有可能被这台机器上的另一个程序占着**：全局快捷键是
      // 系统级的，用户自己开着桌宠时它就占着（录屏插件一打开界面
      // 就注册 Control+Shift+R）。那时候这条用例测不到插件，
      // 只测得到操作系统——先自己抢一下，抢不到就跳过。
      const free = await app.evaluate(({ globalShortcut }) => {
        const ok = globalShortcut.register('Control+Shift+R', () => {});
        if (ok) globalShortcut.unregister('Control+Shift+R');
        return ok;
      });
      test.skip(!free, 'Control+Shift+R 被别的程序占着（多半是用户自己开着桌宠）');

      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);

      // 打开录屏 → 快捷键注册上了（默认 Control+Shift+R）
      await new Promise((r) => setTimeout(r, 800));
      const registered = await app.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Control+Shift+R')
      );
      expect(registered, '打开录屏之后快捷键应该注册着').toBe(true);

      // 面板收起来（失焦自动收起）→ 快捷键**仍然**注册着。
      //
      // 这一条是这次改的关键：以前快捷键跟着「设置窗口」走，
      // 在录屏自己的页面上按不动。面板一收起来就没了的话，
      // 「开始录制」这种快捷键更没有意义——它的用处就是不开界面也能按。
      await panel.evaluate(() => window.panel?.back?.());
      await new Promise((r) => setTimeout(r, 1200));
      const afterHide = await app.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered('Control+Shift+R')
      );
      expect(afterHide, '面板收起来之后快捷键仍然要有效').toBe(true);
    } finally {
      await closeApp(app);
    }
  });

  test('录制时桌面上有控制条：显示时长，点它能停', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);
      await switchTab(frame, 'screen');
      await clickStudio(frame, '#formatGroup button[data-format="video"]');
      await setOutputDir(frame, OUT_DIR);
      await clickStudio(frame, '#recordBtn');

      const control = await findWindow(app, 'control.html');
      expect(control, '控制条应该出现').not.toBeNull();
      await control.waitForLoadState('domcontentloaded');

      // 时钟在走：等它不是 00:00
      await control.waitForFunction(
        () => (document.getElementById('time')?.textContent || '') !== '00:00',
        null,
        { timeout: 15000, polling: 200 }
      );

      // 点控制条上的「停止」→ 录制停下来，文件落盘
      await control.evaluate(() => document.getElementById('stop').click());
      await new Promise((r) => setTimeout(r, 2500));

      const mp4 = await newestRecording(OUT_DIR);
      expect(mp4, '应该产出 mp4').toBeTruthy();
    } finally {
      await closeApp(app);
    }
  });

  test('窗口录制：列出能录的窗口（带图标），选了它就能录', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);
      await switchTab(frame, 'screen');
      await clickStudio(frame, '#formatGroup button[data-format="video"]');
      await setOutputDir(frame, OUT_DIR);

      // 切到窗口模式：应该列出能录的窗口。
      await switchTab(frame, 'window');
      await frame.locator('#windowList li').first().waitFor({ timeout: 15000, polling: 200 });

      // 图标是**后台**取的（要跑一遍 PowerShell 枚举窗口，再读程序图标），
      // 所以刚列出来时可能还没有——等它一会儿。
      await frame
        .locator('#windowList img.win-icon[src^="data:image/"]')
        .first()
        .waitFor({ timeout: 30000, polling: 200 });

      const items = await frame.locator('#windowList li').evaluateAll((els) =>
        els.map((li) => ({
          label: li.querySelector('.label')?.textContent || '',
          icon: li.querySelector('img.win-icon')?.getAttribute('src') || '',
        }))
      );
      expect(items.length, '应该列出能录的窗口').toBeGreaterThan(0);
      // 每个条目都要有图标位：有图标就显示图标，没有就用占位的小方块。
      expect(
        await frame.locator('#windowList img.win-icon').count(),
        '窗口条目应该有图标'
      ).toBe(items.length);
      // 图标是主进程用程序路径读出来的（Windows 上 Electron 给不了 appIcon）。
      const withIcon = items.filter((it) => it.icon.startsWith('data:image/'));
      expect(withIcon.length, `这些窗口该有图标：${JSON.stringify(items.map((i) => i.label))}`).toBeGreaterThan(0);

      // 选第一个窗口，录一段。
      await clickStudio(frame, '#windowList li:first-child');
      await new Promise((r) => setTimeout(r, 500));
      await clickStudio(frame, '#recordBtn');
      await waitRecording(frame);
      await new Promise((r) => setTimeout(r, 2500));
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 3000));

      const mp4 = await newestRecording(OUT_DIR);
      const status = await studioStatus(frame);
      expect(mp4, `应该产出 mp4；插件状态：${status}`).toBeTruthy();
    } finally {
      await closeApp(app);
    }
  });

  test('窗口录制：录制中改了窗口大小，录出来的画面还是好的', async () => {
    // 这条守的是一个真实的坑：窗口一改尺寸，源送来的帧就换了个大小，
    // 而 Chromium 的 MediaRecorder 处理不了「录到一半画面变了尺寸」——
    // 容器里记的还是开头那个分辨率，后面的帧全成了灰的
    //（浏览器里放出来是一整块死灰，ffmpeg 解是一堆报错）。
    //
    // 所以这里自己起一个窗口当靶子：录到一半改它的尺寸，
    // 录完把文件解开看——改尺寸之后那部分还是不是有内容的画面。
    const { app, pet } = await launch();
    try {
      // 靶子窗口：内容要**有花纹**。纯色的画面录出来也是「平的」，
      // 分不清是录坏了还是本来就那样。
      const targetId = await app.evaluate(async ({ BrowserWindow }) => {
        const win = new BrowserWindow({
          width: 480,
          height: 360,
          show: true,
          title: 'E2E-改尺寸的靶子',
        });
        await win.loadURL(
          'data:text/html;charset=utf-8,' +
            encodeURIComponent(
              '<title>E2E-改尺寸的靶子</title>' +
                '<body style="margin:0;background:repeating-linear-gradient(45deg,#e11 0 24px,#11e 24px 48px)">' +
                '<h1 style="font:48px sans-serif;color:#fff">靶子</h1></body>'
            )
        );
        return win.id;
      });

      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);
      await switchTab(frame, 'screen');
      await clickStudio(frame, '#formatGroup button[data-format="video"]');
      await setOutputDir(frame, OUT_DIR);

      // 切到窗口模式，认准我们那个靶子窗口。
      await switchTab(frame, 'window');
      await frame.locator('#windowList li').first().waitFor({ timeout: 15000, polling: 200 });
      const target = frame.locator('#windowList li', { hasText: 'E2E-改尺寸的靶子' }).first();
      await target.waitFor({ timeout: 15000, polling: 200 });
      await target.evaluate((el) => el.click());
      await new Promise((r) => setTimeout(r, 500));

      await clickStudio(frame, '#recordBtn');
      await waitRecording(frame);
      await new Promise((r) => setTimeout(r, 1500));

      // **录到一半改窗口的大小**：坏掉的就是这一下。
      await app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id)?.setBounds({ width: 900, height: 620 });
      }, targetId);

      await new Promise((r) => setTimeout(r, 3000));
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 3000));

      const mp4 = await newestRecording(OUT_DIR);
      const status = await studioStatus(frame);
      expect(mp4, `应该产出 mp4；插件状态：${status}`).toBeTruthy();

      // 解开看：改尺寸之后录进去的还是不是有内容的画面。
      const probe = await probeFrame(app, join(OUT_DIR, mp4));
      expect(probe.ok, `录出来的文件解不开：${probe.why}`).toBe(true);
      expect(
        probe.std,
        `改尺寸之后录进去的是一块平的（标准差 ${probe.std}）：${JSON.stringify(probe)}`
      ).toBeGreaterThan(12);
    } finally {
      await closeApp(app);
    }
  });

  test('选区录制：遮罩盖满整块屏（含任务栏），框完的边框留到录完', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      await waitStudioReady(frame);
      await switchTab(frame, 'screen');
      await clickStudio(frame, '#formatGroup button[data-format="video"]');
      await setOutputDir(frame, OUT_DIR);
      await switchTab(frame, 'region');
      await clickStudio(frame, '#recordBtn');

      // 遮罩应该盖住一块屏幕，等用户在上面拉框。
      const picker = await findWindow(app, 'picker.html');
      expect(picker, '遮罩窗口应该出现').not.toBeNull();
      await picker.waitForLoadState('domcontentloaded');

      // 遮罩要**盖满整块屏**（含任务栏那块）：
      // 以前遮罩是画在桌宠上的，盖不到任务栏，用户框不到最下面一条。
      //
      // 窗口的位置与大小问主进程（Playwright 的 Page 没有 bounds()）。
      const geometry = await app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('picker.html')
        );
        const display = screen.getPrimaryDisplay();
        return { bounds: win?.getBounds() || null, display: display.bounds };
      });
      expect(geometry.bounds, '拿不到遮罩窗口的位置').toBeTruthy();
      expect(
        Math.abs(geometry.bounds.width - geometry.display.width),
        `遮罩宽 ${geometry.bounds.width}，屏幕宽 ${geometry.display.width}`
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(geometry.bounds.height - geometry.display.height),
        `遮罩高 ${geometry.bounds.height}，屏幕高 ${geometry.display.height}（任务栏那块也要盖到）`
      ).toBeLessThanOrEqual(2);

      // 选区是**透明**的：选中的那块不能蒙一层蓝。
      expect(
        await picker.locator('#sel').evaluate((el) => getComputedStyle(el).backgroundColor),
        '选中的那块不该有背景色'
      ).toBe('rgba(0, 0, 0, 0)');

      await picker.mouse.move(200, 200);
      await picker.mouse.down();
      await picker.mouse.move(600, 500, { steps: 8 });
      await picker.mouse.up();

      // 遮罩上写着选区有多大（DIP）。
      const label = await picker.textContent('#size');
      const [selWidth, selHeight] = (label || '').match(/(\d+)\s*×\s*(\d+)/)?.slice(1).map(Number) || [];
      expect(selWidth, `遮罩上没写出选区大小：${label}`).toBeGreaterThan(0);

      // 用 evaluate 派发 click：点了之后遮罩立刻就没了，
      // 用 Playwright 的 click 的话，它会等一个已经不存在的窗口。
      await picker.evaluate(() => document.getElementById('ok').click());

      // 遮罩必须在开始录制**之前**关掉：不然那层暗色会被录进画面。
      await new Promise((r) => setTimeout(r, 1500));
      expect(await findWindow(app, 'picker.html'), '遮罩应该已经关掉了').toBeNull();

      // 框完的边框要**留在桌面上**，直到录制结束。
      const frameWindow = await findWindow(app, 'region-frame.html');
      expect(frameWindow, '选区边框应该留在桌面上').not.toBeNull();

      await new Promise((r) => setTimeout(r, 2000));
      await clickStudio(frame, '#recordBtn');
      await new Promise((r) => setTimeout(r, 3000));

      // 录完了，边框就该撤掉。
      expect(await findWindow(app, 'region-frame.html'), '录完了边框应该撤掉').toBeNull();

      const files = await readdir(OUT_DIR);
      const mp4 = await newestRecording(OUT_DIR);
      const status = await studioStatus(frame);
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

  test('配置停在选区模式时，再打开录屏照样能用', async () => {
    // **这条守的是一个真实的坑**：选区模式把 mode 存成 'region'，
    // 而「可录目标」只有两类（显示器与窗口）——选区用的是显示器。
    // 早先拿模式直接当下标，于是选区模式去找一个根本不存在的桶，
    // 取数据时炸成「Cannot read properties of undefined (reading 'length')」，
    // 界面一片空白；而配置里的模式还停在选区，于是**每次打开都炸**。
    //
    // 这里直接把配置写成选区模式，复现用户遇到的那个场景。
    await writeFile(
      join(USER_DATA, 'screen-recorder.json'),
      JSON.stringify({ mode: 'region' }),
      'utf8'
    );

    const { app, pet } = await launch();
    try {
      const panel = await openRecorder(app, pet);
      const frame = studio(panel);
      // 取数据要是炸了，页面就永远拿不到 state——这一步等不到就是回归了。
      await waitStudioReady(frame);

      // **等的是「那份数据」，不是「有个 state」**。
      //
      // 周期数据（tick）每 500ms 就来一次，里面没有模式；
      // 首份数据要等主进程列完显示器与窗口（几百毫秒到一两秒）才到。
      // 所以「state 有值了」不等于「数据到了」——
      // 早先就是只看 state 有没有，模式还没送到就断言，于是时好时坏。
      await frame.locator('.studio').evaluate(
        () =>
          new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = setInterval(() => {
              if (window.__studio?.state?.mode === 'region') {
                clearInterval(timer);
                resolve(true);
                return;
              }
              if (Date.now() - started > 20000) {
                clearInterval(timer);
                reject(new Error('主进程的首份数据没送到'));
              }
            }, 100);
          })
      );

      // 主进程给的数据到了，而且模式确实停在选区（配置被读到了）。
      const got = await frame.locator('.studio').evaluate(() => ({
        mode: window.__studio?.mode,
        stateMode: window.__studio?.state?.mode,
        screens: window.__studio?.state?.screens?.length ?? -1,
      }));
      expect(got.mode, '应该停在选区模式').toBe('region');
      expect(got.stateMode, '主进程给的数据里带着选区模式').toBe('region');
      // 目标列表也列出来了（炸的地方就是这儿）。
      expect(got.screens, '显示器列表应该列出来了').toBeGreaterThan(0);

      // 状态栏不该有报错。
      const status = await studioStatus(frame);
      expect(status, `不该报错：${status}`).not.toContain('做不了');
    } finally {
      await closeApp(app);
    }
  });
});
