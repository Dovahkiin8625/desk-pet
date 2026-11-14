/**
 * 前沿小部件：当前选中的那个榜，一眼看完。
 *
 * 自带 preload（window.plugin）：数据从 onTick / data() 来，
 * 动作走 act()；整块能拖，✕ 关掉，▣ 变回独立窗口。
 *
 * 网络慢的时候榜单可能要等一会儿：切换/刷新会立刻进入「加载中」，
 * 数据到了（act 的回执或哪边推过来的快照）再退出。
 */

import { hydrateIcons } from '/src/renderer/ui/icons.js';
import { bindTheme } from '/src/renderer/ui/theme.js';

hydrateIcons();
bindTheme(window.plugin);

const feedSelect = document.getElementById('feed');
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const loadingEl = document.getElementById('loading');
const spinEl = document.getElementById('spin');
const updatedEl = document.getElementById('updated');

/** 下拉框只建一次：重建会把用户正打开的下拉关掉。 */
let feedsBuilt = false;

/** 没跑完的动作数：点击到回执之间先给个转圈。 */
let pending = 0;
/** 最近一次拿到的数据：loading 状态算它和 pending 的并集。 */
let lastData = null;

function isLoading() {
  return pending > 0 || Boolean(lastData?.loading);
}

/** 按「有没有内容 × 是不是在加载」决定显示谁。 */
function applyLoading() {
  const loading = isLoading();
  const has = Boolean(lastData && Array.isArray(lastData.items) && lastData.items.length > 0);
  listEl.hidden = !has;
  loadingEl.hidden = has || !loading;
  emptyEl.hidden = has || loading;
  spinEl.hidden = !loading;
}

function buildFeeds(feeds) {
  if (feedsBuilt || !Array.isArray(feeds)) return;
  for (const feed of feeds) {
    const opt = document.createElement('option');
    opt.value = feed.id;
    opt.textContent = feed.label;
    feedSelect.append(opt);
  }
  feedsBuilt = true;
}

function render(data) {
  if (!data) return;
  lastData = data;
  buildFeeds(data.feeds);
  if (feedSelect.value !== data.feed) feedSelect.value = data.feed;

  listEl.replaceChildren();
  const items = Array.isArray(data.items) ? data.items : [];
  for (const [i, item] of items.entries()) {
    const row = document.createElement('button');
    row.className = 'row';
    row.type = 'button';
    row.title = item.title;

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `${i + 1}`;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title;

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = item.hint || '';

    row.append(rank, title, hint);
    row.addEventListener('click', () => {
      void window.plugin?.act?.('open', { url: item.url });
    });
    listEl.append(row);
  }
  emptyEl.textContent = data.error ? `暂时拉不到（${data.error}）` : '暂时没有内容';
  applyLoading();

  updatedEl.textContent = data.at ? `更新于 ${new Date(data.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
}

/**
 * 发一个动作：立刻进入加载态，回执到了再按数据里的 loading 决定去留。
 * 慢网络下 fetch 还在路上时，snapshot 里 loading=true，转圈继续转。
 */
function sendAction(actionId, payload) {
  pending += 1;
  applyLoading();
  let request;
  try {
    request = window.plugin?.act?.(actionId, payload);
  } catch {
    request = null;
  }
  Promise.resolve(request)
    .then(render)
    .catch(() => {})
    .finally(() => {
      pending -= 1;
      applyLoading();
    });
}

feedSelect.addEventListener('change', () => {
  sendAction('feed', { feed: feedSelect.value });
});

document.getElementById('refresh').addEventListener('click', () => {
  sendAction('refresh');
});

document.getElementById('expand').addEventListener('click', () => {
  // 切形态会重建窗口，这一页马上就死了。
  window.plugin?.window?.setMode?.('window');
});

document.getElementById('close').addEventListener('click', () => {
  window.plugin?.window?.close?.();
});

// 宿主按 widget.refreshMs 推 tick；打开时先给一份 data。
window.plugin?.onTick?.(render);
window.plugin?.onData?.(render);
void window.plugin?.data?.().then(render);
