/**
 * 主题。
 *
 * 两个维度：
 * - **主题**（theme）：一套配色。由 `src/renderer/ui/themes/<id>.css` 定义——
 *   加一个主题就是往那个目录里放一个 css 文件，不用改别处的代码；
 * - **明暗**（mode）：浅色 / 深色 / 跟随系统。
 *
 * 每个主题的 css 里，浅色与深色并排写在 light-dark() 里，
 * 到底用哪一边由 <html data-scheme> 决定（见 src/renderer/ui/theme.css）。
 *
 * 设置存在 settings.json 里（见 src/main/settings.js），
 * 主进程把它广播给所有窗口，渲染层据此给 <html> 标 data-theme 与 data-scheme。
 *
 * 颜色本身全在主题的 css 文件里——这里只有「有哪几种」这件事。
 */

/** 浅色。 */
export const MODE_LIGHT = 'light';
/** 深色。 */
export const MODE_DARK = 'dark';
/** 跟着系统的设置走。 */
export const MODE_SYSTEM = 'system';

/** 全部明暗模式（设置页按这个顺序排）。 */
export const MODES = Object.freeze([MODE_LIGHT, MODE_DARK, MODE_SYSTEM]);

/** 默认是浅色：桌宠是暖色的，浅色底更贴它。 */
export const DEFAULT_MODE = MODE_LIGHT;

/** 明暗模式 → 给人看的名字。 */
export const MODE_LABELS = Object.freeze({
  [MODE_LIGHT]: '浅色',
  [MODE_DARK]: '深色',
  [MODE_SYSTEM]: '跟随系统',
});

/** 兜底的主题 id（themes 目录里读不到主题时用不着）。 */
export const DEFAULT_THEME = 'warm';

/** 把任意输入规整成一个合法的明暗模式；认不出来的回默认值。 */
export function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/**
 * 把「用户选的那一套」定成「这一帧用哪一套」。
 *
 * @param {string} mode 用户选的（light / dark / system）
 * @param {boolean} prefersDark 系统此刻是不是深色
 * @returns {'light'|'dark'}
 */
export function resolveMode(mode, prefersDark) {
  const m = normalizeMode(mode);
  if (m === MODE_SYSTEM) return prefersDark ? MODE_DARK : MODE_LIGHT;
  return m;
}
