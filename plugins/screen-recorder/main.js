// plugins/screen-recorder/main.js
import { app, dialog, shell } from 'electron';
import { join } from 'node:path';
import { readConfig, writeConfig } from './lib/config.js';
import { buildPanelPage, MODE_LABELS } from './lib/page.js';
import { createWindows } from './lib/windows.js';
import { createCaptureSession } from './lib/capture.js';
import { createWindowIconResolver } from './lib/window-icons.js';
import { createTargetCache, targetKind } from './lib/targets.js';
import { registerIpc } from './lib/ipc.js';
import { setHotkeys, clearHotkeys } from './lib/hotkey.js';

/**
 * 录屏插件。
 *
 * 插件跑在**主进程**里（宿主用动态 import 加载它），所以 electron 的 API
 * 直接就能用——这里没有沙箱，插件与宿主之间靠的是约定，不是权限边界。
 *
 * 界面有两套：
 *
 * - **自己的页面**（pages/studio.html）：面板工作台与独立窗口装的是同一份，
 *   三个 tab、预览、抽屉都在里面。宿主只负责喂数据。
 * - **积木页面**（lib/page.js）：页面文件不在磁盘上时的退路，
 *   宿主会自动换用它，界面不会白屏。
 */
export default function createScreenRecorderPlugin(ctx) {
  /** 配置只在第一次用时读盘，之后走缓存。 */
  let config = null;
  /** 底部那行提示：做完某个动作的结果。 */
  let status = '';
  /** 附注（目标没了、没有麦克风……），存好文件时一起显示。 */
  let note = '';
  /**
   * 可录的目标（显示器/窗口），随模式变。
   *
   * **按目标的种类分桶，不按模式分桶**：模式有三个，
   * 目标只有两类（选区用的是显示器）。所以问缓存要东西的时候
   * 要说「哪个模式」，由它翻译成「哪一类目标」。
   */
  const targets = createTargetCache();
  /** 窗口列表变了就加一：变了才往界面上推（别每秒推一兆图标）。 */
  let windowsVersion = 0;
  let sentWindowsVersion = -1;
  /**
   * 屏幕预览图变了就加一：变了才往界面上推。
   *
   * 预览图每块屏几十 KB，**不能跟着每半秒的状态一起推**——
   * 那等于每秒推一遍几块屏的图。
   */
  let previewsVersion = 0;
  let sentPreviewsVersion = -1;
  /** 正在录吗。 */
  let recording = false;
  /** 已经录了多久（毫秒）。 */
  let elapsedMs = 0;
  /** 快捷键注册不成功的理由（界面上显示）。 */
  let hotkeyError = '';
  /** 界面开着吗（面板工作台或独立窗口）。 */
  let surfaceOpen = false;
  /** 上一次框的选区多大（界面上显示一句）。 */
  let regionSize = '';
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
  const icons = createWindowIconResolver();

  /**
   * 录制文件实际存到哪个文件夹。
   *
   * 没设目录就是系统的「视频」文件夹。
   * 界面上要把它显示出来——不然用户以为「留空＝不存」。
   */
  const getOutputDir = () => (config?.outputDir || '').trim() || app.getPath('videos');

  const capture = createCaptureSession({
    windows,
    getOutputDir,
    onState: (state) => {
      const wasRecording = recording;
      recording = state.recording;
      elapsedMs = state.elapsedMs || 0;
      if (state.warning) {
        note = state.warning;
        status = state.warning;
      }
      if (state.file) {
        status = note ? `${note}；已保存：${state.file}` : `已保存：${state.file}`;
      }
      if (state.error) status = `出错了：${state.error}`;
      if (state.cancelled) status = '已经停掉了';
      // 控制条上显示录制时长：它每秒都在变，所以每次都推。
      windows.sendTo('control', {
        type: 'state',
        payload: { recording, elapsedMs: state.elapsedMs || 0 },
      });
      // 录制的起落要重新算一下快捷键（录着的时候快捷键一直有效）。
      if (wasRecording !== recording) syncHotkeys();
      // **面板不要跟着计时器重画**：重画会把用户正在输入的东西抹掉
      // （输出目录框里打的字每半秒被覆盖、焦点每半秒丢一次）。
      // 只有状态**变了**才重画面板。
      const changed =
        wasRecording !== recording || state.file || state.error || state.warning || state.cancelled;
      if (!changed) return;
      update(buildPanelPage(ctx.ui, { config, targets: targets.get(config?.mode), recording, status }));
    },
  });

  /**
   * 快捷键什么时候生效。
   *
   * - **界面开着**：肯定有效（用户刚打开录屏，多半就是想用快捷键）。
   * - **打开过一次之后**：一直有效，直到插件被关掉。
   *   这一条是关键：面板失焦会**自己收起来**（用户去干别的了），
   *   若快捷键跟着界面一起关，「开始录制」这种快捷键就没有意义了——
   *   它存在的意义正是**不开界面**也能按。
   * - **录制的时候**：一定有效（不然用户没法停下来）。
   *
   * 插件刚加载时**不抢**快捷键：一个从来没人用过的录屏插件
   * 一开机就占着 Ctrl+Shift+R，很讨人厌。
   */
  let hotkeyArmed = false;
  let hotkeyState = { active: false, start: '', stop: '' };
  function syncHotkeys() {
    if (!config) return;
    const want = hotkeyArmed || recording;
    const start = config.hotkey || '';
    const stop = config.stopHotkey || '';
    // 状态没变就别重注册：重注册要把快捷键让出去再抢回来，
    // 中间那一下按键是按不上的。
    if (hotkeyState.active === want && hotkeyState.start === start && hotkeyState.stop === stop) {
      return;
    }
    hotkeyState = { active: want, start, stop };
    if (!want) {
      clearHotkeys();
      hotkeyError = '';
      return;
    }
    const result = setHotkeys([
      { accel: start, onTrigger: () => void startRecording() },
      {
        accel: stop,
        onTrigger: () => {
          if (capture.isRecording()) capture.stop();
        },
      },
    ]);
    hotkeyError = result.failed.length
      ? `快捷键 ${result.failed.join('、')} 注册不了——可能已经被别的程序占着了`
      : '';
  }

  /**
   * 盯着「插件是不是被关掉了」。
   *
   * 设置窗口里把插件关掉时，宿主会关掉**它自己**的插件窗口；
   * 我们自建的窗口它管不着——于是工作台还开着、快捷键还占着、
   * 录制还在跑。插件关了就该真的什么都不干，所以自己盯一下。
   */
  let watchTimer = null;
  function watchEnabled() {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
      if (ctx.host.isEnabled('screen-recorder')) return;
      windows.hideControl();
      windows.closeRegionFrame();
      capture.stop();
      clearHotkeys();
      // 插件被关掉了：快捷键也就不该再留着（下次打开重新武装）。
      hotkeyArmed = false;
      hotkeyState = { active: false, start: '', stop: '' };
      stopWatching();
    }, 2000);
  }

  function stopWatching() {
    if (!watchTimer) return;
    clearInterval(watchTimer);
    watchTimer = null;
  }

  // 界面开合：用户打开过录屏，快捷键就一直有效（见 syncHotkeys 的说明）。
  ctx.host.onSurfaceChange?.((pluginId, open) => {
    if (pluginId !== 'screen-recorder') return;
    surfaceOpen = Boolean(open);
    if (open) {
      hotkeyArmed = true;
      watchEnabled();
    }
    void ensureConfig().then(() => {
      syncHotkeys();
      pushPanel();
    });
  });

  // 退出前把自建的窗口都拆掉：顺序才是确定的（尤其遮罩可能正开着等用户框选）。
  // Electron 自己也会挨个关窗口，但那时候窗口关到哪个算哪个。
  app.on('before-quit', () => {
    capture.dispose();
    windows.destroyAll();
    clearHotkeys();
  });

  registerIpc(async (message, event) => {
    const role = windows.roleOf(event?.sender?.id);
    if (message?.type === 'ready') {
      capture.notifyReady();
    } else if (message?.type === 'saved') {
      void capture.save(message.payload.bytes, message.payload.ext).catch((err) => {
        capture.fail(`存不了文件：${err?.message || err}`);
      });
    } else if (message?.type === 'error') {
      // soft 的错误（比如没有麦克风）不该把整段录制废掉：提示一声，接着录。
      if (message.payload?.soft) {
        capture.warn(message.payload.message);
      } else {
        capture.fail(message.payload?.message || '录制失败');
      }
    } else if (message?.type === 'ended') {
      // 目标没了：记一句，等文件存好了一起显示。
      note = '目标没了，录制已经停下来了';
    } else if (message?.type === 'cancelled') {
      // 还没开始就停了：不算出错。
      capture.cancel();
    } else if (message?.type === 'picked') {
      windows.resolvePicker(message.payload || null);
    } else if (message?.type === 'picked-cancel') {
      windows.resolvePicker(null);
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
    syncHotkeys();
    return config;
  }

  /** 往积木面板推一份页面（自己的页面不靠它，那边有 tick）。 */
  function pushPanel() {
    update(buildPanelPage(ctx.ui, { config, targets: targets.get(config?.mode), recording, status }));
  }

  /**
   * 列可录的目标（显示器 / 窗口）。
   *
   * 列一次要半秒上下，所以**缓存起来**：切 tab 不重新列，
   * 用户要最新的自己点「刷新」。
   *
   * 传进来的是**模式**，缓存按**目标的种类**分桶——
   * 选区模式用的是显示器（见 lib/targets.js 的说明）。
   */
  async function loadTargets(mode, { force = false } = {}) {
    const { list, listed } = await targets.load(mode, (kind) => capture.listTargets(kind), {
      force,
    });
    // 只有真的列了一遍才动后面那些：没重列的话它们早就在列表里了。
    if (!listed) return list;
    if (targetKind(mode) === 'window') {
      windowsVersion += 1;
      // 图标在后台慢慢取：读一遍窗口的图标要一秒多，不能挡着界面。
      //
      // **晚一点再开始**：PowerShell 启动 + 枚举进程挺吃 CPU，
      // 与预览图那一下撞在一起，界面会明显地顿一下。
      setTimeout(() => void collectIcons(), 600);
    } else {
      // 显示器重新列了 → 预览图也换了（预览图就是列显示器时顺带抓的）。
      previewsVersion += 1;
    }
    return list;
  }

  /** 给窗口列表配图标（后台跑）。 */
  async function collectIcons() {
    const list = targets.get('window');
    if (!list.length) return;
    try {
      const map = await icons.iconsFor(list.map((t) => t.label));
      for (const item of list) {
        const icon = map.get(String(item.label || '').trim().toLowerCase());
        if (icon) item.icon = icon;
      }
    } catch (err) {
      console.warn('[录屏] 取窗口图标失败：', err?.message);
    }
    windowsVersion += 1;
  }

  /**
   * 每块屏的预览图（data URL）。
   *
   * **不走 `buildState()`**：预览图每块屏几十 KB，
   * 跟着每个动作的回包一起传就是每秒传几遍。
   * 它自己一条通道：首份数据给一次，之后变了才推。
   */
  function currentPreviews() {
    return targets.get('screen').map((t) => ({ id: t.id, preview: t.preview || '' }));
  }

  /**
   * 当前选中的是哪块屏。
   *
   * 配置里没存过（第一次用），或者存的那块已经拔掉了：
   * 就当是**列表里的第一块**（主显示器，列目标时排第一）。
   *
   * 界面上**一定要有一块是选中的**：全是灰的看不出现在录的是哪块。
   * 录的时候挑的也是这一块（见 startRecordingInner）——两处必须一致。
   */
  function effectiveScreenId(cfg) {
    const screens = targets.get('screen');
    if (!screens.length) return cfg.sourceId || '';
    return screens.find((t) => t.id === cfg.sourceId)?.id || screens[0].id;
  }

  /**
   * 界面上的一份完整状态。
   *
   * 自己的页面照着它画。**只给能序列化的东西**：
   * 界面与主进程之间过一次 IPC，函数与类实例都过不去。
   */
  async function buildState() {
    const cfg = await ensureConfig();
    return {
      mode: cfg.mode,
      format: cfg.format,
      recording,
      elapsedMs,
      status,
      hotkeyError,
      /** 快捷键现在生效吗（用户打开过录屏之后就一直生效）。 */
      hotkeysArmed: hotkeyArmed,
      outputDir: cfg.outputDir || '',
      /** 实际会存到哪儿（没设目录＝系统的视频文件夹）。 */
      outputDirResolved: getOutputDir(),
      hotkey: cfg.hotkey || '',
      stopHotkey: cfg.stopHotkey || '',
      fps: cfg.fps,
      gifWidth: cfg.gifWidth,
      gifFps: cfg.gifFps,
      mic: cfg.mic,
      micDeviceIndex: cfg.micDeviceIndex,
      speaker: cfg.speaker,
      screens: targets.get('screen').map((t) => ({
        id: t.id,
        label: t.label,
        meta: t.meta || '',
      })),
      selectedScreenId: effectiveScreenId(cfg),
      windows: targets.get('window').map((t) => ({ id: t.id, label: t.label, icon: t.icon || '' })),
      selectedWindowId: cfg.windowId || '',
      regionSize,
    };
  }

  /** 面板页面（页面文件不在时的退路）。 */
  async function page(currentCtx) {
    if (currentCtx?.update) update = currentCtx.update;
    const cfg = await ensureConfig();
    await loadTargets(cfg.mode);
    return buildPanelPage(ctx.ui, { config: cfg, targets: targets.get(cfg.mode), recording, status });
  }

  /** 标题那几个字段（自己的页面用）。**要便宜**：别在这儿列系统窗口。 */
  async function meta(currentCtx) {
    const cfg = await ensureConfig();
    return {
      title: '录屏',
      subtitle: recording ? '正在录制' : MODE_LABELS[cfg.mode] || '录屏',
      status,
    };
  }

  /** 自己页面的首份数据。 */
  async function data() {
    const cfg = await ensureConfig();
    // 两类目标**并发**列：列显示器与列窗口互不相干，
    // 排队做就是白等一倍时间（各要 0.4 秒上下）。
    await Promise.all([
      loadTargets(cfg.mode),
      loadTargets(cfg.mode === 'window' ? 'screen' : 'window'),
    ]);
    // 预览图跟着首份数据一起给：它就是列显示器时顺带抓的，
    // 已经在手里了——单独走一条通道推反而慢半拍。
    sentPreviewsVersion = previewsVersion;
    return { ...(await buildState()), previews: currentPreviews() };
  }

  /** 自己页面的周期刷新：只给会变的那些。 */
  async function tick() {
    const payload = { recording, elapsedMs, status, hotkeyError };
    // 窗口列表变了才推（里面有图标，别每秒推一遍）。
    if (windowsVersion !== sentWindowsVersion) {
      sentWindowsVersion = windowsVersion;
      payload.windows = targets.get('window').map((t) => ({ id: t.id, label: t.label, icon: t.icon || '' }));
    }
    // 预览图：每块屏几十 KB，**变了才推**。
    if (previewsVersion !== sentPreviewsVersion) {
      sentPreviewsVersion = previewsVersion;
      payload.previews = currentPreviews();
    }
    return payload;
  }

  /**
   * 自己页面里的一个动作。
   *
   * 回的是**动作之后的新状态**：界面照着它重画，
   * 不用自己猜该变成什么样（也就不会有两套同步逻辑）。
   */
  async function act(currentCtx, actionId, payload) {
    if (currentCtx?.update) update = currentCtx.update;
    return enqueue(() => handleAct(actionId, payload));
  }

  /** 动作的真身（已经在队列里了）。 */
  async function handleAct(actionId, payload) {
    const cfg = await ensureConfig();
    switch (actionId) {
      case 'mode': {
        const mode = String(payload?.mode || cfg.mode);
        if (!Object.hasOwn(MODE_LABELS, mode)) break;
        await save({ mode });
        status = '';
        // 换了模式，能录的目标也换了（显示器 / 窗口）——
        // 不列一遍的话，界面上还是上一个模式的列表。
        await loadTargets(mode);
        break;
      }
      case 'select-screen': {
        // **不重抓预览**：预览图是列显示器时一次抓齐的，
        // 选哪块屏不用再截一次屏——截一次要 0.5 秒，
        // 堵在动作里就是一次实打实的卡顿。
        await save({ sourceId: String(payload?.id || '') });
        break;
      }
      case 'select-window': {
        await save({ windowId: String(payload?.id || '') });
        break;
      }
      case 'format': {
        await save({ format: payload?.format === 'gif' ? 'gif' : 'video' });
        break;
      }
      case 'mic': {
        await save({
          mic: Boolean(payload?.on),
          micDeviceIndex: Number.isFinite(Number(payload?.index)) ? Number(payload.index) : 0,
        });
        break;
      }
      case 'speaker': {
        await save({ speaker: Boolean(payload?.on) });
        break;
      }
      case 'start':
      case 'pick-region': {
        await startRecordingInner();
        break;
      }
      case 'stop': {
        capture.stop();
        break;
      }
      case 'config': {
        const next = {};
        if (typeof payload?.outputDir === 'string') next.outputDir = payload.outputDir.trim();
        for (const key of ['fps', 'gifWidth', 'gifFps']) {
          const value = Number(payload?.[key]);
          if (Number.isFinite(value)) next[key] = value;
        }
        if (Object.keys(next).length) await save(next);
        break;
      }
      case 'hotkey': {
        const accel = String(payload?.accel || '').trim();
        if (payload?.which === 'stop') await save({ stopHotkey: accel });
        else await save({ hotkey: accel });
        break;
      }
      case 'pick-dir': {
        const dir = await pickDirectory();
        if (dir) await save({ outputDir: dir });
        break;
      }
      case 'open-dir': {
        await shell.openPath((config?.outputDir || '').trim() || app.getPath('videos'));
        break;
      }
      case 'refresh': {
        await loadTargets(cfg.mode, { force: true });
        await loadTargets(cfg.mode === 'window' ? 'screen' : 'window', { force: true });
        break;
      }
      default:
        break;
    }
    return buildState();
  }

  /**
   * 动作排队：一个没做完，下一个别开始。
   *
   * 面板的动作是**并发**派发的（宿主不等前一个返回就发下一个），
   * 而写配置是异步的：刚改完「输出目录」就点「开始录制」，
   * 录制读到的还是旧配置——文件就落到了视频文件夹，而不是刚选的地方。
   * 排队之后，前一个动作写完了，后一个才读得到。
   *
   * 顺带解决另一件事：写配置是「先写 .tmp 再改名」，
   * 两个写同时来会**抢同一个 .tmp 文件**，内容可能串。
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
   * 快捷键也走这里，所以它得是个独立的函数。
   */
  async function startRecordingInner() {
    if (!ctx.host.isEnabled('screen-recorder')) {
      status = '录屏插件已经关掉了';
      return;
    }
    if (capture.isRecording()) {
      status = '已经在录了';
      return;
    }
    const cfg = await ensureConfig();
    note = '';
    status = '';

    // 选区模式：先让用户框一块，框完才开始录。
    if (cfg.mode === 'region') {
      // 遮罩开在**用户选的那块屏**上：列表里选了哪块，就在那块上框。
      const screens = targets.get('screen');
      const chosen = screens.find((t) => t.id === cfg.sourceId) || screens[0];
      if (!chosen) {
        status = '没有可录的屏幕';
        return;
      }
      // 源 id 一并给过去：录的时候要从那块屏身上取流。
      // 让捕获那边再列一次要多花 0.5 秒，还可能列到不同的源 id。
      const region = await capture.pickRegion({
        displayId: chosen.displayId,
        sourceId: chosen.id,
      });
      if (!region) {
        status = '没选区域';
        return;
      }
      regionSize = `${region.crop.width} × ${region.crop.height}`;
      await save({ sourceId: region.sourceId });
      try {
        await capture.start({
          mode: 'region',
          sourceId: region.sourceId,
          format: cfg.format,
          fps: cfg.fps,
          gif: { width: cfg.gifWidth, fps: cfg.gifFps },
          audio: { mic: cfg.mic, speaker: cfg.speaker, micDeviceIndex: cfg.micDeviceIndex },
          crop: region.crop,
          snapshotSize: region.snapshotSize,
        });
      } catch (err) {
        status = `开始不了：${err?.message || err}`;
      }
      return;
    }

    const list = await loadTargets(cfg.mode);
    if (!list.length) {
      status = '没有可录的目标';
      return;
    }
    const picked =
      cfg.mode === 'window'
        ? list.find((t) => t.id === cfg.windowId) || list[0]
        : list.find((t) => t.id === cfg.sourceId) || list[0];
    if (cfg.mode === 'window') await save({ windowId: picked.id });
    // 显示器也存一下：存的与录的一致，下次打开还是这一块。
    else await save({ sourceId: picked.id });
    try {
      await capture.start({
        mode: cfg.mode,
        sourceId: picked.id,
        format: cfg.format,
        fps: cfg.fps,
        gif: { width: cfg.gifWidth, fps: cfg.gifFps },
        audio: { mic: cfg.mic, speaker: cfg.speaker, micDeviceIndex: cfg.micDeviceIndex },
      });
    } catch (err) {
      status = `开始不了：${err?.message || err}`;
    }
  }

  /** 开始录制（快捷键也走这里，所以要排队）。 */
  function startRecording() {
    return enqueue(startRecordingInner);
  }

  /** 积木页面里的一个动作（自己的页面不走这条）。 */
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
      status = '';
      // 换了模式，能录的目标也换了（显示器 / 窗口）——
      // 不重新列一遍的话，界面上还是上一个模式的列表。
      await loadTargets(mode);
    } else if (actionId.startsWith('format:')) {
      await save({ format: actionId.slice('format:'.length) });
    } else if (actionId === 'mic') {
      await save({ mic: value === 'true' });
    } else if (actionId === 'speaker') {
      await save({ speaker: value === 'true' });
    } else if (actionId === 'start') {
      await startRecordingInner();
    } else if (actionId === 'stop') {
      capture.stop();
    } else if (actionId === 'select-target') {
      // 点了目标列表里的某一项：它就是这次要录的东西。
      // 窗口与显示器各记各的（两个模式的「上次选的」不是一回事）。
      const id = String(value || '');
      if (cfg.mode === 'window') await save({ windowId: id });
      else await save({ sourceId: id });
      status = '选了要录的目标';
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

  return { page, action, meta, data, tick, act };
}
