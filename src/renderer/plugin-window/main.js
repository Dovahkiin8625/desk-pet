import { renderPage } from '../ui/blocks.js';

/**
 * 插件的独立窗口。
 *
 * 窗口永远是「壳 + 内容」：
 *
 * - 上面是插件的标题与窗口按钮（置顶 / 变成小部件 / 关闭）——**壳是宿主的**；
 * - 下面要么是插件自带的页面（装在 iframe 里），
 *   要么是插件的声明式页面（积木，与面板里画的是同一份描述）。
 *
 * 插件自带页面时装在 iframe 里而不是直接替换整个窗口：
 * 这样面板工作台与独立窗口**结构完全相同**，只有容器宽度不同——
 * 同一份页面两处用，界面天然是一套。
 *
 * 小部件是另一种形态：它把插件的页面**原样加载**（带 preload），壳不参与。
 */

const winEl = document.getElementById('win');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const bodyEl = document.getElementById('body');
const statusEl = document.getElementById('status');
const pinEl = document.getElementById('pin');
const modeEl = document.getElementById('mode');
const closeEl = document.getElementById('close');
const frameEl = document.getElementById('plugin-frame');

/** 当前是哪种形态：`window` 或 `widget`。 */
let mode = window.plugin?.mode || 'window';
/** 插件 id：动作要带着它回去。 */
const pluginId = window.plugin?.id || '';

/**
 * 画插件的页面。
 *
 * 插件自带的页面已经装在 iframe 里了（主进程给的 `src`），
 * 这时候壳只管标题栏，**不要**再画一遍积木——画两遍内容就重了。
 *
 * 宿主推来的东西**最终**会统一包成 `{ pluginId, data }`（Task 7 之后），
 * 但 Task 6 这一刻主进程那边还在发**裸值**。
 * 所以两种都认：认信封就拆包，不是信封就当它是页面本身。
 */
function render(payload) {
  const isEnvelope =
    payload && typeof payload === 'object' && 'pluginId' in payload && 'data' in payload;
  const page = isEnvelope ? payload.data : payload;
  if (!page) return;
  titleEl.textContent = page.title || '';
  subtitleEl.textContent = page.subtitle || '';
  statusEl.textContent = page.status || '';
  if (winEl.dataset.content === 'page') return; // 插件自带页面：内容在 iframe 里
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
  // 插件自带页面时宿主不推页面描述，标题栏会空着——
  // 拿插件的名字顶上（宿主推来的页面描述里有更准的标题，推来了就用它的）。
  if (!titleEl.textContent) titleEl.textContent = state.title || '';
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

/**
 * 报到：主进程收到「准备好了」才会把数据推过来。
 */
function reportReady() {
  window.plugin?.reportReady?.();
}

// 插件页面（在 iframe 里）发来的消息：底部那行字。
//
// 用 `event.source` 认人：别的窗口也能往这里 postMessage，
// 只有自己那个 iframe 说的才算数。
//
// 装 iframe **之前**就挂上：页面一加载完就可能往回报消息。
window.addEventListener('message', (event) => {
  if (!frameEl.contentWindow || event.source !== frameEl.contentWindow) return;
  const data = event.data || {};
  if (data.type === 'desk-pet:surface:status') {
    statusEl.textContent = String(data.text || '');
  }
});

// 插件自带的页面：主进程把它的完整 URL 放在 `src` 查询参数里。
//
// 装进 iframe 而不是直接加载：这样**壳**（标题栏、置顶、关闭）是宿主的，
// 面板工作台那边也是「壳 + iframe」——两处结构一样，界面才是一套。
const src = new URLSearchParams(location.search).get('src') || '';
if (src) {
  frameEl.src = src;
  frameEl.hidden = false;
  winEl.dataset.content = 'page';
  // **等页面加载完再报到**：主进程一收到「准备好了」就推第一份数据，
  // 而插件页面要先把监听器挂上——页面还没加载完时推过来，就没人接了
  // （插件页面通过 `parent.plugin.onData(...)` 订阅，走的是同一个
  // 渲染进程里 preload 的监听器）。
  frameEl.addEventListener('load', () => reportReady(), { once: true });
} else {
  // 没有自带页面：壳自己画积木，现在就可以报到。
  reportReady();
}

void syncState();
