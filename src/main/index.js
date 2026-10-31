import { app, screen, dialog, BrowserWindow } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { registerSchemePrivileges, registerAppProtocol, appUrl } from './protocol.js';
import { createPetWindow, applySettingsToWindow } from './window.js';
import { createTray } from './tray.js';
import { buildContextMenu, buildTrayMenu } from './menu.js';
import { registerIpc } from './ipc.js';
import { loadSettings, saveSettings, sanitizeSettings } from './settings.js';
import { clampToDisplays } from './display.js';

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
// 最后一次施加到窗口上的透明度：用来避免重复调用原生接口。
let appliedOpacity = null;
// 设置窗口全局只有一个：重复打开时聚焦已有的那个，而不是开一堆。
let settingsWin = null;
// 当前拖拽的**期望**位置（未夹紧）：拖拽起点 + Σ增量。
//
// 为什么不能把增量直接累加到「已夹紧」的位置上：顶到屏幕边缘时，
// 被夹紧吃掉的那部分增量会永久丢失；光标往回走时，返回的增量从被钉住
// 的位置全额施加，角色于是越过光标、跳到相反的边缘并停在那里。
// 期望位置不夹紧，只在「实际落到窗口上」时才夹紧。
let desiredPosition = null;
// 正在进行的写入。防抖计时器触发后 saveTimer 会被置空，
// 但写入可能还没落盘完成——只盯 saveTimer 会漏掉这个窗口。
let pendingWrite = null;

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

/**
 * 读取形象注册表，并把条目**规整**成可用形状。
 *
 * 原始 JSON 是用户手写的：漏字段就直接用会让下拉框出现
 * 「undefined」这样的条目名，或让模型指向不存在的文件。
 * 这里的默认值与渲染层 loadManifest 的回退规则**必须一致**
 * （manifest → `<id>/pet.json`，model3 → `<id>.model3.json`），
 * 否则设置窗口显示的形象与桌面上跑的对不上。
 */
async function readModelRegistry() {
  try {
    const text = await readFile(join(ROOT, 'assets', 'live2d', 'index.json'), 'utf8');
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed.models) ? parsed.models : [];
    const out = [];
    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string' || entry.id.trim() === '') {
        // 没有 id 的条目无法被选中，也无法生成回退路径：直接丢掉，但留痕。
        console.warn('[desk-pet] 形象注册表条目缺少 id，已忽略：', JSON.stringify(entry));
        continue;
      }
      const id = entry.id.trim();
      out.push({
        ...entry,
        id,
        // 名字缺失时退回 id：下拉框里出现「undefined」比显示 id 更糟。
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
        manifest: entry.manifest || `${id}/pet.json`,
        model3: entry.model3 || `${id}.model3.json`,
      });
    }
    return out;
  } catch (err) {
    // 注册表损坏或读不到时静默返回空列表，会让「形象列表是空的」这件事无从排查——
    // 与 settings 损坏同理，必须留痕。
    console.warn('[desk-pet] 形象注册表读取失败：', err?.message);
    return [];
  }
}

function persist(patch) {
  // 必须过一遍 sanitizeSettings：否则渲染层传来的越界值（例如 opacity=1.5）
  // 会留在内存里，而落盘时被夹紧——内存与磁盘不一致，
  // getSettings 会把越界值发回渲染层，Task 9 还会拿它去调 win.setOpacity()。
  settings = sanitizeSettings({ ...settings, ...patch });
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
const SWITCH_ACK_TIMEOUT_MS = 30000;

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

/** 渲染层就绪：补发积压的切换请求，并重新广播一次设置。 */
function onRendererReady() {
  rendererReady = true;
  deliverPendingSwitches();
  // 启动期间到达的设置广播同样可能被丢弃（监听器那时还没注册），
  // 重新广播一次当前设置：缩放/透明度/形象 id 都以这一刻的为准。
  broadcastSettings(settings);
}

/**
 * 渲染层报告「模型加载失败」（启动阶段）。
 *
 * 渲染层的 console.* 不进终端：用户在 `npm start` 里只会看到一份干净的日志
 * 和一个全透明的空窗口——完全不可见的失败。
 * 所以失败必须由主进程留痕：终端里一条 console.error，用户看得见。
 */
function onModelError(info) {
  const message = typeof info === 'string' ? info : info?.message || String(info);
  console.error('[desk-pet] 模型加载失败：', message);
  if (!IS_E2E) {
    // 弹窗让失败在界面上也看得见（不阻塞主进程）。
    dialog
      .showMessageBox({
        type: 'error',
        title: '桌面宠物 · 模型加载失败',
        message: '桌宠模型加载失败',
        detail:
          `${message}\n\n` +
          '若还没有下载官方样例资源，请先在项目目录执行 npm run setup；' +
          '若模型文件不完整，删除 assets/live2d/models/ 下的对应目录后重跑 npm run setup。',
        buttons: ['知道了'],
      })
      .catch(() => {});
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
  if (!saveTimer && !pendingWrite) return;
  event.preventDefault();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeSettings();
  }
  const wait = pendingWrite || Promise.resolve();
  wait.finally(() => app.quit());
}

function toggleVisible() {
  if (!win) return;
  const next = !win.isVisible();
  if (next) win.showInactive();
  else win.hide();
  persist({ visible: next });
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
  settingsWin = new BrowserWindow({
    width: 380,
    height: 300,
    resizable: false,
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
  settingsWin.loadURL(appUrl('/src/settings/index.html'));
  // 关掉设置窗口不退出应用：宠物窗口还在（顶多是被隐藏），
  // window-all-closed 不会因为它而触发。
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function showContextMenu() {
  if (!win) return;
  buildContextMenu({
    toggleVisible,
    openSettings,
    quit: () => app.quit(),
  }).popup({ window: win });
}

app.whenReady().then(async () => {
  registerAppProtocol(ROOT);
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
    switchModel: async (modelId) => {
      // 空 id（''/undefined/null）不是「切换到某个形象」，而是「没有指定」。
      //
      // resolveModelId 会把任何不认识的 id 都映射到 models[0].id，
      // 于是 switchModel('') 会把一个存得好好的 modelId 覆盖成第一个形象——
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
      if (ack.superseded) {
        return { ok: false, modelId: settings.modelId, error: '该切换请求已被更新的请求取代' };
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
    },
    onOpenSettings: openSettings,
    onShowContextMenu: showContextMenu,
    // 拖拽的增量位移：累加到**期望位置**上，夹紧后才落到窗口，并持久化实际位置。
    //
    // 增量式是刻意的：渲染层把「这一段拖了多远」递过来，
    // 累加结果正好等于光标相对按下点的总位移，窗口不会与光标脱节。
    onMoveBy: (dx, dy) => {
      if (!win || win.isDestroyed()) return;
      const [w, h] = win.getSize();
      // 期望位置 = 拖拽起点 + Σdelta，不夹紧。
      if (!desiredPosition) {
        const [x, y] = win.getPosition();
        desiredPosition = { x, y };
      }
      desiredPosition.x += dx;
      desiredPosition.y += dy;
      const applied = clampToDisplays(desiredPosition.x, desiredPosition.y, w, h, currentDisplays());
      win.setPosition(applied.x, applied.y);
      // 持久化的是**实际可见**的位置，不是可能跑到屏幕外的期望位置。
      persist({ position: applied });
    },
    // 新一次拖拽开始：期望位置重新对齐当前窗口位置。
    onDragStart: () => {
      desiredPosition = null;
    },
    // 拖拽结束也清掉累加器。
    // 这样即使 pet:dragStart 信号在某次丢失（preload 方法被删、onDragStart 没接上），
    // 下一次拖拽也不会累加到上一次拖拽的未夹紧位置上——那正是 Important #1 描述的缺陷类型。
    onDragEnd: () => {
      desiredPosition = null;
    },
    // 渲染层注册好推送频道的监听器了。
    onRendererReady,
    // 渲染层报告形象切换的结果（成功 / 失败 / 被顶掉）。
    onModelSwitchResult,
    // 渲染层报告模型加载失败（启动阶段）。
    onModelError,
  });

  // 显示器拓扑变化时缓存失效：拖拽夹紧必须按当前屏幕算。
  // 必须在 app ready 之后注册：screen 模块在 ready 之前不可用。
  screen.on('display-added', invalidateDisplayCache);
  screen.on('display-removed', invalidateDisplayCache);
  screen.on('display-metrics-changed', invalidateDisplayCache);

  win = createPetWindow({ rootDir: ROOT, settings, displays: currentDisplays() });

  tray = createTray({
    iconPath: join(ROOT, 'assets', 'icons', 'tray.png'),
  });
  tray.setContextMenu(
    buildTrayMenu({
      toggleVisible,
      openSettings,
      quit: () => app.quit(),
    })
  );
});

// 'activate' 是 macOS 专用事件，Windows 上永不触发——本项目只做 Windows，不留跨平台分支。
// 退出前把待写入的设置落盘，否则用户在 300ms 防抖窗口内退出就会丢掉改动。
app.on('before-quit', flushPendingSave);

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
