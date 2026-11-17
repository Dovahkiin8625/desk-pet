// plugins/translate/lib/clipboard.js
/**
 * 写剪贴板。
 *
 * Electron 的 clipboard **按需取**：直接 import 的话，
 * 插件就只能在 Electron 里加载（单测里加载不上）。
 *
 * 测试要换掉「真的写进系统剪贴板」这一步时，给 globalThis 挂一个
 * `__deskPetTranslateClipboardWriter(text)`（只给测试用——
 * 宿主加载的是插件在临时目录里的副本，模块级的注入到不了那边；
 * `globalThis.fetch` 在单测里就是这么换的）。
 */
let electronModule = null;

/**
 * 往剪贴板写一段文字。
 *
 * @param {string} text 要写的内容
 * @throws {Error} 这个环境里没有剪贴板（比如单测里）
 */
export async function writeClipboard(text) {
  const content = String(text ?? '');
  const hook = globalThis.__deskPetTranslateClipboardWriter;
  if (typeof hook === 'function') {
    await hook(content);
    return;
  }
  if (!electronModule) electronModule = await import('electron');
  const clipboard = electronModule?.clipboard;
  if (!clipboard?.writeText) throw new Error('这个环境里没有剪贴板');
  clipboard.writeText(content);
}
