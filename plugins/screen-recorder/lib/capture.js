// plugins/screen-recorder/lib/capture.js
import { desktopCapturer, session } from 'electron';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { recordingFileName, uniquePath } from './naming.js';

const PARTITION = 'persist:screen-recorder';

/** 捕获页报「准备好了」之后，等多久算超时。 */
const READY_TIMEOUT_MS = 15000;

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

  function isRecording() {
    return state === 'recording' || state === 'starting';
  }

  function tick() {
    onState?.({ recording: isRecording(), elapsedMs: Date.now() - startedAt });
  }

  /** 列出可录的目标。 */
  async function listTargets(mode) {
    const isWindow = mode === 'window';
    // **不要缩略图**：要缩略图的话，系统会去挨个抓一遍窗口的画面，
    // 其中某个抓不到就得等它超时——实测列一次窗口要 5.5 秒，
    // 不要缩略图只要 0.4 秒。抓不到窗口的事留给真去录的时候再报错。
    const sources = await desktopCapturer.getSources({
      types: isWindow ? ['window'] : ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.map((s) => ({
      id: s.id,
      label: s.name || s.id,
      hint: isWindow ? '窗口' : '显示器',
    }));
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
      const picked = pendingSources.find((s) => s.id === sourceId) || pendingSources[0];
      if (!picked) {
        callback(null);
        return;
      }
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
    readyResolve?.();
  }

  /**
   * 开始录制。
   *
   * @param {object} options
   * @param {string} options.sourceId 显示器或窗口的源 id
   * @param {'video'|'gif'} options.format
   * @param {number} options.fps
   * @param {{mic:boolean,speaker:boolean}} options.audio
   */
  async function start(options) {
    if (isRecording()) throw new Error('已经在录了');
    state = 'starting';
    startedAt = Date.now();
    sourceId = options.sourceId || '';

    // 源提前取好：handler 里现取要等 5.9 秒（见 pendingSources 的说明）。
    pendingSources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
    });

    prepareSession();
    const win = windows.createCapture();
    const ready = waitReady();
    await ready;
    if (win.isDestroyed()) throw new Error('捕获页已经关了');
    win.webContents.send('rec:screen-recorder:message', {
      type: 'begin',
      payload: {
        sourceId,
        format: options.format,
        fps: options.fps,
        audio: options.audio,
        crop: options.crop || null,
        snapshotSize: options.snapshotSize || null,
      },
    });
    state = 'recording';
    timer = setInterval(tick, 500);
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
    state = 'idle';
    if (timer) clearInterval(timer);
    timer = null;
    windows.hideControl();
    windows.destroyCapture();
    onState?.({ recording: false, elapsedMs: 0, file: target });
    return target;
  }

  /** 出错了也要能回到 idle。 */
  function fail(message) {
    state = 'idle';
    if (timer) clearInterval(timer);
    timer = null;
    windows.hideControl();
    windows.destroyCapture();
    onState?.({ recording: false, elapsedMs: 0, error: message });
  }

  function dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    state = 'idle';
    readyResolve = null;
    if (captureSession) {
      captureSession.setDisplayMediaRequestHandler(null);
      captureSession = null;
    }
  }

  return { listTargets, start, stop, save, fail, notifyReady, isRecording, dispose };
}
