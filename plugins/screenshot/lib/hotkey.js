// plugins/screenshot/lib/hotkey.js
import { electron } from './electron.js';

/**
 * 全局快捷键。
 *
 * 与录屏、剪贴板插件同一个套路：先把旧的全部注销，再注册新的——
 * Electron 的 globalShortcut 是全局的，同一个键注册两次会失败，
 * 而「先注销再注册」是唯一稳妥的换法。
 *
 * Electron 的接口走 lib/electron.js 的**懒加载**：直接 import 的话，
 * 插件在没有 Electron 的环境里（单测）就加载不上。
 */

/** accel → 回调 */
const registered = new Map();

/**
 * 注册一组快捷键。
 *
 * @param {Array<{accel: string, onTrigger: () => void}>} entries
 * @returns {Promise<{ok: boolean, failed: string[]}>} 有没有注册成功的
 */
export async function setHotkeys(entries) {
  const { globalShortcut } = await electron();
  await clearHotkeys();
  const failed = [];
  if (!globalShortcut) return { ok: false, failed: (entries || []).map((e) => String(e?.accel || '')).filter(Boolean) };
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
      console.warn('[截图] 快捷键注册不了：', err?.message);
      failed.push(accel);
    }
  }
  return { ok: failed.length === 0, failed };
}

/** 注销全部。 */
export async function clearHotkeys() {
  const { globalShortcut } = await electron();
  if (!globalShortcut) return;
  for (const accel of registered.keys()) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      // 已经没了就算了。
    }
  }
  registered.clear();
}
