// plugins/screenshot/lib/session.js
/**
 * 一次截图的「会话」：从抓屏到出图，这一路的窗口都归它管。
 *
 * 窗口有三个：
 *
 * - **遮罩**（每块屏一个）：盖住整块屏，框选、标注、工具条都在它上面；
 * - **识别结果**：认出字以后弹出来；
 * - **置顶**：把截出来的那块留在桌面上。
 *
 * 性能上只做两件事：**并行**抓每块屏、**一次**枚举窗口——
 * 这两样各自要半秒，串起来就慢成两秒了。
 */
import { join, dirname } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { electron } from './electron.js';
import { captureDisplays } from './capture.js';
import { listWindows } from './windows.js';
import { ocrFile } from './ocr.js';
import { disableWindowTransitions } from './win32.js';

const CHANNEL = 'shot:screenshot:message';

/**
 * @param {object} options
 * @param {string} options.pluginDir 插件目录
 * @param {string} options.preloadPath 插件自带的 preload
 * @param {() => {language:string,saveDir:string}} options.getConfig 取设置
 * @param {(text:string) => void} [options.onStatus] 报一句话给插件页面
 */
export async function createSession({ pluginDir, preloadPath, getConfig, onStatus }) {
  const { BrowserWindow, ipcMain, clipboard, app, dialog, ClipboardItem } = await electron();

  /** displayId → 遮罩窗口。 */
  const overlays = new Map();
  /** webContents.id → 窗口本身（页面报「画好了」时要 show 它）。 */
  const windowsByContents = new Map();
  /** 已经亮过的遮罩（没亮过的别被结果窗开合「提前」亮出来）。 */
  const overlayShown = new Set();
  /** webContents.id → 这个窗口是什么角色。 */
  const roles = new Map();
  /** 临时文件（用完删）。 */
  let temps = [];
  /** 结果窗 / 置顶窗。 */
  let result = null;
  let pinned = null;
  /** 置顶窗的图片文件（关了才能删）。 */
  let pinnedDir = '';
  /** 识别出来的字（结果窗的「复制」要用）。 */
  let lastText = '';
  let listening = false;

  const status = (text) => {
    if (onStatus) onStatus(text);
  };

  // -------------------------------------------------------------------------
  // 窗口
  // -------------------------------------------------------------------------

  /** 记住窗口是什么角色：消息过来时要分清是谁发的。 */
  function track(win, role) {
    // **webContents.id 要提前存下来**：窗口销毁之后再读 `win.webContents`
    // 会把主进程整个冻住。
    const id = win.webContents.id;
    roles.set(id, role);
    windowsByContents.set(id, win);
    win.on('closed', () => {
      roles.delete(id);
      windowsByContents.delete(id);
    });
    return win;
  }

  /** 遮罩窗口的通用参数：透明、无边框、永远在最前、先藏着。 */
  function overlayOptions(display) {
    return {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      // **先 show: false**：窗口出生时 Windows 会把它夹到工作区，
      // 等「撐回整屏 + 抬到 screen-saver 级」都做完、页面把冻结画面画好，
      // 一步到位地 show——不让用户看到半成品状态（闪、缩）。
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 抓屏
  // -------------------------------------------------------------------------

  /** 桌面的壳与任务栏：盖着整块屏、指针底下永远有它们——吸附到它们等于框了整块屏。 */
  const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

  /**
   * 自动选窗用的窗口：这块屏上有哪些窗口，位置在哪（物理像素）。
   *
   * 系统给的两套坐标对不上号（脚本给的是每块屏自己的像素，
   * Electron 给的是 DIP），按尺寸与位置配对，配上了再按比例换算。
   */
  function snapWindowsFor(display, physW, physH, monitors, windows) {
    const scale = display.scaleFactor || 1;
    const originX = display.bounds.x * scale;
    const originY = display.bounds.y * scale;
    let best = null;
    let bestScore = Infinity;
    for (const monitor of monitors) {
      const score =
        Math.abs(monitor.w - physW) / physW +
        Math.abs(monitor.h - physH) / physH +
        Math.abs(monitor.x - originX) / physW +
        Math.abs(monitor.y - originY) / physH;
      if (score < bestScore) {
        bestScore = score;
        best = monitor;
      }
    }
    if (!best || bestScore > 0.5) return [];
    const k = physW / best.w;
    return windows
      .filter(
        (w) =>
          w.monitor === best.index &&
          // 比整块屏还大的不是「屏上的窗口」（桌面本身就是），
          // 框到它等于框了整块屏，没意思；桌面的壳与任务栏同理。
          w.w <= best.w * 1.05 &&
          w.h <= best.h * 1.05 &&
          !DESKTOP_CLASSES.has(w.cls)
      )
      .map((w) => ({
        x: Math.round(w.x * k),
        y: Math.round(w.y * k),
        w: Math.round(w.w * k),
        h: Math.round(w.h * k),
        title: w.title,
        cls: w.cls,
        z: w.z,
      }));
  }

  /**
   * 开一次会话。
   *
   * 抓屏是慢的那一步（半秒上下），而且遮罩窗口不能提前立起来——
   * 预先立起来会把屏幕捕获引擎堵死，抓屏要等一分钟。
   * 所以：先抓屏，抓完立刻铺遮罩（罩黑纱），
   * 列窗口这类慢活**不挡路**，窗口清单单独补发。
   */
  async function start() {
    if (overlays.size) return true;
    const { screen } = await electron();

    // 先抓屏再铺遮罩：预先立起来会把屏幕捕获引擎堵死（这台机器上要一分钟），
    // 所以遮罩只能等画面到了再建——建完立刻出现，黑纱罩着，画面到了撤纱。
    // 列窗口不挡路，窗口清单回来再单独补发。
    const deskPromise = listWindows().catch((err) => {
      console.warn('[截图] 列窗口失败：', err?.message);
      return { monitors: [], windows: [] };
    });

    let captures;
    try {
      captures = await captureDisplays();
    } catch (err) {
      status(err?.message || '抓不到画面');
      return false;
    }

    const dir = join(tmpdir(), `desk-pet-shot-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    temps.push(dir);

    // 列窗口不挡路：窗口清单回来再补发。页面可能还没加载完——
    // 谁后好了谁发（加载完后从 did-finish-load 里也会再触发一次）。
    let deskData = null;
    const sendWindows = (entry) => {
      if (entry.windowsSent || !entry.loaded) return;
      const snap = snapByDisplay.get(entry.id);
      if (!snap || !deskData) return;
      entry.windowsSent = true;
      if (!entry.win.isDestroyed()) {
        entry.win.webContents.send(CHANNEL, {
          type: 'windows',
          windows: snapWindowsFor(snap.display, snap.width, snap.height, deskData.monitors, deskData.windows),
        });
      }
    };

    const snapByDisplay = new Map();
    // 每个遮罩两件事没做完不许发图：页面加载完、JPEG 写完。
    const entries = [];
    const flush = (entry) => {
      if (entry.flushed || !entry.loaded || !entry.init) return;
      entry.flushed = true;
      const { win } = entry;
      if (win.isDestroyed()) return;
      win.webContents.send(CHANNEL, entry.init);
    };
    for (const display of screen.getAllDisplays()) {
      // **藏着建**：夹到工作区、撐回整屏、抬到 screen-saver 级，全在隐藏状态做完；
      // 页面把冻结画面真正画上去后（overlay.js 发 'ready'）才一次性 show。
      const win = new BrowserWindow(overlayOptions(display));
      // 关掉 DWM 转场（「动画效果」开着的话，全屏置顶窗出现会被播成整屏缩放）。
      disableWindowTransitions(win);
      win.setAlwaysOnTop(true, 'screen-saver');
      // **建成之后再设一次尺寸**：新建时 Windows 会把窗口夹到工作区
      // （任务栏以外那块），遮罩就盖不到任务栏了。藏着做，用户看不见。
      win.setBounds({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      });
      track(win, 'overlay');
      overlays.set(String(display.id), win);
      win.on('closed', () => overlays.delete(String(display.id)));
      // 兜底：页面一直没报「画好了」（脚本挂了之类），也得显示——
      // 用户按了快捷键看不见任何东西比晚半拍更糟。
      const showFallback = setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) {
          win.show();
          overlayShown.add(win);
        }
      }, 1500);
      showFallback.unref?.();
      win.loadFile(join(pluginDir, 'pages', 'overlay.html'));
      const entry = { win, display, id: String(display.id), loaded: false, init: null, flushed: false };
      win.webContents.once('did-finish-load', () => {
        entry.loaded = true;
        flush(entry);
        sendWindows(entry);
      });
      entries.push(entry);
    }

    for (const entry of entries) {
      const { win, id } = entry;
      const capture = captures.find((item) => String(item.display.id) === id);
      if (!capture) {
        overlays.delete(id);
        if (!win.isDestroyed()) win.destroy();
        continue;
      }
      const file = join(dir, `screen-${id}.jpg`);
      // **写文件而不是塞进 IPC**：一屏 2560×1440 的图走 IPC 是好几兆的
      // 字符串，页面再解一遍 base64，慢得能感觉到。
      await writeFile(file, capture.image.toJPEG(92));

      const scale = capture.display.scaleFactor || 1;
      snapByDisplay.set(id, { display: capture.display, width: capture.width, height: capture.height });
      entry.init = {
        type: 'init',
        file: pathToFileURL(file).href,
        width: capture.width,
        height: capture.height,
        scale,
        displayId: capture.display.id,
      };
      flush(entry);
    }

    // 自动选窗用的窗口清单回来后，单独补给每个遮罩。
    deskPromise.then((desk) => {
      deskData = desk;
      for (const entry of entries) sendWindows(entry);
    });
    status('移动鼠标选中窗口，或拖动框选');
    return true;
  }

  // -------------------------------------------------------------------------
  // 结果窗与置顶窗
  // -------------------------------------------------------------------------

  function closeResult() {
    if (result && !result.isDestroyed()) result.destroy();
    result = null;
    // 遮罩盖着整块屏：结果窗开着的时候把它藏起来，
    // 不然结果窗会躲在遮罩底下看不见（没亮过的遮罩不要提前亮）。
    for (const win of overlays.values()) {
      if (!win.isDestroyed() && overlayShown.has(win)) win.show();
    }
  }

  function showResult(text) {
    if (result && !result.isDestroyed()) result.destroy();
    result = new BrowserWindow({
      width: 460,
      height: 360,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    result.setAlwaysOnTop(true, 'screen-saver');
    disableWindowTransitions(result);
    track(result, 'result');
    result.on('closed', () => {
      result = null;
      for (const win of overlays.values()) {
        if (!win.isDestroyed() && overlayShown.has(win)) win.show();
      }
    });
    result.loadFile(join(pluginDir, 'pages', 'result.html'));
    result.webContents.once('did-finish-load', () => {
      if (result && !result.isDestroyed()) {
        result.webContents.send(CHANNEL, { type: 'text', text });
      }
    });
    // 遮罩先藏起来，结果窗才看得见（没亮过的遮罩不用藏）。
    for (const win of overlays.values()) {
      if (!win.isDestroyed() && overlayShown.has(win)) win.hide();
    }
  }

  /** 置顶：把截出来的那块留在桌面上。 */
  async function showPinned(buffer) {
    const dir = join(tmpdir(), `desk-pet-shot-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'pinned.png');
    await writeFile(file, buffer);
    if (pinned && !pinned.isDestroyed()) pinned.destroy();
    if (pinnedDir) rm(pinnedDir, { recursive: true, force: true }).catch(() => {});
    pinnedDir = dir;
    pinned = new BrowserWindow({
      width: 720,
      height: 520,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    pinned.setAlwaysOnTop(true, 'screen-saver');
    disableWindowTransitions(pinned);
    track(pinned, 'pinned');
    pinned.on('closed', () => {
      pinned = null;
    });
    pinned.loadFile(join(pluginDir, 'pages', 'pinned.html'));
    pinned.webContents.once('did-finish-load', () => {
      if (pinned && !pinned.isDestroyed()) {
        pinned.webContents.send(CHANNEL, { type: 'image', file: pathToFileURL(file).href });
      }
    });
  }

  // -------------------------------------------------------------------------
  // 出图
  // -------------------------------------------------------------------------

  /** 文件名：截图-20261116-021530.png */
  function fileName(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `截图-${stamp}.png`;
  }

  /** 默认存哪儿（设置里可以改；对话框里还能当场换目录）。 */
  function saveDir() {
    const custom = String(getConfig().saveDir || '').trim();
    return custom || join(app.getPath('pictures'), '截图');
  }

  /**
   * 存图：弹「另存为」对话框让用户挑位置。
   *
   * 对话框得盖在遮罩上面才点得到——先把亮着的遮罩藏起来；
   * 用户反悔（取消）就把遮罩放回来，接着框，不白抓一次屏。
   */
  async function saveImage(buffer) {
    const hidden = hideOverlaysForDialog();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '保存截图',
      defaultPath: join(saveDir(), fileName()),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (canceled || !filePath) {
      showOverlaysAfterDialog(hidden);
      status('已取消保存');
      return null;
    }
    const file = filePath.toLowerCase().endsWith('.png') ? filePath : `${filePath}.png`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, buffer);
    } catch (err) {
      showOverlaysAfterDialog(hidden);
      status(err?.message || '存不下');
      return null;
    }
    closeOverlays();
    cleanTemp();
    status(`已保存：${file}`);
    return file;
  }

  /** 认字：先把图落成临时文件，再交给 Windows 的 OCR。 */
  async function recognize(buffer) {
    const dir = join(tmpdir(), `desk-pet-shot-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'ocr.png');
    await writeFile(file, buffer);
    try {
      const result = await ocrFile(file, String(getConfig().language || '自动'));
      lastText = result.text || '';
      showResult(lastText);
      status(lastText ? `认出 ${result.lines.length} 行` : '没认出文字');
    } catch (err) {
      status(err?.message || '认不出来');
    } finally {
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // 消息
  // -------------------------------------------------------------------------

  /** 页面画好冻结画面了：这时候才把遮罩亮出来（像微信那样一步到位）。 */
  function showOverlay(contentsId) {
    if (roles.get(contentsId) !== 'overlay') return;
    const win = windowsByContents.get(contentsId);
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
      overlayShown.add(win);
    }
  }

  /** 亮着的遮罩藏起来（对话框得能点到），返回藏起来的那些——反悔了原样放回去。 */
  function hideOverlaysForDialog() {
    const hidden = [];
    for (const win of overlayShown) {
      if (!win.isDestroyed() && win.isVisible()) {
        win.hide();
        hidden.push(win);
      }
    }
    return hidden;
  }

  function showOverlaysAfterDialog(windowsToShow) {
    for (const win of windowsToShow) {
      if (!win.isDestroyed()) win.show();
    }
  }

  function handleMessage(message, contentsId) {
    const role = roles.get(contentsId);
    if (!message || typeof message !== 'object') return;

    if (message.type === 'ready') {
      showOverlay(contentsId);
      return;
    }
    if (message.type === 'png') {
      const buffer = Buffer.from(message.buffer);
      if (message.action === 'ocr') {
        recognize(buffer);
      } else if (message.action === 'save') {
        // 另存为之后不再多余提示：成功/取消，函数里都报过了。
        saveImage(buffer).catch((err) => status(err?.message || '存不下'));
      } else if (message.action === 'copy') {
        // 复制 = 截图完成：图进剪贴板，遮罩收掉。
        // Electron 45 的 clipboard 是 W3C 风格的异步接口：
        // writeImage 没了，写图要走 ClipboardItem + image/png 的 Blob。
        const item = new ClipboardItem({
          'image/png': new Blob([new Uint8Array(buffer)], { type: 'image/png' }),
        });
        clipboard
          .write([item])
          .then(() => {
            closeOverlays();
            cleanTemp();
            status('已复制到剪贴板');
          })
          .catch((err) => {
            console.warn('[截图] 复制到剪贴板失败：', err?.message);
            // 不收遮罩：没复制出去就把最后一步留给用户。
            status(err?.message || '复制不进去');
          });
      } else if (message.action === 'pin') {
        // 置顶就是截图完成：先把遮罩收掉（反馈要立刻），再开置顶窗。
        closeOverlays();
        cleanTemp();
        status('已置顶');
        showPinned(buffer).catch((err) => status(err?.message || '置顶不了'));
      }
      return;
    }
    if (message.type === 'finish') {
      closeOverlays();
      cleanTemp();
      status('好了');
      return;
    }
    if (message.type === 'cancel') {
      stop();
      status('取消了');
      return;
    }
    if (role === 'result') {
      if (message.type === 'copy') {
        // Electron 45 的 writeText 是异步的：别让它的拒绝变成未处理异常。
        clipboard.writeText(lastText || '').catch(() => {});
        status('文字已复制');
      } else if (message.type === 'close') {
        closeResult();
      }
      return;
    }
    if (role === 'pinned' && message.type === 'close') {
      if (pinned && !pinned.isDestroyed()) pinned.destroy();
      pinned = null;
    }
  }

  function closeOverlays() {
    for (const win of overlays.values()) {
      if (!win.isDestroyed()) win.destroy();
      overlayShown.delete(win);
    }
    overlays.clear();
  }

  /** 临时文件（抓屏用的那几张）用完就删。 */
  function cleanTemp() {
    for (const dir of temps) rm(dir, { recursive: true, force: true }).catch(() => {});
    temps = [];
  }

  /** 收摊：窗口全关，临时文件全删。 */
  function stop() {
    closeOverlays();
    if (result && !result.isDestroyed()) result.destroy();
    result = null;
    if (pinned && !pinned.isDestroyed()) pinned.destroy();
    pinned = null;
    if (pinnedDir) rm(pinnedDir, { recursive: true, force: true }).catch(() => {});
    pinnedDir = '';
    cleanTemp();
  }

  function listen() {
    if (listening) return;
    listening = true;
    ipcMain.on(CHANNEL, (event, message) => {
      try {
        handleMessage(message, event.sender.id);
      } catch (err) {
        console.warn('[截图] 处理消息出错：', err?.message);
      }
    });
  }

  return {
    start,
    stop,
    listen,
    /** 遮罩是不是正开着（框选等用户操作）。 */
    isActive: () => overlays.size > 0,
  };
}
