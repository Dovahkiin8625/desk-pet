// plugins/screen-recorder/lib/capture.js
import { desktopCapturer, screen, session } from 'electron';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { recordingFileName, uniquePath } from './naming.js';

const PARTITION = 'persist:screen-recorder';

/** 捕获页报「准备好了」之后，等多久算超时。 */
const READY_TIMEOUT_MS = 15000;

/**
 * 预览图的尺寸（像素）。
 *
 * 这是个**包围盒**：Electron 按它缩放，但**保持原来的长宽比**——
 * 给正方形，竖着的屏就不会被压扁。
 */
const PREVIEW_BOX = 480;

/**
 * 预览图的 JPEG 质量。
 *
 * 预览图走的是 data URL（要过 IPC），一块 480×270 的屏
 * PNG 要 35–140 KB（看画面内容），JPEG 只要 15–20 KB。
 * 有几块屏就是几倍——省下来的都是过 IPC 的字节。
 */
const PREVIEW_QUALITY = 80;

/**
 * 录制会话。
 *
 * 状态机只有四态：idle → starting → recording → idle。
 * 一次只录一段（再来一次就是「已经在录了」）。
 */
export function createCaptureSession({ windows, getOutputDir, onState }) {
  let state = 'idle';
  let startedAt = 0;
  let timer = null;
  /** 本次录制要用的源 id（显示器或窗口）。 */
  let sourceId = '';
  /** 捕获窗的分区会话（handler 装在上面）。 */
  let captureSession = null;
  /**
   * 提前取好的源。
   *
   * handler 里现取源看着自然，但**慢得要命**：取源会顺带抓一遍画面，
   * 其中一块抓不到就得等它超时——实测 5.9 秒才拿到流，
   * 提前取好只用 0.2 秒。
   */
  let pendingSources = [];
  /** 捕获页说「准备好了」的回调。 */
  let readyResolve = null;
  /** 捕获页已经就绪过吗（窗口是复用的，第二次不用再等）。 */
  let pageReady = false;

  function isRecording() {
    return state === 'recording' || state === 'starting';
  }

  function tick() {
    onState?.({ recording: isRecording(), elapsedMs: Date.now() - startedAt });
  }

  /**
   * 显示器 id → 显示器信息。
   *
   * 兜底是**主显示器**（`getPrimaryDisplay()`），不是 `getAllDisplays()[0]`：
   * 那个顺序没有保证，实测多屏机器上第一块往往是副屏——
   * 选区遮罩会开到副屏上去，而用户要框的是眼前这块（带任务栏的那块）。
   */
  function displayById(displayId) {
    const displays = screen.getAllDisplays();
    return (
      displays.find((d) => String(d.id) === String(displayId || '')) ||
      screen.getPrimaryDisplay() ||
      displays[0] ||
      null
    );
  }

  /**
   * 显示器 id → 显示器信息（**认不出一律 null，不兜底**）。
   *
   * 与 `displayById` 的差别就在兜底：这里要的是「就是这一块」，
   * 兜底成主显示器会让预览图挂到别的屏上——
   * 那一块明明在列表里，图片却是另一块屏的。
   */
  function displayOf(displayId) {
    if (!displayId) return null;
    return screen.getAllDisplays().find((d) => String(d.id) === String(displayId || '')) || null;
  }

  /**
   * 每块显示器的名字。
   *
   * **用型号（`display.label`），不用捕获源给的 `name`**：
   * 捕获源给的是「屏幕 1」「屏幕 2」——两块同型号的屏就分不清了。
   * 型号重了才补个序号（「DELL U2720Q (2)」）。
   *
   * @returns {Map<string,string>} 显示器 id → 名字
   */
  function displayLabels() {
    const displays = screen.getAllDisplays();
    /** 型号 → 有几块。 */
    const totals = new Map();
    for (const d of displays) {
      const key = d.label || '';
      totals.set(key, (totals.get(key) || 0) + 1);
    }
    /** 型号 → 已经排到第几块。 */
    const seen = new Map();
    const map = new Map();
    for (const d of displays) {
      const base = d.label || `显示器 ${d.id}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      map.set(String(d.id), totals.get(base) > 1 ? `${base} (${n})` : base);
    }
    return map;
  }

  /**
   * 列出可录的目标。
   *
   * 显示器模式下**顺带把每块屏的预览图也抓了**：
   * 预览图要的就是同一个 `getSources` 调用（缩略图），
   * 另开一次调用只是把同样的活儿干两遍——每次都要 0.5 秒。
   *
   * @param {'screen'|'window'} mode
   * @returns {Promise<Array<{id:string,label:string,hint:string,displayId?:string,
   *   icon?:string,preview?:string,meta?:string}>>}
   */
  async function listTargets(mode) {
    const isWindow = mode === 'window';
    // 窗口**不要缩略图**：要缩略图的话，系统会去挨个抓一遍窗口的画面，
    // 其中某个抓不到就得等它超时——实测列一次窗口要 5.5 秒，
    // 不要缩略图只要 0.4 秒。抓不到窗口的事留给真去录的时候再报错。
    //
    // 显示器**要缩略图**：界面上要给每块屏画一张预览，
    // 而这一次调用就把所有屏的预览都带回来了（实测与不带缩略图一样快）。
    const sources = await desktopCapturer.getSources({
      types: isWindow ? ['window'] : ['screen'],
      thumbnailSize: isWindow
        ? { width: 0, height: 0 }
        : { width: PREVIEW_BOX, height: PREVIEW_BOX },
    });
    if (isWindow) {
      return sources.map((s) => ({
        id: s.id,
        label: s.name || s.id,
        hint: '窗口',
        // 窗口的应用图标：Electron 直接给得到（Windows/macOS），
        // **不用为了图标去抓缩略图**——抓缩略图会把列窗口从 0.4 秒拖到 5.5 秒。
        icon: appIconOf(s),
      }));
    }
    // **主显示器排第一**：用户没选的时候默认就是它，
    // 选区遮罩也开在它上面——多屏机器上「第一块」不一定是眼前那块。
    const primary = String(screen.getPrimaryDisplay()?.id || '');
    sources.sort((a, b) => {
      const aPrimary = String(a.display_id || '') === primary ? 0 : 1;
      const bPrimary = String(b.display_id || '') === primary ? 0 : 1;
      return aPrimary - bPrimary;
    });
    const labels = displayLabels();
    return sources.map((s) => {
      const display = displayOf(s.display_id);
      return {
        id: s.id,
        label: labels.get(String(s.display_id || '')) || s.name || s.id,
        hint: '显示器',
        // 显示器模式下，选区要按「用户选的那块屏」来框。
        displayId: s.display_id || '',
        // 这块屏的预览图（data URL）：界面上点一下就选它。
        preview: previewOf(s),
        // 分辨率：两块屏长得一样时，这是唯一能分出来的线索。
        meta: display ? physicalSize(display) : '',
      };
    });
  }

  /** 显示器的物理像素尺寸（bounds 是 DIP，缩放不是 100% 时两者不等）。 */
  function physicalSize(display) {
    const scale = display.scaleFactor || 1;
    return `${Math.round(display.bounds.width * scale)}×${Math.round(
      display.bounds.height * scale
    )}`;
  }

  /** 源的图标（data URL）。没有就空串。 */
  function appIconOf(source) {
    try {
      const icon = source?.appIcon;
      if (!icon || typeof icon.isEmpty !== 'function' || icon.isEmpty()) return '';
      return icon.toDataURL();
    } catch {
      return '';
    }
  }

  /**
   * 源的预览图（data URL）。
   *
   * **用 JPEG 不用 PNG**：预览图要过 IPC，几块屏就是几倍。
   * 一块 480×270 的屏，PNG 要 35–140 KB（看画面内容），
   * JPEG 只要 15–20 KB——差出来的都是白传的字节。
   */
  function previewOf(source) {
    try {
      const thumb = source?.thumbnail;
      if (!thumb || typeof thumb.isEmpty !== 'function' || thumb.isEmpty()) return '';
      if (typeof thumb.toJPEG === 'function') {
        const jpeg = thumb.toJPEG(PREVIEW_QUALITY);
        if (jpeg && jpeg.length) return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      }
      return thumb.toDataURL();
    } catch {
      return '';
    }
  }

  /**
   * 装好捕获窗用的 session。
   *
   * handler 只认**这一次**选好的源：用户选哪个窗口就录哪个，
   * 不是弹一个系统的选择框（那会把桌宠的界面也列进去）。
   */
  function prepareSession() {
    if (captureSession) return captureSession;
    captureSession = session.fromPartition(PARTITION);
    captureSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
    captureSession.setPermissionCheckHandler(() => true);
    captureSession.setDisplayMediaRequestHandler((request, callback) => {
      const picked = pendingSources.find((s) => s.id === sourceId);
      if (!picked) {
        // **不要兜底到别的源**：用户选的是某个窗口，兜底成整块屏幕，
        // 录出来的东西跟用户要的完全不是一回事，而且全程没有提示。
        console.warn(`[录屏] 要录的目标不在了：${sourceId}`);
        callback(null);
        return;
      }
      console.log(`[录屏] 捕获源：${picked.id}（${picked.name}），要的是 ${sourceId}`);
      callback({ video: picked, audio: request.audioRequested ? 'loopback' : undefined });
    });
    return captureSession;
  }

  /**
   * 等捕获页加载好。
   *
   * 页面加载完会报「准备好了」——**在那之前发指令是白发的**：
   * 页面还没挂上监听，消息直接丢了（window.webContents.send 不会排队）。
   */
  function waitReady() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        readyResolve = null;
        reject(new Error('捕获页没准备好'));
      }, READY_TIMEOUT_MS);
      readyResolve = () => {
        clearTimeout(timer);
        readyResolve = null;
        resolve();
      };
    });
  }

  /** 捕获页报「准备好了」。 */
  function notifyReady() {
    pageReady = true;
    readyResolve?.();
  }

  /**
   * 选区模式：先把遮罩开出来，等用户框一块。
   *
   * **顺序很重要**：遮罩必须先关掉，再开始取流。
   * 遮罩还在的时候取流，那块半透明的暗色层会被录进画面里。
   *
   * @param {{displayId?:string, sourceId?:string}} [target]
   *   displayId：框在哪块显示器上（框的坐标是相对它左上角的 DIP）；
   *   sourceId：那块屏对应的捕获源 id（录的时候要从它身上取流）。
   *   **两个都由调用方给**：调用方手里已经列好目标了，
   *   这里再列一次要多花 0.5 秒——而且可能列到不同的源 id。
   * @returns {Promise<{crop:object,snapshotSize:object,sourceId:string}|null>}
   */
  async function pickRegion(target = {}) {
    const display = displayById(target.displayId);
    if (!display) return null;

    // 快照的**物理像素**尺寸：bounds 是 DIP，缩放不是 100% 时两者不等。
    // 这里不用截图去问——显示器的尺寸本来就知道。
    const snapshotSize = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };

    const picked = await windows.openPicker({ display });
    // **遮罩必须先关掉**，再开始取流：它还在的时候取流，
    // 那层半透明的暗色会被录进画面里。
    windows.closePicker();
    if (!picked || !picked.rect) return null;

    // 遮罩报的是 DIP（它就那么大），裁剪要用物理像素。
    const scale = display.scaleFactor || 1;
    const crop = {
      x: Math.round(picked.rect.x * scale),
      y: Math.round(picked.rect.y * scale),
      width: Math.round(picked.rect.width * scale),
      height: Math.round(picked.rect.height * scale),
    };
    console.log(
      `[录屏] 选区：${display.label} ${crop.width}×${crop.height}（物理像素），源 ${display.id}`
    );

    // 选区边框留在桌面上，录完才撤（用户要看得见自己录的是哪一块）。
    windows.showRegionFrame({ display, rect: picked.rect });

    return {
      crop,
      snapshotSize,
      sourceId: String(target.sourceId || ''),
      displayId: String(display.id),
    };
  }

  /**
   * 开始录制。
   *
   * @param {object} options
   * @param {string} options.sourceId 显示器或窗口的源 id
   * @param {'video'|'gif'} options.format
   * @param {number} options.fps
   * @param {{mic:boolean,speaker:boolean,micDeviceIndex?:number}} options.audio
   */
  async function start(options) {
    if (isRecording()) throw new Error('已经在录了');
    state = 'starting';
    startedAt = Date.now();
    sourceId = options.sourceId || '';

    try {
      // 源提前取好：handler 里现取要等 5.9 秒（见 pendingSources 的说明）。
      pendingSources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });

      prepareSession();
      const win = windows.createCapture();
      // 捕获页是复用的：第一次要等它报「准备好了」，
      // 后面它已经在等着了，不用再等。
      if (!pageReady) await waitReady();
      if (win.isDestroyed()) throw new Error('捕获页已经关了');
      console.log(
        `[录屏] 开始：模式 ${options.mode}，裁剪 ${options.crop ? `${options.crop.width}×${options.crop.height}` : '无'}`
      );
      win.webContents.send('rec:screen-recorder:message', {
        type: 'begin',
        payload: {
          sourceId,
          // **模式要传下去**：捕获页要按它决定画面从哪儿来——
          // 录窗口的源会跟着窗口改尺寸，得先过一块固定大小的画布
          // （见 pages/recorder.js 的 startWindowCanvas）。
          mode: options.mode || 'screen',
          format: options.format,
          fps: options.fps,
          audio: options.audio,
          // GIF 的尺寸与帧率：捕获页自己一帧一帧编码，用的就是这两个。
          gif: options.gif || null,
          crop: options.crop || null,
          snapshotSize: options.snapshotSize || null,
        },
      });
    } catch (err) {
      /*
       * 开始失败：把状态收回去。
       *
       * 不收的话状态**永远停在 starting**，而 isRecording() 把 starting
       * 也算成「在录」——于是用户再也录不了第二次（每次都报「已经在录了」）。
       * finish() 顺手把选区边框、捕获窗、session 都收了。
       */
      finish();
      throw err;
    }

    state = 'recording';
    timer = setInterval(tick, 500);
    // 控制条：录屏时桌面上一直看得见「还在录」和「怎么停」。
    windows.showControl();
    tick();
  }

  /** 停止录制：让捕获页把已经录好的部分交回来。 */
  function stop() {
    if (!isRecording()) return false;
    const win = windows.captureWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send('rec:screen-recorder:message', { type: 'stop' });
    }
    return true;
  }

  /**
   * 放掉捕获窗的 session。
   *
   * 录完之后要**把 displayMedia 的 handler 摘掉**：它还挂着的时候，
   * 应用退出会卡住——主进程的事件循环被堵住，几十秒都动不了
   * （实测退出要多等十几秒到一百多秒）。下一次录制会重新装上。
   */
  function releaseSession() {
    if (!captureSession) return;
    try {
      captureSession.setDisplayMediaRequestHandler(null);
    } catch {
      // 已经没了就算了。
    }
    captureSession = null;
  }

  /** 收尾：选区边框撤掉（录完了还挂在屏幕上就碍事了）。 */
  function finish() {
    state = 'idle';
    if (timer) clearInterval(timer);
    timer = null;
    windows.hideControl();
    windows.closeRegionFrame();
    windows.destroyCapture();
    // 捕获窗没了，下次录制要重新等它报「准备好了」。
    pageReady = false;
    releaseSession();
  }

  /** 捕获页交回来的字节 → 写文件。 */
  async function save(bytes, ext) {
    const dir = getOutputDir();
    await mkdir(dir, { recursive: true });
    const name = recordingFileName(new Date(), ext);
    const target = await uniquePath(dir, name);
    const tmp = `${target}.part`;
    try {
      await writeFile(tmp, Buffer.from(bytes));
      await rename(tmp, target);
    } catch (err) {
      // 写坏了一半的文件留在那儿，下次看着像录好了其实是坏的。
      await unlink(tmp).catch(() => {});
      throw err;
    }
    finish();
    onState?.({ recording: false, elapsedMs: 0, file: target });
    return target;
  }

  /** 出错了也要能回到 idle。 */
  function fail(message) {
    finish();
    onState?.({ recording: false, elapsedMs: 0, error: message });
  }

  /**
   * 录制被取消了（还没开始就停了）。
   *
   * 不是错误：用户自己喊停的，就别留个「出错了」的脸色。
   */
  function cancel() {
    finish();
    onState?.({ recording: false, elapsedMs: 0, cancelled: true });
  }

  /** 出错了但还能继续录：只提示，不停。 */
  function warn(message) {
    onState?.({
      recording: isRecording(),
      elapsedMs: Date.now() - startedAt,
      warning: message,
    });
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    state = 'idle';
    readyResolve = null;
    releaseSession();
    windows.closeRegionFrame();
    windows.destroyCapture();
    pageReady = false;
  }

  return {
    listTargets,
    pickRegion,
    start,
    stop,
    save,
    fail,
    cancel,
    warn,
    notifyReady,
    isRecording,
    dispose,
  };
}
