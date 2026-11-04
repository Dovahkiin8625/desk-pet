import { renderPage } from '../ui/blocks.js';

/**
 * 插件的**通用**独立窗口。
 *
 * 插件没有自己的页面时（清单里没写 `page`），宿主就套这一层：
 * 上面是插件的标题与窗口按钮（置顶 / 变成小部件 / 关闭），
 * 下面是插件的声明式页面——与面板里画的是同一份描述。
 *
 * 插件自己有页面时（清单里写了 `page`），走的是插件自己的 HTML，
 * 这一层不参与。
 */

const winEl = document.getElementById('win');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const bodyEl = document.getElementById('body');
const statusEl = document.getElementById('status');
const pinEl = document.getElementById('pin');
const modeEl = document.getElementById('mode');
const closeEl = document.getElementById('close');

/** 当前是哪种形态：`window` 或 `widget`。 */
let mode = window.plugin?.mode || 'window';
/** 插件 id：动作要带着它回去。 */
const pluginId = window.plugin?.id || '';

/** 画插件的页面。 */
function render(page) {
  if (!page) return;
  titleEl.textContent = page.title || '';
  subtitleEl.textContent = page.subtitle || '';
  statusEl.textContent = page.status || '';
  renderPage(page, {
    body: bodyEl,
    onAction: (actionId, value) => {
      window.plugin?.action?.(actionId, value);
    },
  });
}

/** 把窗口按钮的状态同步成当前的形态与置顶情况。 */
async function syncState() {
  const state = await window.plugin?.window?.state?.();
  if (!state) return;
  winEl.dataset.mode = state.mode || mode;
  // 小部件永远置顶：那个按钮没有意义，藏起来。
  pinEl.hidden = state.mode === 'widget';
  pinEl.classList.toggle('on', Boolean(state.alwaysOnTop));
  // 没有小部件形态的插件就不给「变小」的按钮。
  modeEl.hidden = !state.canWidget;
  modeEl.title = state.mode === 'widget' ? '变回独立窗口' : '变成桌面小部件';
}

pinEl.addEventListener('click', async () => {
  const on = await window.plugin?.window?.setAlwaysOnTop?.(!pinEl.classList.contains('on'));
  pinEl.classList.toggle('on', Boolean(on));
});

modeEl.addEventListener('click', async () => {
  const next = winEl.dataset.mode === 'widget' ? 'window' : 'widget';
  // 切形态会重建窗口：这一页马上就死了，后面的事交给新窗口。
  await window.plugin?.window?.setMode?.(next);
});

closeEl.addEventListener('click', () => {
  window.plugin?.window?.close?.();
});

// Esc 关掉窗口：小部件挂在桌面上时也能这么收起来。
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.plugin?.window?.close?.();
  }
});

// 主进程下发页面：宿主算好的声明式描述。
window.plugin?.onPage?.(render);

// 先注册监听器再报到：反过来主进程发来的页面会被丢弃。
window.plugin?.reportReady?.();
void syncState();
