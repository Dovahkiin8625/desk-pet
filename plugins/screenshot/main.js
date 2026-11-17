// plugins/screenshot/main.js
/**
 * 截图插件。
 *
 * 干的事：在桌面上像微信那样框一块，标注一下，认出上面的字。
 *
 * 识别用的是 Windows 自带的 OCR（见 lib/ocr.js）：不联网、不下模型。
 *
 * 怎么用：
 *
 * 1. 按「截图」（或按全局快捷键，默认 Ctrl+Shift+A），桌面上每块屏都铺一层遮罩；
 * 2. 鼠标移到窗口上会自动选中它，点一下确认；也可以直接拖框（拖的时候不吸附）；
 * 3. 框完下面就有工具条：标注、识别文字、保存、置顶；
 * 4. 按 √ 收工，按 × 取消。
 *
 * 全局快捷键（设置里能改、能清掉）：
 *
 * - 插件开着且设了快捷键，桌宠一启动就注册；
 * - 插件被关掉（设置窗口里关的）之后不生效；
 * - 遮罩已经开着的时候再按，等于没按（框选等着用户操作，重复按只会多抓一遍屏）。
 *
 * 给 agent 的工具：
 *
 * - `screenshot.capture`：抓一张图存到磁盘，返回文件路径；
 * - `screenshot.ocr`：识别一张图片里的文字。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron } from './lib/electron.js';
import { captureScreen } from './lib/capture.js';
import { ocrFile } from './lib/ocr.js';
import { createSession } from './lib/session.js';
import { isValidAccel } from './lib/accelerator.js';
import { setHotkeys, clearHotkeys } from './lib/hotkey.js';

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const PRELOAD_PATH = join(PLUGIN_DIR, 'preload', 'shot.cjs');

/** 插件 id（与目录名、清单里的 id 一致）。 */
const PLUGIN_ID = 'screenshot';

export default function createScreenshotPlugin(ctx) {
  /** 底下那行提示。 */
  let status = '';

  /** 有活儿在干（抓屏要一会儿）。 */
  let busy = false;

  /** 截图会话（第一次截图时才建）。 */
  let session = null;

  /** 识别语言（设置里的值）。 */
  function language() {
    return String(ctx.config?.language || '自动');
  }

  /** 全局快捷键（设置里的值，空 = 不设）。 */
  function hotkey() {
    return String(ctx.config?.hotkey || '').trim();
  }

  /** 快捷键注册不成功的理由（界面上显示）。 */
  let hotkeyError = '';
  /** 上一次生效出去的注册结果。 */
  let hotkeyState = { active: false, accel: '' };

  /** 图片存到哪儿（设置里可以改）。 */
  async function saveDir() {
    const custom = String(ctx.config?.saveDir || '').trim();
    if (custom) return custom;
    const { app } = await electron();
    return join(app.getPath('pictures'), '截图');
  }

  /** 文件名：截图-20261116-021530.png */
  function fileName(date = new Date(), ext = 'png') {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `截图-${stamp}.${ext}`;
  }

  /** 给界面看的一份状态。 */
  function payload() {
    return {
      status,
      busy,
      language: language(),
      saveDir: String(ctx.config?.saveDir || ''),
      hotkey: hotkey(),
      hotkeyError,
    };
  }

  /** 会话：一次会话里管着遮罩、结果窗、置顶窗。 */
  async function ensureSession() {
    if (!session) {
      session = await createSession({
        pluginDir: PLUGIN_DIR,
        preloadPath: PRELOAD_PATH,
        getConfig: () => ({
          language: language(),
          saveDir: String(ctx.config?.saveDir || ''),
        }),
        onStatus: (text) => {
          status = text;
          ctx.push(payload());
        },
      });
      session.listen();
    }
    return session;
  }

  /** 开一次截图：桌面上铺遮罩，等着框。 */
  async function startShot() {
    if (busy) return;
    busy = true;
    status = '抓屏中…';
    ctx.push(payload());
    try {
      const current = await ensureSession();
      await current.start();
    } catch (err) {
      status = err?.message || '抓不到画面';
    } finally {
      busy = false;
      ctx.push(payload());
    }
  }

  // -------------------------------------------------------------------------
  // 全局快捷键
  // -------------------------------------------------------------------------

  /** 遮罩正开着 / 正在抓屏：快捷键再按也等于没按。 */
  function triggerShot() {
    if (busy) return;
    if (session?.isActive?.()) return;
    void startShot();
  }

  /**
   * 快捷键什么时候生效。
   *
   * - **桌宠启动就生效**：插件开着、快捷键设了，启动时就注册——
   *   不开界面也能按，它存在的意义正是这个。
   * - **插件被关掉之后**：不生效（盯着 isEnabled，关了就注销）。
   * - **快捷键设成空的**：不生效（= 用户主动「不设」）。
   */
  async function syncHotkeysNow() {
    const accel = hotkey();
    const want = ctx.host.isEnabled(PLUGIN_ID) && Boolean(accel);
    if (!want) {
      const had = hotkeyState.active || hotkeyError;
      if (hotkeyState.active) {
        hotkeyState = { active: false, accel: '' };
        await clearHotkeys();
      }
      hotkeyError = '';
      if (had) ctx.push(payload());
      return;
    }
    // 状态没变就别重注册：重注册要把快捷键让出去再抢回来，
    // 中间那一下按键是按不上的。
    if (hotkeyState.active && hotkeyState.accel === accel) return;
    if (!isValidAccel(accel)) {
      if (hotkeyState.active) {
        hotkeyState = { active: false, accel: '' };
        await clearHotkeys();
      }
      hotkeyError = `快捷键「${accel}」用不了：要带一个修饰键（Ctrl / Alt / Shift），而且不能全是修饰键`;
      ctx.push(payload());
      return;
    }
    const result = await setHotkeys([{ accel, onTrigger: triggerShot }]);
    if (result.failed.length) {
      hotkeyState = { active: false, accel: '' };
      hotkeyError = `快捷键 ${result.failed.join('、')} 注册不了——可能已经被别的程序占着了`;
    } else {
      hotkeyState = { active: true, accel };
      hotkeyError = '';
    }
    ctx.push(payload());
  }

  // 注册/注销是异步的：调用方不用等，但同一时刻只跑一轮，
  // 免得「清旧的」与「注册新的」交错出乱。
  let hotkeyChain = Promise.resolve();
  function syncHotkeys() {
    hotkeyChain = hotkeyChain.then(syncHotkeysNow, syncHotkeysNow);
    return hotkeyChain.catch(() => {});
  }

  /**
   * 盯着「插件是不是被关掉了」，关了就注销快捷键、开了再注册回来。
   *
   * 设置窗口里把插件关掉时，宿主会关掉**它自己**的插件界面；
   * 快捷键是插件自己注册的，宿主管不着——得自己盯着。
   */
  const watchTimer = setInterval(() => {
    void syncHotkeys();
  }, 2000);
  watchTimer.unref?.();

  // 工厂函数跑的时候，宿主还没把这个插件登记进去
  //（`ctx.host.isEnabled` 那会儿问不到）。等一拍，登记好了再注册。
  setTimeout(() => {
    void syncHotkeys();
  }, 0);

  // 退出时注销：不注册着别人退出时会被系统自己收（进程没了，Windows 会释放），
  // 这里显式注销是个干净利落的收尾。拿不到 app（单测）就算了。
  void electron()
    .then(({ app }) => {
      app?.on?.('before-quit', () => {
        clearInterval(watchTimer);
        void clearHotkeys();
      });
    })
    .catch(() => {});

  /** 自己页面里的首份数据。 */
  async function data() {
    return payload();
  }

  /** 自己页面里的一个动作。 */
  async function act(currentCtx, actionId, body) {
    const input = body && typeof body === 'object' ? body : {};
    const action = String(actionId);

    if (action === 'shot') {
      await startShot();
      return payload();
    }
    if (action === 'setting') {
      const key = String(input.key || '');
      if (key) {
        const result = await ctx.host.setConfig({ [key]: input.value });
        if (result && result.ok === false) status = result.message || '设置没存上';
        // 刚改的快捷键要**立刻**生效。
        if (key === 'hotkey') {
          await syncHotkeys();
        }
      }
      return payload();
    }
    return payload();
  }

  /** 标题那几个字段（自己的页面用）。要便宜：别在这儿抓屏。 */
  async function meta() {
    return {
      title: '截图',
      subtitle: '在桌面上框一块，认出上面的字',
    };
  }

  /** 积木页面（自己的页面不在磁盘上时的退路）。 */
  async function page(currentCtx) {
    return currentCtx.ui.makePage({
      pluginId: PLUGIN_ID,
      title: '截图',
      subtitle: '在桌面上框一块，认出上面的字',
      status,
      blocks: [
        currentCtx.ui.heroBlock({
          icon: 'image',
          title: '截图',
          subtitle: '在桌面上框一块，认出上面的字',
        }),
        currentCtx.ui.buttonsBlock([{ id: 'shot', label: '截图', primary: true, icon: 'image' }]),
      ],
    });
  }

  /** 积木页面里的一个动作。 */
  async function action(currentCtx, actionId) {
    if (String(actionId) === 'shot') await startShot();
    return page(currentCtx);
  }

  /** 给 agent 的工具。 */
  function tools() {
    return [
      {
        name: 'screenshot.capture',
        async run({ displayId } = {}) {
          const result = await captureScreen(displayId ? String(displayId) : '');
          const dir = await saveDir();
          await mkdir(dir, { recursive: true });
          const file = join(dir, fileName());
          await writeFile(file, result.image.toPNG());
          return { text: `已截图：${file}`, data: { path: file } };
        },
      },
      {
        name: 'screenshot.ocr',
        async run({ path } = {}) {
          const file = String(path || '').trim();
          if (!file) throw new Error('要识别哪张图？给个 path');
          const result = await ocrFile(file, language());
          if (!result.text) return { text: '这张图里没认出文字', data: { lines: 0 } };
          return { text: result.text, data: { lines: result.lines.length } };
        },
      },
    ];
  }

  return { page, action, meta, data, act, tools };
}
