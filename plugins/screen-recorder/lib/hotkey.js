// plugins/screen-recorder/lib/hotkey.js
import { globalShortcut } from 'electron';

let registered = null;

/**
 * 注册全局快捷键。
 *
 * 只有**工作台窗口开着**的时候才注册：关掉工作台就把这个组合键
 * 让回给别的程序——一个常驻抢键的录屏插件是很讨人厌的。
 *
 * @param {string} accel Electron 的快捷键写法，如 'Control+Shift+R'
 * @param {() => void} onTrigger
 * @returns {boolean} 注册成功吗
 */
export function registerHotkey(accel, onTrigger) {
  unregisterHotkey();
  if (!accel) return false;
  try {
    const ok = globalShortcut.register(accel, onTrigger);
    if (ok) registered = accel;
    return ok;
  } catch (err) {
    console.warn('[录屏] 快捷键注册不了：', err?.message);
    return false;
  }
}

/** 注销。 */
export function unregisterHotkey() {
  if (!registered) return;
  try {
    globalShortcut.unregister(registered);
  } catch {
    // 已经没了就算了。
  }
  registered = null;
}

/** 现在注册着哪个键。 */
export function currentHotkey() {
  return registered || '';
}
