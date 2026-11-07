import { app, screen, dialog, BrowserWindow, shell, globalShortcut } from 'electron';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { registerSchemePrivileges, registerAppProtocol, appUrl } from './protocol.js';
import {
  USER_MODELS_URL_PREFIX,
  userModelsDir,
  readMergedRegistry,
  importModelDir,
  deleteImportedModel,
  removeBundledModel,
} from './live2dModels.js';
import { USER_PLUGINS_URL_PREFIX, userPluginsDir } from './plugins/paths.js';
import { createPetWindow, applySettingsToWindow, applyScaleToWindow } from './window.js';
import { createTray } from './tray.js';
import { buildContextMenu, buildTrayMenu } from './menu.js';
import { registerIpc } from './ipc.js';
import { loadSettings, saveSettings, sanitizeSettings } from './settings.js';
import { createBubbleController } from './bubble.js';
import { createPanelController } from './panel.js';
import { createPluginHost } from './plugins/host.js';
import { createPluginWindowController } from './plugins/window.js';
import { createSurfaceController } from './plugins/surface.js';
import { createAppIndex } from './apps.js';
import { createAssistant } from './assistant/index.js';
import { createSystemController } from './system.js';
import { visibleRectOnScreen } from '../shared/petRect.js';
import { makeHotkeyCapture } from './hotkeyCapture.js';
import { apiKeyStatus, saveApiKey, llmKeyStatus, saveLlmApiKey } from './credentials.js';
import { SUGGESTED_VOICES } from './assistant/tts/voices.js';
import { buildTapVoicePayload } from '../shared/tapVoice.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

if (process.env.DESK_PET_USER_DATA) {
  // setPath 要求目标目录已存在，否则会抛错（Task 1 的 E2E 用例依赖这一点）。
  mkdirSync(process.env.DESK_PET_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.DESK_PET_USER_DATA);
}
registerSchemePrivileges();

const IS_E2E = Boolean(process.env.DESK_PET_E2E);
if (!IS_E2E && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let settings = null;
let saveTimer = null;
// 气泡窗口与桌面助理：第二、三部分（交互与动作系统 / 桌面助理功能）。
let bubble = null;
let assistant = null;
// 插件面板与插件注册表：双击桌宠弹出来的那个搜索框。
let panel = null;
let plugins = null;
// 插件的独立窗口与桌面小部件。
let pluginWindows = null;
// 界面路由：面板工作台与独立窗口都是「界面落点」。
let pluginSurfaces = null;
// 本机程序索引：搜索框里能搜到本机的程序，回车就启动。
let apps = null;
// 最后一次施加到窗口上的透明度：用来避免重复调用原生接口。
let appliedOpacity = null;
// 设置窗口全局只有一个：重复打开时聚焦已有的那个，而不是开一堆。
let settingsWin = null;
// 正在进行的写入。防抖计时器触发后 saveTimer 会被置空，
// 但写入可能还没落盘完成——只盯 saveTimer 会漏掉这个窗口。
let pendingWrite = null;
// 系统级开关的控制器（第六部分）。
let system = null;
// 桌宠**本体**的可见矩形（窗口内坐标）：渲染层量出来，主进程据此夹紧位置。
//
// 桌宠窗口是一块固定大小的画布，Live2D 贴图四周有透明留白，
// 于是小模型的上半截窗口是空的。夹紧、吸附、停靠、气泡摆位
// 全部按本体算——否则小模型永远差一截才贴得到屏幕边。
let visibleRect = null;
// E2E 下的「Windows 登录项」替身：记住最后一次写进去的值。
// 真实实现读的是注册表，E2E 不碰注册表（见下面 loginItem 的注释），
// 但 `get()` 仍要有个东西可返回——否则「磁盘与系统登录项是否一致」
// 这条检查在 E2E 里会永远报不一致。
//
// 它是**进程内**的：重启后回到 false，而真实的注册项是持久的。
// 所以「磁盘写着 true、重启后登录项却是 false」在 E2E 里会出现——
// 那是替身不持久，不是缺陷。
let e2eLoginItem = { openAtLogin: false };

// E2E 下登记的全局快捷键：accelerator → 回调。
//
// 系统级的快捷键**按不了**（Playwright 的合成按键不经过系统层），
// 所以 E2E 不真的注册它们——但把回调记在这里，
// 测试就能「按一下」：globalThis.__e2eShortcuts.get('Control+Shift+F')()。
let e2eShortcuts = new Map();
if (IS_E2E) {
  globalThis.__e2eShortcuts = e2eShortcuts;
}

// 显示器列表缓存：拖拽时每一帧都要用它夹紧窗口（60Hz），
// 而 getPrimaryDisplay()/getAllDisplays() 每次都是同步的跨进程查询——
// 每帧问一遍 Electron 既慢又没有意义。显示器拓扑变化时缓存失效即可。
let displayCache = null;

function currentDisplays() {
  if (displayCache) return displayCache;
  // 主显示器必须排在第一位：display.js 的 defaultPosition 依赖 displays[0] 是主显示器，
  // 而 Electron 的 getAllDisplays() 并不保证这一点。
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  displayCache = [primary, ...all.filter((d) => d.id !== primary.id)].map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
  }));
  return displayCache;
}

/** 显示器拓扑/尺寸变化：缓存的列表不再可信，丢掉让下次重新读取。 */
function invalidateDisplayCache() {
  displayCache = null;
}

// ---------------------------------------------------------------------------
// 光标跟踪：让桌宠在鼠标不在它身上时也看着鼠标
//
// 之前只有指针**经过桌宠窗口**时才会跟随（渲染层的 pointermove）。
// 桌宠站在屏幕角落、鼠标在另一边时，它就「眼神空洞」地看着正前方——
// 这是桌宠最该有的细节之一，值得单独做一个轮询。
//
// 10Hz 足够：Live2D 的 FocusController 自己会做平滑。
// ---------------------------------------------------------------------------

const CURSOR_POLL_MS = 100;
let cursorTimer = null;

function startCursorTracking() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    // 渲染进程可能已经被拆掉了（退出时就会这样）：
    // 往一个已销毁的 frame 发送会抛 "Render frame was disposed"。
    if (win.webContents.isDestroyed()) return;
    // getCursorScreenPoint() 与 win.getPosition() 都是 DIP，同一套坐标系。
    // 换算在主进程做：渲染层那边的 window.screenX 是 Chromium 的另一套 DIP，
    // 两套是否等价从未被验证过（拖拽路径是刻意只传增量的，见 decisions.md）。
    const point = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    win.webContents.send('pet:cursorPoint', { x: point.x - wx, y: point.y - wy });
  }, CURSOR_POLL_MS);
}

/**
 * 读取形象注册表（内置 + 用户导入），并把条目**规整**成可用形状。
 *
 * 实现在 src/main/live2dModels.js：内置的读 assets/live2d/index.json，
 * 导入的读 userData/live2d/registry.json，两边合成同一个形状
 * （都带 base / source），渲染层于是不必关心某个形象是哪来的。
 */
async function readModelRegistry() {
  return readMergedRegistry(ROOT, app.getPath('userData'));
}

function persist(patch) {
  // 必须过一遍 sanitizeSettings：否则渲染层传来的越界值（例如 opacity=1.5）
  // 会留在内存里，而落盘时被夹紧——内存与磁盘不一致，
  // getSettings 会把越界值发回渲染层，Task 9 还会拿它去调 win.setOpacity()。
  const prevScale = settings.scale;
  settings = sanitizeSettings({ ...settings, ...patch });
  // 缩放变了：窗口尺寸必须跟着变。
  //
  // 桌宠窗口是无边框的——窗口有多大，模型才能画多大。
  // 窗口不变而模型放大，模型的上半身就被窗口边界切掉了。
  // 尺寸的事必须在这里做：落盘是 300ms 之后的事，生效是现在。
  if (settings.scale !== prevScale) {
    const bounds = applyScaleToWindow(win, settings.scale, currentDisplays(), visibleRect);
    // 窗口尺寸变了，保存的左上角也不再指向同一个锚点：跟着更新。
    if (bounds) settings.position = { x: Math.round(bounds.x), y: Math.round(bounds.y) };
  }
  // 透明度由主进程直接施加在**宠物窗口**上（win.setOpacity）。
  // 必须在 persist 里做：设置可能来自设置窗口的滑块、也可能来自别处，
  // 落盘只是持久化，不等于已经生效。
  //
  // 只有透明度**真的变了**才调原生接口：persist 在拖拽的每一帧都会被调用，
  // 而拖拽过程中透明度根本不变——每次都发一次 win.setOpacity() 是在最热的路径上做无用功。
  if (win && !win.isDestroyed() && settings.opacity !== appliedOpacity) {
    applySettingsToWindow(win, settings);
    appliedOpacity = settings.opacity;
  }
  // 系统级开关要立刻生效：落盘是 300ms 之后的事，生效是现在。
  system?.applySettings?.(settings);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSettings();
  }, 300);
  return settings;
}

/**
 * 把新设置广播给所有渲染层。
 *
 * 宠物窗口靠它即时应用缩放；设置窗口靠它把下拉框与滑块同步回来
 * （切换形象后落地的 id 可能与请求的不同）。
 */
function broadcastSettings(next) {
  const targets = [];
  if (win && !win.isDestroyed()) targets.push(win);
  if (settingsWin && !settingsWin.isDestroyed()) targets.push(settingsWin);
  for (const w of targets) {
    w.webContents.send('pet:settingsChanged', next);
  }
}

/**
 * 记下桌宠本体的可见矩形（并落盘）。
 *
 * 为什么要落盘：窗口有一部分在屏幕外是**正常状态**
 * （用户把角色拖到了屏幕顶，模型上方那块透明留白自然就在屏幕外）。
 * 下次启动要按本体判定位置是否有效——按窗口判会把「拖到顶」
 * 判成「显示器被拔掉了」，悄悄把桌宠挪回右下角。
 *
 * 不广播：渲染层不需要知道这个值，广播只会让每个窗口都白跑一趟。
 */
function persistVisibleRect(rect) {
  if (
    !rect ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return;
  }
  const next = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const prev = settings?.visibleRect;
  if (
    prev &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.width === next.width &&
    prev.height === next.height
  ) {
    return;
  }
  settings = sanitizeSettings({ ...settings, visibleRect: next });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSettings();
  }, 300);
}

/**
 * 桌宠本体在屏幕上的矩形（气泡与面板摆在它旁边）。
 *
 * 量不出来时返回 null：调用方会退回整块窗口。
 */
function petVisibleRect() {
  if (!win || win.isDestroyed()) return null;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  return visibleRectOnScreen({ x, y, width: w, height: h }, visibleRect);
}

/**
 * 把请求的形象 id 解析成注册表里真实存在的 id。
 *
 * 回退规则必须与渲染层 loadManifest 一致（取注册表第一项）：
 * 两边规则不同的话，设置窗口显示的形象与桌面上跑的就对不上。
 */
function resolveModelId(models, modelId) {
  if (!Array.isArray(models) || models.length === 0) return modelId;
  const found = models.find((m) => m && m.id === modelId);
  return found ? found.id : models[0].id;
}

// ---------------------------------------------------------------------------
// 形象切换：主进程 ↔ 渲染层 的回执协议
//
// 为什么必须有回执：主进程不能自己知道模型加载成功与否。
// 渲染层加载失败时只写自己的 window.__pet.switchError，主进程收不到，
// 于是磁盘上的 modelId 指向一个**没上屏**的形象，而设置窗口照样显示
// 「已切换到 …」——用户看到的是「Natori」，桌面上跑的是 Haru。
// spec §4.5 第 4 步要求「失败则回滚到原形象并提示」。
// ---------------------------------------------------------------------------

// 渲染层回执的超时：超时按失败处理（磁盘上不落新 id）。
//
// 12 秒而不是 30 秒：切换一次模型（加载 model3.json + moc3 + 2048² 贴图）
// 在正常机器上也就一两秒；渲染层真的一动不动时，让设置窗口的下拉框
// 干等 30 秒体验极差，而多等的那 18 秒并不会让模型突然加载成功。
const SWITCH_ACK_TIMEOUT_MS = 12000;

// 渲染层是否已经注册好监听器。
//
// Electron 的 webContents.send 对**尚未注册监听器**的渲染层是丢弃而不是排队：
// 启动期间（首次 mountModel 要加载 model3.json + moc3 + 2048² 贴图，
// 约 0.5~2 秒）发出去的切换请求会凭空消失——磁盘写着 Natori、屏幕上是 Haru。
let rendererReady = false;

// 切换请求序号：回执必须能对回具体的那一次请求（并发切换不能串台）。
let switchCounter = 0;

// 等待回执的切换请求：requestId → { resolve, delivered, modelId }。
const pendingSwitches = new Map();

/** 把一次切换请求发给渲染层。渲染层不在时返回 false（请求留在待发队列里）。 */
function deliverSwitch(requestId, modelId) {
  if (!win || win.isDestroyed()) return false;
  win.webContents.send('pet:modelSwitchRequest', { requestId, modelId });
  return true;
}

/** 渲染层注册好监听器了：把启动期间积压的请求补发出去。 */
function deliverPendingSwitches() {
  for (const [requestId, entry] of pendingSwitches) {
    if (entry.delivered) continue;
    if (deliverSwitch(requestId, entry.modelId)) entry.delivered = true;
  }
}

/**
 * 请求渲染层切换形象，并等待它的回执。
 *
 * @returns {Promise<object|null>} 渲染层的回执；超时返回 null（按失败处理）。
 */
function requestModelSwitch(modelId) {
  const requestId = ++switchCounter;
  return new Promise((resolve) => {
    let timer = null;
    const finish = (result) => {
      if (timer) clearTimeout(timer);
      pendingSwitches.delete(requestId);
      resolve(result);
    };
    const entry = { resolve: finish, delivered: false, modelId };
    pendingSwitches.set(requestId, entry);
    if (rendererReady && deliverSwitch(requestId, modelId)) entry.delivered = true;
    // 渲染层没回执（页面崩了 / 模型加载卡死）：不能让磁盘上的 id
    // 指向一个没上屏的形象，超时后按失败处理。
    timer = setTimeout(() => finish(null), SWITCH_ACK_TIMEOUT_MS);
  });
}

/** 渲染层的切换回执：把结果交给等待它的那次请求。 */
function onModelSwitchResult(result) {
  const entry = pendingSwitches.get(result?.requestId);
  if (!entry) return;
  entry.resolve(result);
}

/**
 * 切换到某个形象：等渲染层回执，**确认上屏了**才落盘。
 *
 * 「切换形象」和「导入模型后自动切换」共用这一条路径——两条路径的
 * 失败语义必须一样，否则会出现「导入成功了但桌宠没换」或者
 * 「磁盘上的 id 指向一个没上屏的形象」。
 */
async function switchModelTo(modelId) {
  // 空 id（''/undefined/null）不是「切换到某个形象」，而是「没有指定」。
  //
  // resolveModelId 会把任何不认识的 id 都映射到 models[0].id，
  // 于是 switchModelTo('') 会把一个存得好好的 modelId 覆盖成第一个形象——
  // 原来的 persist({ modelId }) 原样落盘，反而不会动它。
  // 所以这里必须把「没有 id」当成「不变」：返回当前 id，什么都不持久化。
  if (typeof modelId !== 'string' || modelId === '') {
    return { ok: true, modelId: settings.modelId };
  }
  // 先按注册表解析：请求了不存在的 id 时落地的其实是回退后的那个。
  // 落盘与广播都用解析后的 id，设置窗口的下拉框才不会与桌面上跑的形象脱节。
  const models = await readModelRegistry();
  const resolved = resolveModelId(models, modelId);
  // 等渲染层回执再决定落盘什么：**不能**先落盘——
  // 加载失败时磁盘上的 id 会指向一个没上屏的形象（spec §4.5 第 4 步）。
  const ack = await requestModelSwitch(resolved);
  if (!ack) {
    // 超时：渲染层没有回执。磁盘上的 modelId 保持不变——
    // 它至少还指向「上一次成功上屏」的那个形象。
    return { ok: false, modelId: settings.modelId, error: '渲染层未在超时时间内回应切换请求' };
  }
  if (ack.ok) {
    // 成功：落盘渲染层**真正上屏**的 id（渲染层可能回退到别的形象）。
    persist({ modelId: ack.modelId || resolved });
    broadcastSettings(settings);
    return { ok: true, modelId: settings.modelId };
  }
  // 被后来的请求顶掉：什么都不落盘，由那一次请求的结果决定。
  // superseded 标记让设置窗口**不弹失败提示**——这只是一次正常的抢占，
  // 后面那次请求的结论才是用户该看到的（否则会先看到一条假的失败）。
  if (ack.superseded) {
    return {
      ok: false,
      superseded: true,
      modelId: settings.modelId,
      error: '该切换请求已被更新的请求取代',
    };
  }
  // 失败：回滚。磁盘上的 modelId 必须回到**屏幕上那个**形象。
  // 失败必须留痕：否则用户看到的只是「桌宠没换」，却没有任何线索。
  console.warn('[desk-pet] 形象切换失败：', ack.error || '未知原因');
  const onScreen = typeof ack.modelId === 'string' && ack.modelId !== '' ? ack.modelId : null;
  if (onScreen) {
    persist({ modelId: onScreen });
  } else {
    // 屏幕上什么都没有（连启动时的模型都没上屏）：把 id 回退到注册表首项，
    // 否则下次启动会再次加载同一个坏模型，桌宠永久空白。
    const fallback = models[0]?.id;
    if (fallback) persist({ modelId: fallback });
  }
  broadcastSettings(settings);
  return { ok: false, modelId: settings.modelId, error: ack.error || '模型加载失败' };
}

/**
 * 这个 IPC 是不是设置窗口发来的。
 *
 * 导入/删除会弹出**原生**对话框，属于用户可见的动作：不能让桌宠窗口
 * （或者任何别的渲染层）把它拉起来。渲染层不是可信边界。
 */
function isSettingsSender(event) {
  if (!settingsWin || settingsWin.isDestroyed()) return false;
  return event?.sender === settingsWin.webContents;
}

/**
 * 形象列表变了：通知设置窗口重新拉取注册表、刷新下拉框。
 *
 * modelId 是**刷新后应当选中的**那个形象：刷新是异步的，
 * 而设置广播可能先到也可能后到，两条消息各说各的就会打架。
 * 把该选哪个一并告诉设置窗口，两条消息到达的先后就无所谓了。
 */
function notifyModelsChanged(modelId) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('pet:modelsChanged', modelId);
  }
}

/**
 * 导入一个 Live2D 模型目录。
 *
 * 流程：选文件夹 → 复制到 userData → 校验 → 注册 → 切过去。
 * 导入完直接切到新模型：让用户立刻看到效果，而不是「导入成功但桌宠没变」。
 */
async function importModel(event) {
  if (!isSettingsSender(event)) {
    return { ok: false, error: '只有设置窗口可以导入模型' };
  }
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
  const options = {
    title: '选择 Live2D 模型文件夹',
    // 只要文件夹：Live2D 模型是以「一个目录」的形式分发的
    // （model3.json + moc3 + 纹理 + 动作 + 表情），选单个文件必然缺零件。
    properties: ['openDirectory'],
  };
  let picked;
  try {
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    picked = result.filePaths[0];
  } catch (err) {
    return { ok: false, error: `无法打开文件夹选择器：${err?.message || err}` };
  }

  let model;
  try {
    model = await importModelDir({
      sourceDir: picked,
      rootDir: ROOT,
      userDataDir: app.getPath('userData'),
      onProgress: (p) => {
        if (settingsWin && !settingsWin.isDestroyed()) {
          settingsWin.webContents.send('pet:importProgress', p);
        }
      },
    });
  } catch (err) {
    // 导入失败必须留痕：否则用户只看到一句「导入失败」，无从排查。
    console.warn('[desk-pet] 模型导入失败：', err?.message);
    return { ok: false, error: err?.message || String(err) };
  }

  // 注册表变了：设置窗口的下拉框要重新填（它不知道新形象的 id）。
  // 选中新形象：导入完就该跑它。
  notifyModelsChanged(model.id);

  const switched = await switchModelTo(model.id);
  if (!switched.ok) {
    // 模型**已经在库里**了，只是没切过去：这不是导入失败，
    // 要分开说，否则用户会去重复导入一遍。
    return {
      ok: true,
      model,
      switched: false,
      error: `模型已导入，但切换失败：${switched.error || '未知原因'}`,
    };
  }
  return { ok: true, model, switched: true };
}

/**
 * 删除一个形象：导入的删文件，预制的从列表里移除。
 *
 * 两种「删除」的后果不同，确认框必须说清楚：
 *   - 导入的：模型文件从 userData 里消失，没法撤销；
 *   - 预制的：只把它从形象列表里去掉（记进 userData 的清单），
 *     程序目录里的模型文件仍然保留——装到 Program Files 下也没写权限，
 *     内置注册表更不该被改写。
 *
 * 删除前一律要原生确认：一次点击不该就删掉。
 */
async function deleteModel(event, modelId) {
  if (!isSettingsSender(event)) {
    return { ok: false, error: '只有设置窗口可以删除模型' };
  }
  const models = await readModelRegistry();
  const entry = models.find((m) => m.id === modelId);
  if (!entry) {
    return { ok: false, error: `未找到形象：${modelId}` };
  }

  // 至少要留下一个形象：一个都没有的话桌宠窗口里什么也画不出来，
  // 而恢复内置形象的办法（清 userData 里的清单）用户未必知道。
  if (models.length <= 1) {
    return { ok: false, error: '至少要保留一个形象——删掉最后一个就没有形象可用了。' };
  }

  const isBundled = entry.source === 'bundled';
  const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
  const options = {
    type: 'warning',
    title: isBundled ? '移除预制形象' : '删除模型',
    message: isBundled ? `确定移除「${entry.name}」吗？` : `确定删除「${entry.name}」吗？`,
    detail: isBundled
      ? '它会从形象列表里消失。模型文件仍保留在程序目录中，清空用户数据目录里的 live2d/removed.json 可让它重新出现。'
      : '模型文件会从用户数据目录中移除，无法撤销。',
    buttons: ['取消', isBundled ? '移除' : '删除'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  let confirmed;
  try {
    const result = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    confirmed = result.response === 1;
  } catch (err) {
    return { ok: false, error: `无法显示确认框：${err?.message || err}` };
  }
  if (!confirmed) return { ok: false, canceled: true };

  // 正在用的是它：先切走再删。
  // 反过来的话桌宠还挂在那个已经被删掉的模型上——纹理已经在显存里，
  // 暂时看不出问题，但下次重载或切换就会失败。
  if (settings.modelId === entry.id) {
    // 备用形象必须排除**正在删的这个**：它也在 models 里，
    // 直接取第一个就会切回一个即将消失的形象。
    const fallback = models.find((m) => m.id !== entry.id)?.id;
    if (!fallback) {
      return { ok: false, error: '没有可以切换过去的其它模型，删除已取消。' };
    }
    const switched = await switchModelTo(fallback);
    if (!switched.ok) {
      return {
        ok: false,
        error: `切换到备用模型失败，删除已取消：${switched.error || '未知原因'}`,
      };
    }
  }

  try {
    if (isBundled) {
      await removeBundledModel({ id: entry.id, userDataDir: app.getPath('userData') });
    } else {
      await deleteImportedModel({ id: entry.id, userDataDir: app.getPath('userData') });
    }
  } catch (err) {
    console.warn('[desk-pet] 模型删除失败：', err?.message);
    return { ok: false, error: err?.message || String(err) };
  }
  // 删掉的形象可能正是当前在用的那个，主进程已经把它切走了——
  // 告诉设置窗口现在该选哪个。
  notifyModelsChanged(settings.modelId);
  broadcastSettings(settings);
  // modelId 一并带回去：设置窗口刷新下拉框时据此决定选中项，
  // 不必自己猜「删完之后桌宠跑的是哪个」。
  return { ok: true, id: entry.id, name: entry.name, modelId: settings.modelId };
}

/**
 * 把总音量推给宠物窗口。
 *
 * 音量作用在渲染层的主增益上，所以主进程只管「把值送过去」。
 */
function pushVolume() {
  if (!win || win.isDestroyed()) return;
  const volume = assistant?.getState()?.sound?.volume;
  if (typeof volume !== 'number') return;
  win.webContents.send('pet:volume', { volume });
}

/**
 * 把「点桌宠时的声音」池子的成分推给宠物窗口。
 *
 * 抽签在渲染层做（静音模型声音的决定必须赶在动作启动之前，
 * 而动作是点击那一刻同步触发的——主进程来不及回话），
 * 所以主进程只负责把「池子里有什么」送过去。
 *
 * 「有没有 Key」是异步的：key 存在本机，主进程读得到，渲染层读不到。
 */
async function pushTapVoice() {
  if (!win || win.isDestroyed()) return;
  const state = assistant?.getState();
  const keyStatus = await apiKeyStatus(app.getPath('userData'), ROOT).catch(() => ({
    configured: false,
  }));
  const payload = buildTapVoicePayload({
    tapTalk: state?.tapTalk,
    ttsEnabled: state?.tts?.enabled,
    hasKey: keyStatus.configured,
  });
  win.webContents.send('pet:tapVoice', payload);
}

/** 渲染层就绪：补发积压的切换请求，并重新广播一次设置。 */
function onRendererReady() {
  rendererReady = true;
  deliverPendingSwitches();
  // 启动期间到达的设置广播同样可能被丢弃（监听器那时还没注册），
  // 重新广播一次当前设置：缩放/透明度/形象 id 都以这一刻的为准。
  broadcastSettings(settings);
  // 音效开关也要在这里发一次：渲染层的提示音**默认是开的**，
  // 而用户可能在上一轮会话里把它关掉了。
  // 早于这一刻发是发不到的——监听器那时还没注册（webContents.send 会被丢弃）。
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:soundEnabled', {
      enabled: assistant?.getState()?.sound?.enabled !== false,
    });
  }
  // 音量也一样要在这一刻补发一次：渲染层的监听器在那之前还没注册，
  // 发过去的推送会被丢弃（decisions.md #23 记过这个坑）。
  pushVolume();
  // 「点桌宠时的声音」池子同理：渲染层要靠它决定这一次出声还是不出声。
  void pushTapVoice();
}

/**
 * 渲染层报告「模型加载失败」或「渲染层自身崩溃」。
 *
 * 渲染层的 console.* 不进终端：用户在 `npm start` 里只会看到一份干净的日志
 * 和一个全透明的空窗口——完全不可见的失败。
 * 所以失败必须由主进程留痕：终端里一条 console.error，用户看得见。
 *
 * **kind 必须区分开**：只有真正的模型加载失败才回退磁盘上的 modelId。
 * 渲染层因为别的原因崩溃时，模型可能好好的——那时回退 modelId
 * 会把用户选好的形象悄悄丢掉，换成一个他没选过的。
 */
function onModelError(info) {
  const kind = typeof info === 'object' && info?.kind ? info.kind : 'model-load';
  const isModelLoad = kind === 'model-load';
  const message = typeof info === 'string' ? info : info?.message || String(info);
  if (isModelLoad) {
    console.error('[desk-pet] 模型加载失败：', message);
  } else {
    console.error('[desk-pet] 渲染层异常：', message);
  }
  if (!IS_E2E) {
    // 弹窗让失败在界面上也看得见（不阻塞主进程）。
    dialog
      .showMessageBox({
        type: 'error',
        title: isModelLoad ? '桌面宠物 · 模型加载失败' : '桌面宠物 · 渲染层异常',
        message: isModelLoad ? '桌宠模型加载失败' : '桌宠渲染层发生异常',
        detail: isModelLoad
          ? `${message}\n\n` +
            '若还没有下载官方样例资源，请先在项目目录执行 npm run setup；' +
            '若模型文件不完整，删除 assets/live2d/models/ 下的对应目录后重跑 npm run setup。'
          : `${message}\n\n` +
            '这是渲染层的问题，与模型文件无关；磁盘上选择的形象不会被改动。' +
            '若持续出现，请重启应用。',
        buttons: ['知道了'],
      })
      .catch(() => {});
  }
  if (!isModelLoad) {
    // 不是模型加载失败：不动磁盘上的 modelId。
    return;
  }
  // 磁盘上的 modelId 指向一个加载不了的形象 → 下次启动还是空白，
  // 而用户根本不知道该删哪个文件。回退到注册表首项（应用自己的默认值），
  // 让下一次启动有机会把桌宠显示出来。
  void resetModelIdToFallback();
}

/** 把磁盘上的 modelId 回退到注册表首项（加载失败后的兜底）。 */
async function resetModelIdToFallback() {
  const models = await readModelRegistry();
  const fallback = models[0]?.id;
  if (!fallback || settings?.modelId === fallback) return;
  console.warn(`[desk-pet] modelId 回退到默认形象 ${fallback}（原值加载失败）`);
  persist({ modelId: fallback });
  broadcastSettings(settings);
}

function writeSettings() {
  // 串行化：若上一次写入还没落盘，新的写入必须排在它后面。
  // 否则两次写入重叠时，先发的旧内容可能后落盘，把新设置覆盖掉。
  const p = (pendingWrite || Promise.resolve())
    .catch(() => {})
    .then(() => saveSettings(app.getPath('userData'), settings))
    .catch((err) => {
      // 写失败必须留痕：用户改了设置没生效，却既没有现象也没有日志，无从排查。
      console.warn('[desk-pet] settings 保存失败：', err?.message);
    })
    .finally(() => {
      if (pendingWrite === p) pendingWrite = null;
    });
  pendingWrite = p;
  return p;
}

// 退出前把待写入的设置落盘——否则用户在 300ms 防抖窗口内退出，改动就丢了。
// before-quit 的处理器是同步的，异步写盘不会被等待——所以必须 preventDefault
// 拦住退出，等写完再 app.quit()。
function flushPendingSave(event) {
  // 要覆盖两种情况：还有防抖计时器没触发；或者写入已经在进行中。
  // 只看 saveTimer 不够——计时器触发后会把 saveTimer 置空，
  // 此刻退出的话 writeFile 已经把文件截断成 0 字节却还没写完。
  //
  // 助理的待办/提醒也是防抖写的，同样要在这里一起落盘——
  // 否则用户在 300ms 内退出，刚加的待办就没了。
  const assistantWrite = assistant?.flush?.() || null;
  if (!saveTimer && !pendingWrite && !assistantWrite) return;
  event.preventDefault();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeSettings();
  }
  const wait = Promise.all([pendingWrite || Promise.resolve(), assistantWrite || Promise.resolve()]);
  wait.finally(() => app.quit());
}

function toggleVisible() {
  if (!win) return;
  const next = !win.isVisible();
  if (next) {
    // 召唤桌宠 = 想看见它：停靠中的桌宠先取回来，
    // 否则用户召唤来的是一条 24px 的窄边。
    system?.retrievePet?.();
    win.showInactive();
  } else {
    win.hide();
  }
  persist({ visible: next });
}

/**
 * 唤醒输入框：把插件面板叫出来，焦点落在它的输入框上。
 *
 * 桌宠被藏着时先把它请出来——面板是摆在桌宠旁边的，
 * 桌宠不在的话用户看到的是一块悬空的输入框。
 */
function openInputBox() {
  if (win && !win.isDestroyed() && !win.isVisible()) {
    // 召唤桌宠 = 想看见它：停靠中的桌宠先取回来，
    // 否则用户召唤来的是一条 24px 的窄边。
    system?.retrievePet?.();
    win.showInactive();
    persist({ visible: true });
  }
  openPanel();
}

function openSettings() {
  // 设置窗口是单例：重复打开只聚焦已有窗口。
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  // 普通边框窗口：需要标题栏与关闭按钮，
  // 因此不是透明、不是无边框、也不置顶。
  //
  // 宽度 640：左边是分区目录（190），右边是内容区。
  // 高度 720：原来的 760 加上标题栏已经超过 768 高的屏幕，
  // 窗口本来就在屏幕外——降到 720 才装得下。
  settingsWin = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 460,
    minHeight: 420,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: '桌面宠物 · 设置',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(ROOT, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 快捷键录制：主进程接管按键捕获。
  //
  // 用 before-input-event 而不是渲染层的 keydown：它给的是
  // {key, control, alt, shift, meta}，正好是拼加速键串要的东西，
  // 而且能 preventDefault——不然那一次按键会漏进页面的输入框
  // （规格 §4.3②）。
  //
  // 处理器在 src/main/hotkeyCapture.js 里：这段接线是「全局快捷键」
  // 唯一的按键入口，而它在浏览器里按不出来（Playwright 的合成按键
  // 不经过 before-input-event），所以必须能单测。
  settingsWin.webContents.on('before-input-event', makeHotkeyCapture(system));
  settingsWin.loadURL(appUrl('/src/settings/index.html'));
  // 关掉设置窗口不退出应用：宠物窗口还在（顶多是被隐藏），
  // window-all-closed 不会因为它而触发。
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

/**
 * 托盘菜单与右键菜单共用的动作表。
 *
 * 两处各写一份的后果很具体：加一个动作要改两处，
 * 漏一处就是「托盘菜单里那个项点了没反应」。
 */
function menuActions() {
  return {
    toggleVisible,
    openSettings,
    quit: () => app.quit(),
    toggleClickThrough: () => system?.toggleClickThrough?.(),
    isClickThrough: () => settings?.clickThrough === true,
    isDocked: () => system?.getState?.().dock != null,
    retrievePet: () => system?.retrievePet?.(),
  };
}

/**
 * 重建托盘菜单。
 *
 * 托盘菜单**只在启动时构建一次**，所以「鼠标穿透」的勾选状态、
 * 「取回桌宠」的出现与消失都靠重建来同步——否则菜单会一直显示旧状态。
 */
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu(menuActions()));
}

function showContextMenu() {
  if (!win) return;
  buildContextMenu(menuActions()).popup({ window: win });
}

/**
 * 打开插件面板：双击桌宠时走这条路。
 *
 * 面板**懒创建**（见 src/main/panel.js）：它就摆在桌宠旁边，
 * 用户双击一下角色就该有个搜索框；功能入口则从右键菜单搬到了这里。
 */
function openPanel() {
  panel?.show();
}

/**
 * 渲染层报告「有文件被拖到了桌宠身上」。
 *
 * 只报**文件名与大小**：路径本身不落盘、不外传——
 * 用户拖进来的是他自己的文件，没必要被记录下来。
 */
async function reportDroppedFile(filePath) {
  try {
    const info = await stat(filePath);
    const name = basename(filePath);
    const size = info.isDirectory() ? '文件夹' : formatBytes(info.size);
    assistant?.say?.(`收到 ${name}（${size}）`, { emotion: 'surprised', sound: 'tap' });
  } catch (err) {
    console.warn('[desk-pet] 拖放的文件读不到：', err?.message);
    assistant?.say?.('这个文件我打不开', { emotion: 'sad', sound: 'error' });
  }
}

/** 字节数说成人话。 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

app.whenReady().then(async () => {
  // 用户导入的 Live2D 模型存在 userData 里（安装目录可能没有写权限），
  // 给它一个虚拟根：渲染层就能用和内置模型一样的 URL 形状去取它们。
  //
  // 用户自己的插件也在 userData 里（userData/plugins/<插件名>/），
  // 同样给它一个虚拟根——插件的页面就是这么被加载的。
  registerAppProtocol(ROOT, {
    [USER_MODELS_URL_PREFIX]: userModelsDir(app.getPath('userData')),
    [USER_PLUGINS_URL_PREFIX]: userPluginsDir(app.getPath('userData')),
  });
  settings = await loadSettings(app.getPath('userData'));
  // 没有保存过位置时不需要在这里补默认值：createPetWindow 的 restorePosition
  // 会用真实视口尺寸算出主显示器右下角，避免这里写死 300×560 与清单脱节。
  // 必须先注册 IPC 再创建窗口：渲染层页面一加载就会调用 getSettings()，
  // 顺序反了会撞上 "No handler registered"。
  registerIpc({
    getSettings: () => settings,
    saveSettings: (patch) => {
      const next = persist(patch);
      // 缩放/透明度改完必须立刻广播给宠物窗口，
      // 否则「改了设置没反应」——落盘是 300ms 之后的事，生效是现在。
      broadcastSettings(next);
      return next;
    },
    listModels: readModelRegistry,
    switchModel: (modelId) => switchModelTo(modelId),
    // 导入 / 删除用户自己的 Live2D 模型。两者都要弹原生对话框，
    // 所以主进程会校验发起方是不是设置窗口。
    importModel: (event) => importModel(event),
    deleteModel: (event, modelId) => deleteModel(event, modelId),
    onOpenSettings: openSettings,
    onShowContextMenu: showContextMenu,
    // 双击桌宠：弹出插件面板。
    onOpenPanel: openPanel,
    // 桌宠被点了：主进程据此念一句台词（读的是预先生成好的缓存）。
    onTap: () => {
      assistant?.tapTalk?.();
    },
    // 拖拽的增量位移：累加到**期望位置**上，夹紧后才落到窗口，并持久化实际位置。
    //
    // 增量式是刻意的：渲染层把「这一段拖了多远」递过来，
    // 累加结果正好等于光标相对按下点的总位移，窗口不会与光标脱节。
    onMoveBy: (dx, dy) => {
      system?.moveBy?.(dx, dy);
    },
    // 新一次拖拽开始：期望位置重新对齐当前窗口位置。
    onDragStart: () => {
      system?.dragStart?.();
    },
    // 拖拽结束：判定要不要停靠。
    //
    // 期望位置的累加器由控制器自己清——清不掉也不会串台，
    // 因为下一次 dragStart 会重新对齐。
    onDragEnd: () => {
      system?.dragEnd?.();
    },
    // 渲染层量出的可见矩形（桌宠本体在窗口里的哪一块）。
    onVisibleRect: (rect) => {
      visibleRect = rect || null;
      system?.setVisibleRect?.(rect);
      persistVisibleRect(rect);
    },
    // 「光标落在形象的透明处」：那块空白不吃点击。
    onSetClickThrough: (enabled) => {
      system?.setPixelClickThrough?.(enabled);
    },
    // 渲染层注册好推送频道的监听器了。
    onRendererReady,
    // 渲染层报告形象切换的结果（成功 / 失败 / 被顶掉）。
    onModelSwitchResult,
    // 渲染层报告模型加载失败（启动阶段）。
    onModelError,
    // —— 桌面助理 ——
    // 助理状态：设置窗口用它显示与修改偏好。
    getAssistantState: () => assistant?.getState() || null,
    saveAssistantPrefs: (patch) => {
      const next = assistant?.update(patch || {});
      // 音效开关要立刻生效：它作用在渲染层的提示音上。
      if (typeof patch?.sound?.enabled === 'boolean' && win && !win.isDestroyed()) {
        win.webContents.send('pet:soundEnabled', { enabled: patch.sound.enabled });
      }
      // 总音量同理：拖滑块时音量要立刻变，落盘是 300ms 之后的事。
      if (typeof patch?.sound?.volume === 'number') pushVolume();
      // 音色/台词/开关改了 → 池子的成分变了，渲染层要立刻知道。
      if (patch?.tts || patch?.tapTalk) void pushTapVoice();
      return next;
    },
    // 语音状态：只回掩码，**绝不回明文 key**。
    getTtsStatus: async () => {
      const status = await apiKeyStatus(app.getPath('userData'), ROOT);
      return { ...status, voices: SUGGESTED_VOICES };
    },
    setTtsApiKey: async (key) => {
      const mask = await saveApiKey(app.getPath('userData'), key);
      // Key 有没有，直接决定「点桌宠时能不能念台词」。
      void pushTapVoice();
      // 刚填上 Key：台词的语音现在才生成得出来。
      assistant?.prewarmTapLines?.();
      return { ok: true, mask };
    },
    // 对话（LLM）的 key 状态：只回掩码，**绝不回明文 key**。
    // 留空表示沿用 MiniMax 的那个 key。
    getLlmStatus: async () => llmKeyStatus(app.getPath('userData'), ROOT),
    setLlmApiKey: async (key) => {
      const mask = await saveLlmApiKey(app.getPath('userData'), key);
      return { ok: true, mask };
    },
    // 渲染层报告拖放到桌宠上的文件。
    onDroppedFile: (filePath) => {
      if (typeof filePath !== 'string' || filePath === '') return;
      void reportDroppedFile(filePath);
    },
    // —— 系统级开关（第六部分）——
    // 设置窗口要读当前状态（勾选框、快捷键、停靠边）。
    getSystemState: () => system?.getState?.() || null,
    // 开始/取消录制快捷键。真正的按键捕获在主进程（before-input-event）。
    // slot 指的是**哪一个**快捷键（见 shared/hotkeys.js 的槽位清单）。
    recordHotkey: (slot) => system?.startRecording?.(slot) || false,
    cancelHotkeyRecording: () => system?.cancelRecording?.() || false,
    // 清除一个快捷键（= 不设它）。只有允许为空的槽位能清。
    clearHotkey: (slot) => system?.clearHotkey?.(slot) || false,
    // —— 插件 ——
    // 设置窗口的「插件」分区：列出全部插件、开关它们。
    //
    // 插件宿主是**后**建的（它要扫盘），所以这里取的是实时变量：
    // 调用发生在宿主就绪之后，那时 plugins 已经不是 null 了。
    listPlugins: () => plugins?.listAll() || [],
    setPluginEnabled: (id, enabled) => plugins?.setEnabled(String(id || ''), Boolean(enabled)),
  });

  // 显示器拓扑变化时缓存失效：拖拽夹紧必须按当前屏幕算。
  // 必须在 app ready 之后注册：screen 模块在 ready 之前不可用。
  screen.on('display-added', invalidateDisplayCache);
  screen.on('display-removed', invalidateDisplayCache);
  screen.on('display-metrics-changed', invalidateDisplayCache);

  win = createPetWindow({ rootDir: ROOT, settings, displays: currentDisplays() });
  startCursorTracking();

  // 系统控制器：必须在窗口建好之后创建——穿透模式要作用在窗口上。
  system = createSystemController({
    getWindow: () => win,
    getDisplays: () => currentDisplays(),
    getSettings: () => settings,
    applySettings: (patch) => persist(patch),
    // 每个快捷键槽位按下之后做什么（槽位名见 shared/hotkeys.js）。
    hotkeyActions: {
      // 呼出 / 隐藏桌宠。
      hotkey: () => toggleVisible(),
      // 唤醒输入框：把插件面板叫出来，焦点落在它的输入框上。
      panelHotkey: () => openInputBox(),
    },
    onStateChanged: () => {
      refreshTrayMenu();
      // 设置窗口也要跟着变：用户可能是在**托盘菜单**里改的穿透，
      // 那条路不经过设置窗口自己的 saveSettings，不会自动广播。
      // 系统状态变了要广播出去：设置窗口的勾选框要跟着回退，
      // 而且它靠 getState() 里的 lastError 把失败原因显示出来。
      // persist() 自己不广播——落盘是防抖的，而「生效」不能等落盘。
      broadcastSettings(settings);
    },
    onHotkeyStatus: (status) => {
      // 设置窗口还没建时无处可发；它建好后会自己拉一次状态。
      if (settingsWin && !settingsWin.isDestroyed()) {
        settingsWin.webContents.send('pet:hotkeyStatus', status);
      }
    },
    loginItem: {
      set: (opts) => {
        // E2E 不碰注册表：写注册表会污染跑测试的机器，
        // 而且注册表项可能指向临时路径，清理不掉。
        if (IS_E2E) {
          // 但要**记住**最后一次写进去的值：`get()` 得有个东西可返回，
          // 否则「磁盘与系统登录项是否一致」这条检查永远报不一致。
          e2eLoginItem = { ...e2eLoginItem, ...opts };
          return;
        }
        app.setLoginItemSettings(opts);
      },
      get: () => (IS_E2E ? e2eLoginItem : app.getLoginItemSettings()),
    },
    shortcuts: {
      register: (acc, cb) => {
        // E2E 不占用系统级快捷键：注册是真的全局生效，
        // 跑测试的那几分钟里用户按这个组合会被应用吃掉。
        if (IS_E2E) {
          // 但**记下回调**：测试可以按它，模拟「用户按了这个键」。
          // 这样「按下 → 输入框被唤醒」这条链也能自动化
          // （真正按系统级快捷键是不能自动化做的，见 README 的已知限制）。
          e2eShortcuts.set(acc, cb);
          return true;
        }
        return globalShortcut.register(acc, cb);
      },
      unregister: (acc) => {
        if (IS_E2E) {
          e2eShortcuts.delete(acc);
          return;
        }
        globalShortcut.unregister(acc);
      },
      unregisterAll: () => {
        if (IS_E2E) {
          e2eShortcuts.clear();
          return;
        }
        globalShortcut.unregisterAll();
      },
      isRegistered: (acc) => (IS_E2E ? e2eShortcuts.has(acc) : globalShortcut.isRegistered(acc)),
    },
    getAppPath: () => app.getAppPath(),
    isPackaged: app.isPackaged,
    isE2E: IS_E2E,
  });
  system.init(settings);

  // 气泡窗口：桌宠说话的地方。**懒创建**——第一次有消息时才建窗口，
  // 否则 E2E 里的 app.firstWindow() 会先找到气泡而不是桌宠。
  bubble = createBubbleController({
    rootDir: ROOT,
    getPetWindow: () => win,
    getPetRect: () => petVisibleRect(),
    getDisplays: () => currentDisplays(),
  });

  // 桌面助理：提醒、番茄钟、待办、天气、报时都在这边。
  assistant = createAssistant({
    userDataDir: app.getPath('userData'),
    rootDir: ROOT,
    bubble,
    // 情绪事件发给渲染层，由它换表情/播动作。
    // 第二个参数是心情值的增量（渲染层拿它调整心情）。
    onEmotion: (emotion, mood = 0) => {
      if (win && !win.isDestroyed()) win.webContents.send('pet:emotion', { emotion, mood });
    },
    // 合成好的语音交给渲染层播放（口型同步也在那边）。
    onSpeak: (audio, mime) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('pet:speak', { audio, mime });
      }
    },
    onSound: (name) => {
      if (win && !win.isDestroyed()) win.webContents.send('pet:sound', { name });
    },
    // 桌宠可见吗：桌宠被藏起来时不该凭空浮一个气泡窗口。
    isPetVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible()),
    // 本机程序索引：agent 的 `app.launch` 工具要用它。
    // 索引在下面才建好（它要扫盘），所以传的是取值函数。
    getAppIndex: () => apps,
  });
  await assistant.start();

  // 助理起来之后再补发一次音量。
  //
  // 渲染层可能**比助理更早 ready**（页面一加载就发 rendererReady，
  // 而助理还在 start() 里读磁盘）——那一刻 assistant 还是 undefined，
  // pushVolume 推不出东西，音量就停在渲染层的默认值 0.8 上，
  // 用户设的 0.3 永远传不过去。
  pushVolume();
  // 「点桌宠时的声音」池子同理：助理没起来时推不出「能不能念台词」。
  void pushTapVoice();

  // 插件宿主：扫 plugins/ 目录，把每个子目录读成一个插件。
  // 待办、提醒、番茄钟……都在那儿；它们读写的都是助理的状态——
  // 助理是唯一的状态来源。
  plugins = await createPluginHost({
    rootDir: ROOT,
    userDataDir: app.getPath('userData'),
    userPluginsDir: userPluginsDir(app.getPath('userData')),
    assistant,
    openSettings,
  });
  await plugins.load();

  // 界面路由：面板工作台与独立窗口都是「界面落点」。
  //
  // **必须先建好**：它要知道每个插件的刷新间隔（host.spec），
  // 还要在插件清单变化时把界面开合告诉插件。
  pluginSurfaces = createSurfaceController({
    host: plugins,
    onChange: (pluginId, open) => plugins.surfaceChanged(pluginId, open),
  });

  // 插件的独立窗口与桌面小部件。
  pluginWindows = createPluginWindowController({
    rootDir: ROOT,
    host: plugins,
    getPetWindow: () => win,
    getPetRect: () => petVisibleRect(),
    getDisplays: () => currentDisplays(),
    surfaces: pluginSurfaces,
  });
  // 宿主负责找插件，窗口负责开窗：两者互相认识一下。
  plugins.attachWindows(pluginWindows);

  // 本机程序索引：面板的搜索框要能搜到本机的程序。
  //
  // 扫盘要几百毫秒，所以**后台**先扫一遍（warm）：
  // 用户点开面板时清单多半已经在那儿了，不用干等。
  apps = createAppIndex({
    // 启动交给系统：shell.openPath 能处理 exe、lnk、bat 与目录。
    //
    // 它的坑：**不抛异常**，失败时 resolve 一个**错误字符串**。
    // 忽略返回值的话，「文件不存在」会变成一次毫无动静的失败。
    open: async (target) => {
      try {
        const error = await shell.openPath(target);
        return error || null;
      } catch (err) {
        return err?.message || '打开失败';
      }
    },
  });
  apps.warm();

  // 插件面板：双击桌宠弹出来的搜索框。**懒创建**——
  // 启动时它不在，E2E 的 app.firstWindow() 才认得出桌宠。
  panel = createPanelController({
    rootDir: ROOT,
    getPetWindow: () => win,
    getPetRect: () => petVisibleRect(),
    getDisplays: () => currentDisplays(),
    plugins,
    apps,
    // 内置功能（设置、聊天记录）要用：设置开的是设置窗口，
    // 聊天记录读的是助理里的聊天记录。
    assistant,
    openSettings,
    // 界面路由：面板工作台里的插件页面，数据经它送进来。
    surfaces: pluginSurfaces,
    // 输入框里的话直接发给桌宠（不走插件动作通道）。
    onChat: (text) => {
      // 一定要接住：chat() 里给气泡发消息的调用万一抛错，
      // 漏掉的拒绝会变成主进程的未处理错误。
      void assistant?.chat?.(text)?.catch?.((err) => {
        console.warn('[desk-pet] 聊天失败：', err?.message || err);
      });
    },
  });

  // 桌宠动了，气泡与面板跟着动。
  win.on('move', () => {
    bubble?.reposition();
    panel?.reposition();
    pluginWindows?.reposition();
  });
  win.on('resize', () => {
    bubble?.reposition();
    panel?.reposition();
    pluginWindows?.reposition();
  });
  // 桌宠被藏起来时，气泡与面板不该独自留在桌面上。
  win.on('hide', () => {
    bubble?.onPetHidden();
    panel?.onPetHidden();
  });
  // 桌宠重新出现：把藏起来期间排队的消息播出来。
  win.on('show', () => assistant?.onPetVisible());

  tray = createTray({
    iconPath: join(ROOT, 'assets', 'icons', 'tray.png'),
  });
  refreshTrayMenu();
});

// 'activate' 是 macOS 专用事件，Windows 上永不触发——本项目只做 Windows，不留跨平台分支。

/**
 * 退出前把插件窗口收掉。
 *
 * 退出时不需要保留任何界面，先拆掉最省事：
 * 它们的周期刷新计时器也跟着一起停了。
 */
app.on('before-quit', () => {
  pluginWindows?.destroyAll?.();
  // 界面路由的定时器**自己**停掉。
  //
  // 不停的话，它们是靠窗口的 `closed` → `detach` 顺带死的——
  // 那是**碰巧**（面板还开着的时候就没有窗口会关）。
  pluginSurfaces?.stopAll?.();
});

// 退出前把待写入的设置落盘，否则用户在 300ms 防抖窗口内退出就会丢掉改动。
app.on('before-quit', flushPendingSave);

// 退出时注销全局快捷键：不注销的话这个组合会一直被占着，
// 下次启动注册不上。
app.on('will-quit', () => system?.dispose?.());

// 第二次启动：单实例锁挡住了它，但原来的那个应用**什么也不做**——
// 用户看到的是「双击了图标却没反应」。这里把已有的桌宠叫到前面来。
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
  win.focus();
});

app.on('window-all-closed', () => {
  if (!IS_E2E) app.quit();
});
