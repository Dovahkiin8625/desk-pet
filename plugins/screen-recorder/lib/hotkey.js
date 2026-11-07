// plugins/screen-recorder/lib/hotkey.js
import { globalShortcut } from 'electron';

/**
 * 全局快捷键。
 *
 * 一次管**两个**：开始录制、停止录制。
 * 分开设比一个「切换」键好用——开始与停止是两种不同的意图，
 * 合成一个键的话，用户得先想想「现在是录着还是没录」。
 */

/** accel → 回调。 */
let registered = new Map();

/**
 * 注册一组快捷键。
 *
 * **先把旧的全部注销再注册新的**：Electron 的 globalShortcut 是全局的，
 * 同一个键注册两次会失败，而「先注销再注册」是唯一稳妥的换法。
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
      console.warn('[录屏] 快捷键注册不了：', err?.message);
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
