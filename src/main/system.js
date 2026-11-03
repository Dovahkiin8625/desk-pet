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

/**
 * 系统级开关的控制器：开机自启、全局快捷键、鼠标穿透、边缘吸附与贴边停靠。
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
  onHotkeyAction,
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
  // 当前停靠在哪条边（null = 没停靠）。
  let dock = null;
  // 本次拖拽的期望位置（未夹紧）与净位移。
  let desired = null;
  let netDelta = { dx: 0, dy: 0 };
  // 快捷键录制中。
  let recording = false;
  let hotkeyStatus = { state: 'idle', accelerator: '', error: '' };
  // 最近一次失败的说明。空串 = 没有失败。
  // 它是「界面上说得出来」那半的载体：光在终端留痕，用户看不见。
  let lastError = '';

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

  // —— 状态上报 ——

  function getState() {
    const settings = getSettings();
    return {
      autoLaunch: Boolean(settings.autoLaunch),
      hotkey: settings.hotkey,
      hotkeyStatus: { ...hotkeyStatus },
      clickThrough: Boolean(settings.clickThrough),
      clickThroughActive: Boolean(applied?.clickThrough),
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
    // 穿透模式要在窗口建好之后立刻生效。
    // 默认（关）时**不要**调 setIgnoreMouseEvents：窗口本来就是可点的，
    // 多余的一次原生调用没有意义，还会让「本次只调了一次」的断言变复杂。
    if (settings.clickThrough) applyClickThrough(true);
  }

  function applyClickThrough(enabled) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // forward: true 让 mousemove 继续送到渲染层——
    // 桌宠仍然能跟着光标转头，但点击落到桌面上。
    if (enabled) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
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

    if (Boolean(settings.autoLaunch) !== Boolean(applied.autoLaunch)) {
      const want = Boolean(settings.autoLaunch);
      const error = applyAutoLaunch(want);
      if (error) {
        failed = true;
        // 说清是什么事、为什么：用户看到「开机自启没打开」时，
        // 得知道是注册表写不进去还是别的。
        lastError = `开机自启${want ? '开启' : '关闭'}失败：${error}`;
        // 写失败：不管开关是开还是关，注册项与磁盘都可能不一致。
        //
        // 关闭方向：**不动 applied**——留着旧值，下一次 applySettings 会重试；
        // 若把 applied 记成 false，控制器就以为已经关了（系统里的注册项还在，
        // 下次开机照样自启），而且此后同值的 applySettings 永远不会再试。
        //
        // 打开方向：必须把磁盘改回去——磁盘上的 true 是假的，
        // 用户重启后会以为自启开着。
        if (want) {
          patch.autoLaunch = false;
          applied.autoLaunch = false;
        }
      } else {
        applied.autoLaunch = want;
        lastError = '';
      }
    }

    if (Boolean(settings.clickThrough) !== Boolean(applied.clickThrough)) {
      applyClickThrough(Boolean(settings.clickThrough));
      applied.clickThrough = Boolean(settings.clickThrough);
      onStateChanged?.();
    }

    // 先把回退落盘，再通知外面：通知时 settings 必须已经是回退后的值，
    // 否则界面会停留在「已开启」而磁盘上已经是「关闭」。
    if (Object.keys(patch).length > 0) applySettings(patch);
    if (failed) onStateChanged?.();
  }

  return {
    init,
    applySettings: applySettingsToSystem,
    getState,
    dispose() {},
  };
}
