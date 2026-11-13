/**
 * 图标的画法。
 *
 * 图标本身在 `src/shared/icons.js`（主进程也要用：校验清单里写的图标名），
 * 这里只负责把它变成 DOM 里的 SVG。
 *
 * 页面里不写死 SVG：写 `<span class="icon" data-icon="close"></span>`，
 * 页面脚本调一次 `hydrateIcons()` 就换成真的图标——
 * 图标只有一份，页面里抄一份迟早会漂移。
 */

import { ICONS, DEFAULT_ICON } from '../../shared/icons.js';

/** 图标线的粗细。 */
const STROKE_WIDTH = 1.8;

/**
 * 图标的自备尺寸。
 *
 * 真正的大小由 CSS 说了算（`.dp-icon` 是 1em，跟着字号走）；
 * 这个只是「样式还没来时」的兜底。
 */
const DEFAULT_SIZE = 16;

/**
 * 造一个图标。
 *
 * @param {string} name 图标名（见 shared/icons.js 的 ICONS）
 * @param {object} [options]
 * @param {string} [options.className] 挂在 SVG 上的类名
 * @param {string} [options.title] 有标题时图标不再是「装饰」，会被读出来
 * @returns {SVGSVGElement}
 */
export function iconSvg(name, { className = '', title = '' } = {}) {
  const key = ICONS[name] ? name : DEFAULT_ICON;
  const markup = ICONS[key];

  // 用 <template> 解析：HTML 文档里直接把标记塞进 innerHTML，
  // 里面的标签会按 HTML 解析（<circle> 变成未知的 HTML 元素）。
  // template 会按 SVG 上下文解析出真正的 SVG 元素。
  const template = document.createElement('template');
  template.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${DEFAULT_SIZE}" height="${DEFAULT_SIZE}"` +
    ` fill="none" stroke="currentColor" stroke-width="${STROKE_WIDTH}"` +
    ` stroke-linecap="round" stroke-linejoin="round">${markup}</svg>`;

  const svg = template.content.firstElementChild;
  // 图标名留在图上：自动化要能认出「这是哪个图标」。
  svg.setAttribute('data-icon', key);
  svg.setAttribute('class', ['dp-icon', className].filter(Boolean).join(' '));
  if (title) {
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    label.textContent = title;
    svg.prepend(label);
    svg.setAttribute('role', 'img');
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  return svg;
}

/**
 * 把页面里占位的图标换成真的图标。
 *
 * 占位写法：`<span class="icon" data-icon="close"></span>`。
 * 图标装在占位元素**里面**（不是把它换掉）——
 * 页面里的脚本还按 class 找它（显示/隐藏都靠那个元素）。
 *
 * @param {ParentNode} [root] 从哪儿开始找（默认整篇文档）
 */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    // 图标自己身上也有 data-icon：别把已经画好的图标再画一遍。
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    const name = el.dataset.icon || '';
    // 占位用完了就把标记摘掉：页面上只该留下真正的图标。
    el.removeAttribute('data-icon');
    el.textContent = '';
    el.append(iconSvg(name));
  }
}

/**
 * 换掉一个元素里的图标（图标会变的那种：播放/暂停、置顶/取消置顶）。
 *
 * @param {Element} el 元素
 * @param {string} name 图标名
 * @param {object} [options] 同 iconSvg
 */
export function setIcon(el, name, options = {}) {
  if (!el) return;
  const svg = iconSvg(name, options);
  el.textContent = '';
  el.append(svg);
}
