import {
  edgeGaps,
  snapToEdge,
  dockPosition,
  flushPosition,
  clampDocked,
  isFullyTucked,
  chooseDockSide,
} from './edgeDock.js';
import { clampToDisplays, displayForPoint } from './display.js';
import { HOTKEY_SLOTS, getHotkeySlot } from '../shared/hotkeys.js';
import { visibleRectOnScreen, windowRectForVisible } from '../shared/petRect.js';

/**
 * 键盘上带 Shift 时会变成的符号 → 基础键。
 *
 * 用户按 Ctrl+Shift+1 时 input.key 是 '!'（美式键盘），
 * 直接用 '!' 会拼出注册不了的 'Control+Shift+!'。
 */
const SHIFTED_TO_BASE = Object.freeze({
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']',
  '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
});

/** input.key → Electron 加速键里的键名。 */
const KEY_NAMES = Object.freeze({
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
});

/** 这些键是修饰键，单独按不算一个组合。 */
const MODIFIER_KEYS = new Set([
  'Control', 'Alt', 'Shift', 'Meta', 'Super', 'CapsLock',
  'AltGraph', 'Fn', 'Hyper', 'NumLock', 'ScrollLock', 'Dead',
]);

/**
 * 把一次按键拼成 Electron 的加速键串。
 *
 * 返回空串表示「还不算一个组合」（纯修饰键，或没有修饰键的裸键）。
 *
 * **必须至少一个修饰键**：Windows 的 RegisterHotKey 允许注册裸键，
 * 那意味着全局劫持用户的字母键——「按 D 一下」会同时被桌宠吃掉。
 */
export function buildAccelerator(input) {
  if (!input || typeof input.key !== 'string' || input.key === '') return '';
  const raw = input.key;
  if (raw === 'Escape') return '';
  if (MODIFIER_KEYS.has(raw)) return '';
  const mods = [];
  if (input.control) mods.push('Control');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  if (input.meta) mods.push('Super');
  if (mods.length === 0) return '';
  const base = SHIFTED_TO_BASE[raw] || raw;
  const key = KEY_NAMES[base] || (base.length === 1 ? base.toUpperCase() : base);
  return [...mods, key].join('+');
}

/**
 * 系统级开关的控制器：开机自启、全局快捷键、鼠标穿透、边缘吸附与贴边停靠。
 *
 * 全局快捷键有**两个**（见 shared/hotkeys.js 的槽位清单）：
 * 一个呼出/隐藏桌宠，一个唤醒输入框。它们共用同一套录制与注册流程，
 * 差别只在按下去之后做什么——由 `hotkeyActions` 按槽位名注入。
 *
 * **这个文件以及它的依赖（edgeDock.js / display.js）都不得 import Electron**：
 * 本仓库的单元测试用 `node --test` 跑，没有 Electron 环境。
 * 依赖也不许 import——将来 Task 7 让 edgeDock.js 引入 electron 时，
 * 整份单元测试会在 ESM link 期炸掉，而炸点离原因很远，很难排查。
 * Electron 的能力（app / globalShortcut）全部靠注入。
 *
 * 为什么要一个控制器而不是四个小模块：这四个开关共享同一套流程
 * ——落盘 → 启动恢复 → 变更生效。放在一起，它们能互相看见
 * （比如「关掉贴边隐藏时要把停靠中的桌宠取回来」）。
 */
export function createSystemController({
  getWindow,
  getDisplays,
  getSettings,
  applySettings,
  hotkeyActions,
  onStateChanged,
  onHotkeyStatus,
  loginItem,
  shortcuts,
  getAppPath,
  isPackaged = false,
  isE2E = false,
}) {
  // 上一次**真正生效出去**的值。
  // 只有真的变了才动作：applySettings 在拖拽的每一帧都会被调用，
  // 无变化时重复写注册表、重复注册快捷键是最热的路径上的无用功。
  let applied = null;
  // 上一次看到的「用户意图」（settings.autoLaunch）。
  //
  // 写注册表**只看意图有没有变**，不看生效值：
  // `persist()` 在拖拽的每一帧都会被调用，而它会调到这里——
  // 用生效值当条件的话，一次失败（关闭方向写不进去）会被放大成
  // 每秒几十次注册表写入 + 一条日志 + 一次广播 + 一次托盘菜单重建。
  //
  // 「上一次生效的值」（applied.autoLaunch）是另一回事：
  // 关闭失败时它**不动**，留着旧值——系统里的注册项其实还在，
  // 下次用户改动时再试一次。
  let lastAutoLaunchIntent = null;
  // 回退落盘期间（开启失败时把磁盘改回 false）为 true。
  // 那不是用户按的开关，是控制器自己纠正磁盘——不能当成「意图变了」。
  let autoLaunchRollback = false;
  // 当前停靠在哪条边（null = 没停靠）。
  let dock = null;
  // 桌宠**本体**的可见矩形（窗口内坐标）：窗口里真正画着形象的那一块。
  //
  // 桌宠窗口是一块固定大小的画布，Live2D 贴图四周通常有透明留白。
  // 夹紧、吸附、停靠一律按**本体**算：小模型的上半截窗口是空的，
  // 按窗口算的话它永远差一截才贴得到屏幕边，往上拖也拖不到顶。
  //
  // null = 还没量出来（模型刚加载）：那时退回整块窗口（最保守）。
  let visibleRect = null;
  // 「透明处不吃鼠标」：渲染层按光标位置发过来的。
  //
  // 与设置里的「鼠标穿透」不是一回事：
  //   - 设置里那个是**整个窗口**不吃点击（用户主动开的）；
  //   - 这个是**只在形象的透明留白上**不吃点击。
  // 两者取或——设置里开着时整个窗口都不吃点击。
  let pixelClickThrough = false;
  // 本次拖拽的期望位置（未夹紧）与净位移。
  //
  // 期望位置记的是**本体**的左上角（不是窗口的）：
  // 夹紧与吸附算的都是本体，窗口位置是最后一步换算出来的。
  let desired = null;
  let netDelta = { dx: 0, dy: 0 };
  // 正在录制的槽位（null = 没在录制）。
  //
  // 一次只录一个：按键捕获是全局的（before-input-event），
  // 两个槽位同时录会互相抢键。
  let recordingSlot = null;
  // 每个槽位一份状态：{ [槽位名]: { state, accelerator, error } }。
  let hotkeyStatus = Object.fromEntries(
    HOTKEY_SLOTS.map((s) => [s.key, { state: 'idle', accelerator: '', error: '' }])
  );

  // 主进程 → 设置窗口的快捷键状态通知。
  // 设置窗口是 index.js 管的，所以通知由外部注入。
  //
  // 载荷里带着**槽位名**：设置窗口有两个快捷键，
  // 不知道这条状态说的是哪一个，界面就会张冠李戴。
  const notifyHotkeyStatus = (slotKey) => {
    onHotkeyStatus?.({ slot: slotKey, ...hotkeyStatus[slotKey] });
  };

  // 最近一次失败的说明。空串 = 没有失败。
  // 它是「界面上说得出来」那半的载体：光在终端留痕，用户看不见。
  let lastError = '';

  // —— 停靠 ——
  //
  // dock 是「当前藏在哪条边」；它是状态，不是开关——
  // 用户的意图是 dockEnabled（贴边隐藏那个勾选框）。

  /** 停靠所在显示器的工作区。找不到就返回 null（退化成普通夹紧）。 */
  function dockWorkArea() {
    const vis = currentVisibleRect();
    if (!vis) return null;
    return displayForPoint(vis.x, vis.y, getDisplays())?.workArea || null;
  }

  /**
   * 设置窗口位置。
   *
   * **必须取整**：Electron 的 setPosition 只吃整数，
   * 传小数会抛 "Error processing argument at index 1, conversion failure"。
   *
   * 这不是洁癖：可见矩形的偏移是浮点数（渲染出来的亚像素位置），
   * 减出来的窗口坐标自然也不是整数——不取整的话，**每一次拖拽都会抛**。
   * （拖拽增量本身也可能是小数：混合 DPI 下光标坐标不是整数。）
   */
  function setWindowPosition(win, x, y) {
    win.setPosition(Math.round(x), Math.round(y));
  }

  /**
   * 桌宠**本体**在屏幕上的位置与大小。
   *
   * 量不出可见矩形时（模型刚加载、还没量过）退回整块窗口：
   * 那是最保守的做法（与旧行为一致），只是拖不到那么贴边。
   */
  function currentVisibleRect() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    return visibleRectOnScreen({ x, y, width: w, height: h }, visibleRect);
  }

  /**
   * 渲染层报来的可见矩形（窗口内坐标）。
   *
   * 收到之后，夹紧、吸附、停靠就都按**本体**算了。
   */
  function setVisibleRect(rect) {
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
    const prev = visibleRect;
    const next = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    if (
      prev &&
      prev.x === next.x &&
      prev.y === next.y &&
      prev.width === next.width &&
      prev.height === next.height
    ) {
      return;
    }
    visibleRect = next;
    // 停靠中的桌宠要按新的本体矩形重新摆一次：
    // 藏起来的是**形象**，不是那块画布。
    // （拖拽进行中不重摆——那会把用户正在拖的东西挪走。）
    if (dock && !desired) {
      const win = getWindow();
      const vis = currentVisibleRect();
      const wa = dockWorkArea();
      if (win && !win.isDestroyed() && vis && wa) {
        const target = dockPosition(dock, vis.x, vis.y, vis.width, vis.height, wa);
        const targetWin = windowRectForVisible(target, visibleRect);
        setWindowPosition(win, targetWin.x, targetWin.y);
      }
    }
  }

  /**
   * 渲染层说「光标现在落在形象的透明处」。
   *
   * 只记状态；实际生效由 applyClickThrough 统一施加，
   * 这样设置里的「鼠标穿透」与它不会互相覆盖。
   */
  function setPixelClickThrough(enabled) {
    const next = Boolean(enabled);
    if (next === pixelClickThrough) return;
    pixelClickThrough = next;
    applyClickThrough(applied?.clickThrough);
  }

  /** 取消停靠：把桌宠放回完全可见的贴齐位。 */
  function undock() {
    if (!dock) return;
    const win = getWindow();
    const side = dock;
    dock = null;
    if (win && !win.isDestroyed()) {
      const vis = currentVisibleRect();
      const wa = dockWorkArea();
      if (vis && wa) {
        const target = flushPosition(side, vis.x, vis.y, vis.width, vis.height, wa);
        const targetWin = windowRectForVisible(target, visibleRect);
        setWindowPosition(win, targetWin.x, targetWin.y);
        applySettings({ position: { x: Math.round(targetWin.x), y: Math.round(targetWin.y) } });
      }
    }
    applySettings({ dock: null });
    onStateChanged?.();
  }

  /** 「取回桌宠」：停靠中的桌宠回到完全可见。 */
  function retrievePet() {
    undock();
  }

  /** 启动时按 settings.dock 施加停靠。 */
  function applyDockAtStartup() {
    // 没开「贴边隐藏」就不该藏起来——
    // 磁盘被手改成这种组合时（dock 有值但 dockEnabled 是 false），
    // 桌宠会一直藏到下一次设置变更才被取回。
    if (!getSettings().dockEnabled) return;
    const side = getSettings().dock;
    if (!side) return;
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const vis = currentVisibleRect();
    const wa = dockWorkArea();
    if (!vis || !wa) return;
    dock = side;
    const target = dockPosition(side, vis.x, vis.y, vis.width, vis.height, wa);
    const targetWin = windowRectForVisible(target, visibleRect);
    setWindowPosition(win, targetWin.x, targetWin.y);
  }

  /** 新一次拖拽开始：期望位置重置为当前真实位置。 */
  function dragStart() {
    const vis = currentVisibleRect();
    if (!vis) return;
    desired = { x: vis.x, y: vis.y };
    netDelta = { dx: 0, dy: 0 };
  }

  /**
   * 拖拽中：累加增量 → 夹紧 → 吸附 → 落盘。
   *
   * 停靠时沿停靠轴放宽（否则藏不到屏幕外）；
   * free 时在夹紧之后做吸附（推近了磁过去）。
   *
   * 累加与夹紧用的都是**本体**的矩形：本体才是用户看得见的东西，
   * 按整块画布算的话小模型永远差一截才贴得到边。
   */
  function moveBy(dx, dy) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    const vis = currentVisibleRect();
    if (!vis) return null;
    const w = vis.width;
    const h = vis.height;
    if (!desired) {
      desired = { x: vis.x, y: vis.y };
      netDelta = { dx: 0, dy: 0 };
    }
    desired.x += dx;
    desired.y += dy;
    netDelta.dx += dx;
    netDelta.dy += dy;

    const displays = getDisplays();
    let applied;
    if (dock) {
      const wa = dockWorkArea();
      applied = wa
        ? clampDocked(desired.x, desired.y, w, h, wa, dock)
        : clampToDisplays(desired.x, desired.y, w, h, displays);
    } else {
      applied = clampToDisplays(desired.x, desired.y, w, h, displays);
      if (getSettings().edgeSnap !== false) {
        const wa = displayForPoint(applied.x, applied.y, displays)?.workArea;
        if (wa) {
          const snapped = snapToEdge(applied.x, applied.y, w, h, wa, { dx, dy });
          if (snapped.side) {
            // 吸附只可能发生在**该轴未被夹紧**的时候（间隙在 (0, 阈值] 内，
            // 说明窗口还在工作区内），所以：
            //   snapped[该轴] − applied[该轴] = 磁吸挪动的那一点点，
            //   另一轴 snapped === applied，差值是 0，累加值原样保留。
            //
            // 整体覆盖会把另一轴上尚未被夹紧的累加值一起扔掉——
            // 那会让桌宠在跨轴吸附时与光标脱开，
            // 而「被边缘吃掉的增量不能永久丢失」是拖拽的老不变量。
            desired = {
              x: desired.x + (snapped.x - applied.x),
              y: desired.y + (snapped.y - applied.y),
            };
          }
          applied = { x: snapped.x, y: snapped.y };
        }
      }
    }
    // 本体的位置 → 窗口左上角。
    const winPos = windowRectForVisible(applied, visibleRect);
    setWindowPosition(win, winPos.x, winPos.y);
    persistPosition(applied, w, h);
    return applied;
  }

  /**
   * 落盘位置。
   *
   * 停靠时存的是「完全可见的贴齐位」——真实位置在屏幕外，
   * 重启时会被 restorePosition 判定为「不在任何显示器内」而回落到主显示器右下角。
   *
   * 存的是**窗口**的位置：下次启动要按窗口位置还原。
   */
  function persistPosition(applied, w, h) {
    const winPos = windowRectForVisible(applied, visibleRect);
    if (!dock) {
      applySettings({ position: { x: Math.round(winPos.x), y: Math.round(winPos.y) } });
      return;
    }
    const wa = dockWorkArea();
    if (!wa) {
      applySettings({ position: { x: Math.round(winPos.x), y: Math.round(winPos.y) } });
      return;
    }
    const flush = flushPosition(dock, applied.x, applied.y, w, h, wa);
    const flushWin = windowRectForVisible(flush, visibleRect);
    applySettings({ position: { x: Math.round(flushWin.x), y: Math.round(flushWin.y) } });
  }

  /**
   * 拖拽结束：判定要不要停靠。
   */
  function dragEnd() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const vis = currentVisibleRect();
    if (!vis) return;
    const x = vis.x;
    const y = vis.y;
    const w = vis.width;
    const h = vis.height;
    const displays = getDisplays();
    const wasDocked = dock;
    const net = { ...netDelta };
    desired = null;
    netDelta = { dx: 0, dy: 0 };

    if (wasDocked) {
      // 从停靠里出来的这一趟**不再判定停靠**：「拽出来」是明确的意思，
      // 不该在同一趟拖拽的末尾又塞回去。
      const wa = dockWorkArea();
      const stillTucked = wa ? isFullyTucked(x, y, w, h, wa, wasDocked) : true;
      if (stillTucked) {
        applySettings({ dock: wasDocked });
        return;
      }
      // 被拽出来了：取消停靠，**并把位置夹回工作区内**。
      //
      // 不夹的话会存下一个在屏幕外的坐标——桌宠还有一大半在屏幕外，
      // 而重启时 restorePosition 会判定它「不在任何显示器内」，
      // 悄悄回落到主显示器右下角。用户上次把桌宠放在哪就丢了。
      //
      // 夹回去之后桌宠是「完整可见、贴着那条边」的状态——
      // 也就是「完整滑回」，与预览里那条一致。
      const pulled = clampToDisplays(x, y, w, h, getDisplays());
      const pulledWin = windowRectForVisible(pulled, visibleRect);
      setWindowPosition(win, pulledWin.x, pulledWin.y);
      dock = null;
      applySettings({ dock: null });
      applySettings({ position: { x: Math.round(pulledWin.x), y: Math.round(pulledWin.y) } });
      onStateChanged?.();
      return;
    }

    if (!getSettings().dockEnabled) return;
    const wa = displayForPoint(x, y, displays)?.workArea;
    if (!wa) return;
    const gaps = edgeGaps(x, y, w, h, wa);
    // 净位移用**期望位置**的：桌宠贴边后就被夹住不动了，
    // 实际位移恒为 0，表达不了「我往右推」这个意图。
    const side = chooseDockSide(gaps, net);
    if (!side) return;
    dock = side;
    const target = dockPosition(side, x, y, w, h, wa);
    const targetWin = windowRectForVisible(target, visibleRect);
    setWindowPosition(win, targetWin.x, targetWin.y);
    applySettings({ dock: side });
    onStateChanged?.();
  }

  // —— 开机自启 ——

  /**
   * 写登录项。
   *
   * 开发态（未打包）必须带应用路径：那时 process.execPath 是 electron.exe，
   * 不带路径的话开机只会弹一个空白的 Electron 窗口。
   * 打包后 process.execPath 就是应用自己，不需要参数。
   *
   * `path` 写死 `process.execPath`：Electron 的默认值也是它，但写出来更清楚
   * （`process` 是 Node 全局，不算 import Electron，单元测试里也能断言）。
   */
  function writeLoginItem(enabled) {
    const args = isPackaged ? [] : [getAppPath()];
    loginItem.set({ openAtLogin: Boolean(enabled), path: process.execPath, args });
  }

  function applyAutoLaunch(enabled) {
    try {
      writeLoginItem(enabled);
      return null;
    } catch (err) {
      // 失败必须留痕：否则用户勾了「开机自启」而系统里根本没有注册项，
      // 而且没有任何线索可查。
      console.warn('[desk-pet] 开机自启设置失败：', err?.message || err);
      // 返回原因而不只是成败：界面上要告诉用户「是什么事、为什么」。
      return err?.message || '未知原因';
    }
  }

  /**
   * 读 Windows 登录项的真实状态。
   *
   * 返回 `null` = **读不到**（不是「没开」）。
   *
   * 「读不到」与「不一致」是两回事：读不到就不知道系统里是什么，
   * 不能因为一次读取失败就报「不一致」——那是在说一个没验证过的事。
   */
  function readLoginItem() {
    try {
      const state = loginItem.get?.();
      if (!state || typeof state.openAtLogin !== 'boolean') return null;
      return state.openAtLogin;
    } catch (err) {
      console.warn('[desk-pet] 读不到开机自启的登录项：', err?.message || err);
      return null;
    }
  }

  // —— 全局快捷键 ——

  /**
   * 注册一个组合。
   *
   * 返回 'ok' | 'taken' | 'invalid'：
   * - 'ok'：注册成功。
   * - 'taken'：**被别的程序占用**。`globalShortcut.register` 在这种情况下
   *   返回 false 而且**不抛错**（Windows 上是静默失败，Electron 文档明说
   *   这是操作系统的有意行为）。
   * - 'invalid'：**加速键串语法非法**，这时 register 会抛异常。
   *
   * **两者必须分开**：用户看到的提示不同。
   * 「被占用」要他去换个组合；「这个组合不能用」是设置本身写错了
   * （比如从磁盘上读进来一个手改坏的字符串）。混成一句话等于让用户瞎猜。
   */
  function registerShortcut(slotKey, accelerator) {
    const action = hotkeyActions?.[slotKey];
    if (typeof action !== 'function') {
      // 没有动作可绑定：注册了也白注册（按下去什么也不发生）。
      // 这是接线漏了，不是用户能改的东西——所以只留痕，不报给用户。
      console.error('[desk-pet] 快捷键没有对应的动作：', slotKey);
      return 'invalid';
    }
    try {
      if (shortcuts.register(accelerator, action)) return 'ok';
      // taken 也要留痕：被别的程序占用时 register **不抛错**，
      // 不留痕的话终端里什么都没有，用户只看到界面上一句提示。
      console.warn('[desk-pet] 快捷键注册失败：', shortcutErrorText('taken'));
      return 'taken';
    } catch (err) {
      console.warn('[desk-pet] 快捷键注册失败：', err?.message || err);
      return 'invalid';
    }
  }

  /** 注册失败时的提示语。 */
  function shortcutErrorText(result) {
    return result === 'invalid' ? '这个组合不能用' : '该组合已被其他程序占用';
  }

  /** 更新某个槽位的状态，并把它推给设置窗口。 */
  function setHotkeyStatus(slotKey, next) {
    const current = hotkeyStatus[slotKey] || { state: 'idle', accelerator: '', error: '' };
    hotkeyStatus = { ...hotkeyStatus, [slotKey]: { ...current, ...next } };
    notifyHotkeyStatus(slotKey);
  }

  /** 加速键串里至少要有一个修饰键。 */
  function hasModifier(accelerator) {
    return /(^|\+)(Control|Ctrl|Alt|Shift|Super|Command|Meta)(\+|$)/i.test(accelerator);
  }

  /**
   * 这个组合是不是还被**别的槽位**用着。
   *
   * 用它来决定注销旧组合时会不会把另一个快捷键一起搭进去：
   * 两个槽位指向同一个组合时（手改 settings.json 才会出现），
   * 注销其中一个就等于把另一个也弄没了。
   */
  function usedByOtherSlot(slotKey, accelerator) {
    return HOTKEY_SLOTS.some((s) => s.key !== slotKey && getSettings()[s.key] === accelerator);
  }

  /**
   * 换一组快捷键。
   *
   * **先注册新的、成功了再注销旧的**——反过来的话，失败时连原来的组合也丢了，
   * 用户会发现自己连原来那个能用的快捷键都按不动了。
   */
  function setHotkey(slotKey, accelerator) {
    const slot = getHotkeySlot(slotKey);
    if (!slot) return false;
    if (typeof accelerator !== 'string' || accelerator === '') return false;
    const current = getSettings()[slot.key];
    // 必须至少一个修饰键：裸键注册是全局的，会劫持用户的字母键
    // （规格 §4.3①）。buildAccelerator 已经保证过，这里再挡一道——
    // 因为 setHotkey 可能被别的通道直接调用。
    if (!hasModifier(accelerator)) {
      recordingSlot = null;
      setHotkeyStatus(slot.key, {
        state: 'error',
        accelerator: current,
        error: '这个组合不能用：至少要带一个修饰键（Ctrl / Alt / Shift）',
      });
      return false;
    }
    // 与当前相同：真的注册着才直接算成功。
    // 重复 register 同一个加速键会返回 false（那会被误报成「被占用」），
    // 但**没注册着**时不能就这么算成功——启动时注册失败（被别的程序占用）
    // 的情况下，用户再录一次同一个组合会被当成成功，而快捷键根本没生效。
    if (accelerator === current && shortcuts.isRegistered?.(current)) {
      recordingSlot = null;
      setHotkeyStatus(slot.key, { state: 'ok', accelerator, error: '' });
      return true;
    }
    // 与**另一个槽位**撞了：说清楚是被本应用自己的另一个快捷键占了。
    // 不先挡这一道的话，注册会失败成「该组合已被其他程序占用」——
    // 用户会去找别的程序，而真正占着它的是本应用自己。
    const clash = HOTKEY_SLOTS.find(
      (s) => s.key !== slot.key && getSettings()[s.key] === accelerator
    );
    if (clash) {
      recordingSlot = null;
      setHotkeyStatus(slot.key, {
        state: 'error',
        accelerator: current,
        error: `这个组合已经被「${clash.label}」用了`,
      });
      return false;
    }
    const result = registerShortcut(slot.key, accelerator);
    if (result !== 'ok') {
      recordingSlot = null;
      setHotkeyStatus(slot.key, {
        state: 'error',
        accelerator: current,
        error: shortcutErrorText(result),
      });
      return false;
    }
    // 注销旧的。**同一个组合不注销**——刚注册上的就是它自己，
    // 注销等于把新组合也一起搭进去。
    if (current && current !== accelerator && !usedByOtherSlot(slot.key, current)) {
      try {
        shortcuts.unregister(current);
      } catch (err) {
        // 注销失败不该把新组合也搭进去：新组合已经注册成功了，
        // 仍然要落盘——否则用户按新键有用、重启后失效。
        console.warn('[desk-pet] 旧快捷键注销失败：', err?.message || err);
      }
    }
    applySettings({ [slot.key]: accelerator });
    recordingSlot = null;
    setHotkeyStatus(slot.key, { state: 'ok', accelerator, error: '' });
    return true;
  }

  /**
   * 清除一个快捷键（= 不设它）。
   *
   * 只有允许为空的槽位能清：「呼出/隐藏桌宠」那个空了就没有召回手段，
   * 界面上也不给「清除」按钮。
   */
  function clearHotkey(slotKey) {
    const slot = getHotkeySlot(slotKey);
    if (!slot || !slot.allowEmpty) return false;
    const current = getSettings()[slot.key];
    if (current) {
      try {
        shortcuts.unregister(current);
      } catch (err) {
        // 注销失败也要往下走：设置必须改成「不设」，
        // 否则界面上写着已清除，重启后那个组合又回来了。
        console.warn('[desk-pet] 快捷键注销失败：', err?.message || err);
      }
    }
    applySettings({ [slot.key]: '' });
    recordingSlot = null;
    // accelerator 清空：这一条推送要能表达「现在没有组合了」。
    setHotkeyStatus(slot.key, { state: 'idle', accelerator: '', error: '' });
    return true;
  }

  function startRecording(slotKey) {
    const slot = getHotkeySlot(slotKey);
    if (!slot) return false;
    // 一次只能录一个（按键捕获是全局的）。
    // 别的槽位若还停在「录制中」，那是不该有的残留状态
    // （用户直接点了另一个的录制按钮）——把它收回「空闲」，
    // 否则界面上那一行会一直写着「请按下组合键…」。
    for (const other of HOTKEY_SLOTS) {
      if (other.key === slot.key) continue;
      if (hotkeyStatus[other.key]?.state === 'recording') {
        setHotkeyStatus(other.key, { state: 'idle' });
      }
    }
    recordingSlot = slot.key;
    setHotkeyStatus(slot.key, { state: 'recording', error: '' });
    return true;
  }

  function cancelRecording() {
    if (recordingSlot) {
      const slot = recordingSlot;
      recordingSlot = null;
      setHotkeyStatus(slot, { state: 'idle', error: '' });
    }
    return true;
  }

  function isRecording() {
    return recordingSlot !== null;
  }

  /**
   * 录制中的一次按键，返回拼好的组合；不是组合时返回 null。
   *
   * **返回值不代表成功**：注册成功与否看 `hotkeyStatus`。
   */
  function handleInput(input) {
    if (!recordingSlot) return null;
    if (input?.key === 'Escape') {
      cancelRecording();
      return null;
    }
    const acc = buildAccelerator(input);
    if (!acc) return null;
    setHotkey(recordingSlot, acc);
    return acc;
  }

  // —— 状态上报 ——

  function getState() {
    const settings = getSettings();
    return {
      autoLaunch: Boolean(settings.autoLaunch),
      // 系统里真正生效的值（读登录项读到的）。
      // 与 autoLaunch 不一致 = 磁盘与 Windows 登录项对不上（见 init）。
      autoLaunchActive: Boolean(applied?.autoLaunch),
      hotkey: settings.hotkey,
      panelHotkey: settings.panelHotkey,
      // 每个槽位一份状态：{ hotkey: {...}, panelHotkey: {...} }。
      hotkeyStatus: { ...hotkeyStatus },
      clickThrough: Boolean(settings.clickThrough),
      clickThroughActive: Boolean(applied?.clickThrough),
      // 「光标在形象的透明处」：那块空白不吃点击。
      // 与上面那个不是一回事：上面是整个窗口不吃点击。
      pixelClickThrough: Boolean(pixelClickThrough),
      edgeSnap: settings.edgeSnap !== false,
      dockEnabled: Boolean(settings.dockEnabled),
      dock,
      // 最近一次失败的原因（空串 = 没有失败）。
      // Task 8 的设置窗口「系统」分区要把它显示出来——
      // 只在终端留痕的话，用户在界面上看不到任何异样。
      lastError,
    };
  }

  // —— 对外接口 ——

  /**
   * 启动时恢复。
   *
   * 注意：**不重新注册登录项**——用户在系统设置里手动删掉了注册项，
   * 应用一启动就给它加回去，那是在跟用户较劲。只在用户改动开关时才写。
   */
  function init(settings) {
    applied = {
      autoLaunch: Boolean(settings.autoLaunch),
      clickThrough: Boolean(settings.clickThrough),
    };
    // 上一次看到的意图 = 磁盘上的值。
    // 启动时**不重新写注册表**（见下面的说明），所以基线就是磁盘上的值：
    // 用户没动过开关时，后面的 applySettings 不该去写注册表。
    lastAutoLaunchIntent = Boolean(settings.autoLaunch);
    // 开机自启：磁盘上的设置与 Windows 登录项可能对不上
    // （用户在「任务管理器 → 启动」里把注册项删了）。
    // 这种不一致**检测不到也不说**，用户看到的是「已开启」而系统里根本没有登录项。
    // 必须说出来：写进 lastError，设置窗口会显示它。
    const registered = readLoginItem();
    if (registered !== null) {
      // applied.autoLaunch 记的是「系统里真正生效的值」——不是磁盘上的说法。
      applied.autoLaunch = registered;
      if (registered !== Boolean(settings.autoLaunch)) {
        const message = registered
          ? '设置里关着「开机自启」，但系统里还留着登录项：重新打开再关闭一次即可清掉'
          : '设置里开着「开机自启」，但系统里没有登录项：重新打开再关闭一次即可修复';
        // 留痕也要有：终端里一条说得清原因的警告。
        console.warn('[desk-pet] 开机自启与系统登录项不一致：', message);
        lastError = message;
      }
    }
    // 穿透模式要在窗口建好之后立刻生效。
    // 默认（关）时**不要**调 setIgnoreMouseEvents：窗口本来就是可点的，
    // 多余的一次原生调用没有意义，还会让「本次只调了一次」的断言变复杂。
    if (settings.clickThrough) applyClickThrough(true);
    // 停靠：把窗口挪到藏起来的位置（settings.dock 记着上次藏在哪条边）。
    applyDockAtStartup();
    // 快捷键：启动时就注册。失败只留痕 + 在设置窗口显示状态，不阻断启动。
    for (const slot of HOTKEY_SLOTS) {
      const value = settings[slot.key];
      // 空 = 不设这个快捷键（唤醒输入框那个默认就是空的）。
      if (!value) continue;
      if (!hasModifier(value)) {
        // 磁盘上的组合没有修饰键：注册它会劫持用户的字母键。
        // 宁可先不注册，也不能把用户的键抢走。
        console.warn('[desk-pet] 设置里的快捷键没有修饰键，已跳过注册：', value);
        setHotkeyStatus(slot.key, {
          state: 'error',
          accelerator: value,
          error: '这个组合不能用：至少要带一个修饰键（Ctrl / Alt / Shift）',
        });
        continue;
      }
      const result = registerShortcut(slot.key, value);
      if (result === 'ok') {
        setHotkeyStatus(slot.key, { state: 'ok', accelerator: value, error: '' });
      } else {
        // 启动就失败要留痕：否则用户以为快捷键设好了，按下去没反应，
        // 而终端里什么也没有。registerShortcut 已经留过痕了，这里不再重复 warn。
        setHotkeyStatus(slot.key, {
          state: 'error',
          accelerator: value,
          error: shortcutErrorText(result),
        });
      }
    }
  }

  function applyClickThrough(enabled) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // 两个来源取或：
    //   - 设置里的「鼠标穿透」：整个窗口不吃点击（用户主动开的）；
    //   - 渲染层报的「光标在形象的透明处」：只有那块空白不吃点击。
    //
    // 设置里开着时，透明处的判定是多余的（整窗都不吃），
    // 但取或的结果一样，不会打架。
    //
    // forward: true 让 mousemove 继续送到渲染层——
    // 桌宠仍然能跟着光标转头，但点击落到桌面上。
    if (enabled || pixelClickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  }

  /**
   * 切换穿透模式，返回切换后的状态。
   *
   * 只调 applySettings 就够了：那条链会回到 applySettingsToSystem，
   * 由它统一施加效果（那里才有「真的变了才动作」的判断）。
   * 这里**不要**再直接调 applyClickThrough——那会施加两次。
   */
  function toggleClickThrough() {
    const next = !getSettings().clickThrough;
    applySettings({ clickThrough: next });
    return next;
  }

  /**
   * 设置变了：把真的变了的那部分落到实际效果上。
   */
  function applySettingsToSystem(settings) {
    if (!applied) applied = { autoLaunch: false, clickThrough: false };
    const patch = {};
    // 这次变更里有没有「做失败了」的事：有的话最后要通知外面，
    // 让界面知道出了错——失败不能是静默的。
    let failed = false;

    // —— 开机自启 ——
    //
    // **只在用户的意图变了的时候才写注册表。**
    //
    // 判据是「上一次看到的意图」（lastAutoLaunchIntent），不是
    // 「上一次生效的值」（applied.autoLaunch）：后者在关闭方向失败时
    // 故意不动（系统里的注册项其实还在），拿它当判据的话，
    // persist() 在拖拽的每一帧调过来都会重试一次——
    // 一次失败被放大成每秒几十次注册表写入 + 日志 + 广播 + 托盘菜单重建。
    //
    // 回退落盘（开启失败时把磁盘改回 false）不算「意图变了」：
    // 那不是用户按的开关，是控制器自己纠正磁盘。
    if (!autoLaunchRollback) {
      const want = Boolean(settings.autoLaunch);
      // 判断必须在更新之前：反过来判断永远相等。
      // 还没有基线时（第一次看到）只记下来——不知道基线就不知道是不是变了。
      const intentChanged = lastAutoLaunchIntent !== null && want !== lastAutoLaunchIntent;
      lastAutoLaunchIntent = want;
      if (intentChanged) {
        const error = applyAutoLaunch(want);
        if (error) {
          failed = true;
          // 说清是什么事、为什么：用户看到「开机自启没打开」时，
          // 得知道是注册表写不进去还是别的。
          lastError = `开机自启${want ? '开启' : '关闭'}失败：${error}`;
          // 写失败：不管开关是开还是关，注册项与磁盘都可能不一致。
          //
          // 关闭方向：**不动 applied**——留着旧值，系统里的注册项其实还在；
          // 用户下次改动这个开关时会再试一次。
          //
          // 打开方向：必须把磁盘改回去——磁盘上的 true 是假的，
          // 用户重启后会以为自启开着。
          if (want) {
            patch.autoLaunch = false;
            applied.autoLaunch = false;
            // **意图要跟着磁盘一起回退。**
            //
            // 意图 = 磁盘上现在是什么。磁盘被回退成 false 了，意图还停在 true 的话，
            // 下一次 persist（拖拽的下一帧、或者任何别的设置变更）就会看到
            // 「want=false ≠ 意图=true」→ 又写一次注册表，
            // 并把 lastError 从「开启失败」覆盖成「关闭失败」（写成功则直接清空）。
            // 用户看到的是一条**方向相反**的失败原因——那正是要消灭的东西。
            lastAutoLaunchIntent = false;
          }
        } else {
          applied.autoLaunch = want;
          lastError = '';
        }
      }
    }

    if (Boolean(settings.clickThrough) !== Boolean(applied.clickThrough)) {
      applyClickThrough(Boolean(settings.clickThrough));
      applied.clickThrough = Boolean(settings.clickThrough);
      onStateChanged?.();
    }

    // 「贴边隐藏」被关掉时，正在停靠的桌宠要立刻取回来：
    // 不然用户关了开关、桌宠还赖在屏幕外，开关看起来没生效。
    if (settings.dockEnabled === false && dock) {
      undock();
    }

    // 先把回退落盘，再通知外面：通知时 settings 必须已经是回退后的值，
    // 否则界面会停留在「已开启」而磁盘上已经是「关闭」。
    if (Object.keys(patch).length > 0) {
      // 回退期间不算「意图变了」：磁盘上的 false 是控制器自己写的，
      // 不是用户按的开关。否则回退会立刻触发一次新的写入，
      // 把「开启失败」这条原因覆盖成「关闭失败」。
      autoLaunchRollback = true;
      try {
        applySettings(patch);
      } finally {
        autoLaunchRollback = false;
      }
    }
    if (failed) onStateChanged?.();
  }

  return {
    init,
    applySettings: applySettingsToSystem,
    getState,
    // —— 边缘吸附与贴边停靠 ——
    dragStart,
    moveBy,
    dragEnd,
    retrievePet,
    undock,
    // —— 桌宠本体的可见矩形 ——
    // 渲染层量出来的：窗口里真正画着形象的那一块。
    // 夹紧、吸附、停靠都按它算（见 setVisibleRect）。
    setVisibleRect,
    // —— 鼠标穿透 ——
    toggleClickThrough,
    // 「光标在形象的透明处」：那块空白不吃点击。
    setPixelClickThrough,
    // —— 全局快捷键 ——
    setHotkey,
    startRecording,
    clearHotkey,
    cancelRecording,
    isRecording,
    handleInput,
    dispose() {
      // 退出时注销快捷键：不注销的话这个组合会一直被占着，
      // 下次启动注册不上。
      try {
        shortcuts.unregisterAll();
      } catch {
        /* ignore */
      }
    },
  };
}
