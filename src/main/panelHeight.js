import { displayForPoint } from './display.js';

/**
 * 面板高度的上限：按**桌宠所在那块屏**的工作区算。
 *
 * 面板的窗口是按内容撑开的（插件页面报多高，窗口就开多高），
 * 所以总得有个上限——不然一个长页面能把窗口顶到屏幕外面去。
 *
 * 为什么按工作区算而不是写死一个数：插件页面会长。
 * 录屏的工作台就有六百多像素高，写死的上限会把它的底部裁掉，
 * 用户看到的正是「显示不全，底部被截断」。
 * 按工作区算：屏幕装得下就让它长到内容那么高，装不下才收
 * （收的那一截在面板内部滚动，不会消失）。
 *
 * 单独成文件是为了能单测：这个函数不碰 Electron。
 */

/**
 * 面板高度的上限（像素）。
 *
 * @param {object} options
 * @param {Array} [options.displays] 显示器列表（Electron 的 screen.getAllDisplays()）
 * @param {object} [options.petRect] 桌宠本体的矩形（屏幕坐标）
 * @param {number} [options.fallback] 拿不到显示器信息时的兜底
 * @param {number} [options.minimum] 再小也要留这么多（面板自己的下限）
 * @param {number} [options.margin] 上下留的余量（别贴着屏幕边）
 * @returns {number}
 */
export function maxPanelHeight({
  displays = [],
  petRect = null,
  fallback = 560,
  minimum = 160,
  margin = 24,
} = {}) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (!list.length) return fallback;

  // 跟着桌宠走：桌宠在第二块屏上，面板就按那块屏算上限。
  let display = list[0];
  if (petRect && Number.isFinite(petRect.x) && Number.isFinite(petRect.y)) {
    const cx = petRect.x + (Number(petRect.width) || 0) / 2;
    const cy = petRect.y + (Number(petRect.height) || 0) / 2;
    display = displayForPoint(cx, cy, list) || display;
  }

  const work = display.workArea;
  if (!work) return fallback;
  return Math.max(minimum, Math.round(work.height - margin));
}
