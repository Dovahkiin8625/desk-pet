/**
 * 主题的接法。
 *
 * 颜色在主题的 css 文件里（`src/renderer/ui/themes/<id>.css`，
 * 浅色与深色并排写在 light-dark() 里），这里只负责**决定用哪一套**：
 * 给 <html> 标一个 data-theme（用哪套配色）与 data-scheme（浅色还是深色），
 * CSS 里的 color-scheme 与那组变量据此取色。
 *
 * 为什么不靠 `prefers-color-scheme`：
 * 主进程换 `nativeTheme.themeSource` 时，渲染层**不一定**立刻跟着换
 * （自动化环境里就不换），用户点了「深色」而界面没反应是最糟的。
 * 自己标 data-scheme 则一定生效。
 *
 * 主进程那边已经把「跟随系统」定成了浅色或深色
 * （渲染层问不到系统，也不该问——问的结果不一定跟得上）。
 */

import { normalizeMode } from '../../shared/theme.js';

/**
 * 把主题定下来。
 *
 * @param {object} theme
 * @param {string} theme.theme 主题 id（themes 目录里的文件名）
 * @param {string} theme.scheme 'light' / 'dark'（已定下来的明暗）
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme?.theme) root.dataset.theme = theme.theme;
  root.dataset.scheme = normalizeMode(theme?.scheme);
}

/**
 * 把主题套到插件页面（iframe）上。
 *
 * iframe 是**另一个文档**：CSS 变量不会从父页面穿过去，
 * 得亲手把那个文档的 <html> 也标上。
 *
 * @param {HTMLIFrameElement} frame
 */
export function applyThemeToFrame(frame) {
  const doc = frame?.contentDocument;
  const root = doc?.documentElement;
  if (!root) return;
  const { theme = '', scheme = '' } = document.documentElement.dataset;
  if (root.dataset.theme === theme && root.dataset.scheme === scheme) return;
  if (theme) root.dataset.theme = theme;
  else root.removeAttribute('data-theme');
  if (scheme) root.dataset.scheme = scheme;
  else root.removeAttribute('data-scheme');
}

/**
 * 接上主题：跟着主进程推来的那一套变。
 *
 * @param {object} api preload 上挂着的那份能力（有 onTheme 就算数）
 * @param {Function} [onApply] 换完之后额外要做的事（壳要把主题转给 iframe）
 */
export function bindTheme(api, onApply) {
  api?.onTheme?.((theme) => {
    applyTheme(theme);
    onApply?.(theme);
  });
  // 刚打开的窗口：问主进程要当前的主题。
  //
  // 广播只发给**已经开着**的窗口；这个窗口开在广播之后，
  // 就等不到那一条了——不问一句，它会按默认的浅色待着。
  Promise.resolve(api?.theme?.())
    .then((theme) => {
      if (!theme) return;
      applyTheme(theme);
      onApply?.(theme);
    })
    .catch(() => {
      /* 问不到就算了：页面里的主题是主进程标上去的，不算错 */
    });
}
