// plugins/clipboard/lib/hotkey.js
import { globalShortcut } from 'electron';

/**
 * 全局快捷键。
 *
 * 一次管**两个**：打开历史窗口、粘贴最近一条。
 *
 * 与录屏插件那一份是同一个套路：先把旧的全部注销再注册新的——
 * Electron 的 globalShortcut 是全局的，同一个键注册两次会失败，
 * 而「先注销再注册」是唯一稳妥的换法。
 */

/** accel → 回调。 */
let registered = new Map();

/**
 * 注册一组快捷键。
 *
 * @param {Array<{accel: string, onTrigger: () => void}>} entries
 * @returns {{ok: boolean, failed: string[]}} 有没有注册成功的
 */
export function setHotkeys(entries) {
  clearHotkeys();
  const failed = [];
  for (const entry of entries || []) {
    const accel = String(entry?.accel || '').trim();
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, entry.onTrigger);
      if (ok) {
        registered.set(accel, entry.onTrigger);
      } else {
        failed.push(accel);
      }
    } catch (err) {
      console.warn('[剪贴板] 快捷键注册不了：', err?.message);
      failed.push(accel);
    }
  }
  return { ok: failed.length === 0, failed };
}

/** 注销全部。 */
export function clearHotkeys() {
  for (const accel of registered.keys()) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      // 已经没了就算了。
    }
  }
  registered = new Map();
}

/** 现在注册着哪些键。 */
export function currentHotkeys() {
  return [...registered.keys()];
}
