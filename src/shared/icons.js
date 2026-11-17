/**
 * 图标集。
 *
 * 一份 SVG 路径，主进程与渲染层共用：
 * - 主进程校验清单里的 `icon` 是不是真图标（不是就退回默认的那个）；
 * - 渲染层把它画成 SVG（`src/renderer/ui/icons.js`）。
 *
 * 全部是 24×24 的线性图标：描边、颜色跟文字走（currentColor），
 * 于是换主题时图标也跟着变，不需要第二套图。
 *
 * **不收 emoji**：emoji 在不同系统上长得不一样（有的还是彩色），
 * 跟界面里其它线条统一的图标摆在一起会很跳。
 */

/** 图标名 → SVG 内部标记（不含 <svg> 外壳）。 */
export const ICONS = Object.freeze({
  // —— 通用 ——
  plugin:
    '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line>',
  settings:
    '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
  close:
    '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
  trash:
    '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
  check: '<polyline points="20 6 9 17 4 12"></polyline>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"></circle>',
  ring: '<circle cx="12" cy="12" r="5"></circle>',

  // —— 方向 ——
  back: '<polyline points="15 18 9 12 15 6"></polyline>',
  forward: '<polyline points="9 18 15 12 9 6"></polyline>',
  external:
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>',
  shrink:
    '<polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line>',
  frame:
    '<polyline points="4 8 4 4 8 4"></polyline><polyline points="16 4 20 4 20 8"></polyline><polyline points="20 16 20 20 16 20"></polyline><polyline points="8 20 4 20 4 16"></polyline>',
  pin:
    '<path d="M9.5 3h5l-.8 5.6 3.3 3.2V13H7v-1.2l3.3-3.2L9.5 3z"></path><line x1="12" y1="13" x2="12" y2="21"></line>',
  square: '<rect x="3" y="3" width="18" height="18" rx="2"></rect>',

  // —— 内容 ——
  search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
  sparkles:
    '<path d="M11 3l1.8 4.7L17.5 9.5l-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8L11 3z"></path><path d="M18 14l.9 2.3 2.3.9-2.3.9L18 20.4l-.9-2.3-2.3-.9 2.3-.9L18 14z"></path>',
  chat:
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"></path>',
  monitor:
    '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>',
  file:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
  image:
    '<rect x="3" y="5" width="18" height="14" rx="2"></rect><circle cx="8.5" cy="10" r="1.5"></circle><path d="M21 15l-4.5-4.5L9 18"></path>',
  globe:
    '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
  history:
    '<path d="M3 3v5h5"></path><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path><polyline points="12 7 12 12 15 14"></polyline>',
  list:
    '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>',
  'list-checks':
    '<line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><polyline points="3 6 4 7 6 5"></polyline><polyline points="3 12 4 13 6 11"></polyline><polyline points="3 18 4 19 6 17"></polyline>',
  'check-square':
    '<polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
  activity:
    '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>',
  clock: '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
  timer:
    '<circle cx="12" cy="13" r="8"></circle><path d="M12 9v4l2.5 1.5"></path><line x1="9" y1="2" x2="15" y2="2"></line><line x1="12" y1="2" x2="12" y2="5"></line>',
  bell:
    '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>',
  clipboard:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>',
  folder:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',
  music:
    '<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>',
  note: '<path d="M9 18V5l10-2v13"></path><circle cx="6" cy="18" r="3"></circle>',
  prev:
    '<polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line>',
  next:
    '<polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"></path>',
  pause:
    '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"></rect><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"></rect>',
  video:
    '<polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>',
  'cloud-sun':
    '<circle cx="6.5" cy="6.5" r="2.6"></circle><line x1="6.5" y1="1.6" x2="6.5" y2="2.8"></line><line x1="1.6" y1="6.5" x2="2.8" y2="6.5"></line><line x1="3.2" y1="3.2" x2="4" y2="4"></line><line x1="9.8" y1="3.2" x2="9" y2="4"></line><path d="M18 12h-1.26A7 7 0 1 0 10 21h8a4.5 4.5 0 0 0 0-9z"></path>',
  sun:
    '<circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line>',
  cloud:
    '<path d="M17.5 19a4.5 4.5 0 0 0 .42-8.98 7 7 0 0 0-13.65 1.7A4 4 0 0 0 6 19h11.5z"></path>',
  'cloud-rain':
    '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path><line x1="16" y1="13" x2="16" y2="21"></line><line x1="8" y1="13" x2="8" y2="21"></line><line x1="12" y1="15" x2="12" y2="23"></line>',
  'cloud-drizzle':
    '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"></path><line x1="8" y1="19" x2="8" y2="19"></line><line x1="8" y1="23" x2="8" y2="23"></line><line x1="12" y1="17" x2="12" y2="17"></line><line x1="12" y1="21" x2="12" y2="21"></line><line x1="16" y1="19" x2="16" y2="19"></line><line x1="16" y1="23" x2="16" y2="23"></line>',
  'cloud-snow':
    '<path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"></path><line x1="8" y1="16" x2="8.01" y2="16"></line><line x1="8" y1="20" x2="8.01" y2="20"></line><line x1="12" y1="18" x2="12.01" y2="18"></line><line x1="12" y1="22" x2="12.01" y2="22"></line><line x1="16" y1="16" x2="16.01" y2="16"></line><line x1="16" y1="20" x2="16.01" y2="20"></line>',
  'cloud-fog':
    '<path d="M20 15.5a4.5 4.5 0 0 0-2-8.47h-.93A7.5 7.5 0 1 0 5.5 13"></path><line x1="4" y1="18" x2="20" y2="18"></line><line x1="7" y1="21.5" x2="17" y2="21.5"></line>',
  'cloud-lightning':
    '<path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9"></path><polyline points="13 11 9 17 15 17 11 23"></polyline>',
  wind:
    '<path d="M9.59 4.59A2 2 0 1 1 11 8H2"></path><path d="M12.59 19.41A2 2 0 1 0 14 16H2"></path><path d="M17.73 7.73A2.5 2.5 0 1 1 19.5 12H2"></path>',
  droplet:
    '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path>',
  leaf:
    '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path>',
  refresh:
    '<polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>',
  cpu:
    '<rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line>',
  thermometer:
    '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"></path>',
  battery:
    '<rect x="1" y="6" width="18" height="12" rx="2" ry="2"></rect><line x1="23" y1="13" x2="23" y2="11"></line>',
  wifi:
    '<path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M1.42 9a16 16 0 0 1 21.16 0"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line>',
  memory:
    '<rect x="2" y="6" width="20" height="9" rx="2"></rect><line x1="6" y1="18" x2="6" y2="21"></line><line x1="10" y1="18" x2="10" y2="21"></line><line x1="14" y1="18" x2="14" y2="21"></line><line x1="18" y1="18" x2="18" y2="21"></line><line x1="6" y1="10.5" x2="7" y2="10.5"></line><line x1="10" y1="10.5" x2="11" y2="10.5"></line><line x1="14" y1="10.5" x2="15" y2="10.5"></line>',
});

/** 清单里没写图标（或写了个不存在的）时用这个。 */
export const DEFAULT_ICON = 'plugin';

/** 全部图标名（校验与文档用）。 */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** 这个名字是不是一个图标。 */
export function isIconName(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name);
}

/**
 * 把清单里写的图标规整成一个真图标的名字。
 *
 * 认不出来的（写错了、或者写的是个 emoji）一律退回默认的那个——
 * 界面照样画得出来，只是用的是默认图标。
 */
export function normalizeIconName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return isIconName(trimmed) ? trimmed : DEFAULT_ICON;
}
