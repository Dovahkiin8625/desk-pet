import { app, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { registerSchemePrivileges, registerAppProtocol } from './protocol.js';
import { createPetWindow } from './window.js';
import { createTray } from './tray.js';
import { buildContextMenu, buildTrayMenu } from './menu.js';
import { registerIpc } from './ipc.js';
import { loadSettings, saveSettings, sanitizeSettings } from './settings.js';
import { clampToDisplays, defaultPosition } from './display.js';

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
// 正在进行的写入。防抖计时器触发后 saveTimer 会被置空，
// 但写入可能还没落盘完成——只盯 saveTimer 会漏掉这个窗口。
let pendingWrite = null;

function currentDisplays() {
  // 主显示器必须排在第一位：display.js 的 defaultPosition 依赖 displays[0] 是主显示器，
  // 而 Electron 的 getAllDisplays() 并不保证这一点。
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  return [primary, ...all.filter((d) => d.id !== primary.id)].map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
  }));
}

async function readModelRegistry() {
  try {
    const text = await readFile(join(ROOT, 'assets', 'live2d', 'index.json'), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.models) ? parsed.models : [];
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
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeSettings();
  }, 300);
  return settings;
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
  // Task 9 实现设置窗口；在此之前是空操作，保证不崩溃
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
    saveSettings: (patch) => persist(patch),
    listModels: readModelRegistry,
    switchModel: (modelId) => {
      persist({ modelId });
      if (win) win.webContents.send('pet:modelSwitchRequest', modelId);
    },
    onOpenSettings: openSettings,
    onShowContextMenu: showContextMenu,
    // 拖拽的增量位移：读当前窗口位置 → 加增量 → 夹紧到可见区域 → 落盘。
    // 增量式是刻意的：渲染层把「这一段拖了多远」递过来，
    // 累加结果正好等于光标相对按下点的总位移，窗口不会与光标脱节。
    onMoveBy: (dx, dy) => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      const displays = currentDisplays();
      const next = displays.length
        ? clampToDisplays(x + dx, y + dy, w, h, displays)
        : defaultPosition(w, h, displays);
      win.setPosition(next.x, next.y);
      persist({ position: next });
    },
  });

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

app.on('window-all-closed', () => {
  if (!IS_E2E) app.quit();
});
