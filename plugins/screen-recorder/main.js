// plugins/screen-recorder/main.js
import { app, dialog } from 'electron';
import { join } from 'node:path';
import { readConfig, writeConfig } from './lib/config.js';
import { buildPanelPage } from './lib/page.js';
import { createWindows } from './lib/windows.js';
import { createCaptureSession } from './lib/capture.js';
import { registerIpc } from './lib/ipc.js';

/**
 * 录屏插件。
 *
 * 插件跑在**主进程**里（宿主用动态 import 加载它），所以 electron 的 API
 * 直接就能用——这里没有沙箱，插件与宿主之间靠的是约定，不是权限边界。
 */
export default function createScreenRecorderPlugin(ctx) {
  /** 配置只在第一次用时读盘，之后走缓存。 */
  let config = null;
  /** 底部那行提示：做完某个动作的结果。 */
  let status = '';
  /** 可录的目标（显示器/窗口），随模式变。 */
  let targets = [];
  let recording = false;
  /** 目标中途没了之类的附注，存好文件时一起显示。 */
  let endedNote = '';
  /**
   * 刷新面板的回调。
   *
   * 工厂拿到的那个 ctx 里的 update 是**空的**（宿主建插件时不知道
   * 面板的刷新函数），真正能用的 update 是每次 open/action 时传进来的。
   * 所以这里存一份最新的，异步动作完成后才有地方通知面板。
   */
  let update = () => {};

  const pluginDir = ctx.plugin.dir;
  const windows = createWindows({
    pluginDir,
    preloadPath: join(pluginDir, 'preload', 'rec.cjs'),
  });

  const capture = createCaptureSession({
    windows,
    getOutputDir: () => (config?.outputDir || '').trim() || app.getPath('videos'),
    onState: (state) => {
      recording = state.recording;
      if (state.file) {
        status = endedNote ? `${endedNote}；已保存：${state.file}` : `已保存：${state.file}`;
      }
      if (state.error) status = `出错了：${state.error}`;
      update(buildPanelPage(ctx.ui, { config, targets, recording, status }));
    },
  });

  registerIpc((message, event) => {
    const role = windows.roleOf(event?.sender?.id);
    if (message?.type === 'ready') {
      capture.notifyReady();
    } else if (message?.type === 'saved') {
      void capture.save(message.payload.bytes, message.payload.ext).catch((err) => {
        capture.fail(`存不了文件：${err?.message || err}`);
      });
    } else if (message?.type === 'error') {
      capture.fail(message.payload?.message || '录制失败');
    } else if (message?.type === 'ended') {
      // 目标没了：记一句，等文件存好了一起显示。
      endedNote = '目标没了，录制已经停下来了';
    } else if (message?.type === 'stop' && role === 'control') {
      capture.stop();
    }
  });

  async function ensureConfig() {
    if (!config) config = await readConfig(app.getPath('userData'));
    return config;
  }

  async function save(next) {
    config = await writeConfig(app.getPath('userData'), { ...(await ensureConfig()), ...next });
    return config;
  }

  /** 面板页面。 */
  async function page(currentCtx) {
    if (currentCtx?.update) update = currentCtx.update;
    const cfg = await ensureConfig();
    return buildPanelPage(ctx.ui, { config: cfg, targets, recording, status });
  }

  /**
   * 动作排队：一个没做完，下一个别开始。
   *
   * 面板的动作是**并发**派发的（宿主不等前一个返回就发下一个），
   * 而写配置是异步的：刚改完「输出目录」就点「开始录制」，
   * 录制读到的还是旧配置——文件就落到了视频文件夹，而不是刚选的地方。
   * 排队之后，前一个动作写完了，后一个才读得到。
   */
  let chain = Promise.resolve();
  function enqueue(task) {
    const result = chain.then(task, task);
    // 链子自己不能断：前一个失败了，后一个照样要能做。
    chain = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  /**
   * 开始录制。用上次选的目标，没有就用列表里的第一个。
   *
   * 快捷键（Task 8）也走这里，所以它得是个独立的函数。
   */
  async function startRecordingInner() {
    if (capture.isRecording()) {
      status = '已经在录了';
      return;
    }
    const cfg = await ensureConfig();
    const list = await capture.listTargets(cfg.mode);
    if (!list.length) {
      status = '没有可录的目标';
      return;
    }
    const picked = list.find((t) => t.id === cfg.sourceId) || list[0];
    targets = list;
    await save({ sourceId: picked.id });
    endedNote = '';
    try {
      await capture.start({
        mode: cfg.mode,
        sourceId: picked.id,
        format: cfg.format,
        fps: cfg.fps,
        audio: { mic: cfg.mic, speaker: cfg.speaker },
      });
    } catch (err) {
      status = `开始不了：${err?.message || err}`;
    }
  }

  /** 开始录制（快捷键也走这里，所以要排队）。 */
  function startRecording() {
    return enqueue(startRecordingInner);
  }

  /** 面板里的一个动作。 */
  async function action(currentCtx, actionId, value) {
    if (currentCtx?.update) update = currentCtx.update;
    return enqueue(() => handleAction(actionId, value));
  }

  /** 动作的真身（已经在队列里了）。 */
  async function handleAction(actionId, value) {
    const cfg = await ensureConfig();
    if (actionId.startsWith('mode:')) {
      const mode = actionId.slice('mode:'.length);
      await save({ mode });
      targets = [];
      status = '';
    } else if (actionId.startsWith('format:')) {
      await save({ format: actionId.slice('format:'.length) });
    } else if (actionId === 'mic') {
      await save({ mic: value === 'true' });
    } else if (actionId === 'speaker') {
      await save({ speaker: value === 'true' });
    } else if (actionId === 'outputDir') {
      const dir = String(value || '').trim();
      await save({ outputDir: dir });
      status = dir ? `输出目录：${dir}` : '输出目录：视频文件夹';
    } else if (actionId === 'pick-dir') {
      const picked = await pickDirectory();
      if (picked) {
        await save({ outputDir: picked });
        status = `输出目录：${picked}`;
      }
    } else if (actionId === 'start') {
      await startRecordingInner();
    } else if (actionId === 'stop') {
      capture.stop();
    } else {
      status = '';
    }
    return page();
  }

  /** 选输出目录：原生对话框。 */
  async function pickDirectory() {
    const result = await dialog.showOpenDialog({
      title: '录屏文件放哪儿',
      defaultPath: (await ensureConfig()).outputDir || app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return '';
    return result.filePaths[0];
  }

  return { page, action };
}
