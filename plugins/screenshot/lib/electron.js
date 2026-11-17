// plugins/screenshot/lib/electron.js
/**
 * Electron 的接口**按需取**。
 *
 * 直接 import 的话，插件就只能在 Electron 里加载（单测里加载不上）。
 * 这里等到真要用的时候再取——取不到的那些功能（单测里）自然用不到。
 */
let electronModule = null;

/** @returns {Promise<any>} electron 模块 */
export async function electron() {
  if (!electronModule) electronModule = await import('electron');
  return electronModule;
}
