/**
 * 资讯小部件：当前选中的那个榜，一眼看完。
 *
 * 自带 preload（window.plugin）：数据从 onTick / data() 来，
 * 动作走 act()；整块能拖，✕ 关掉，▣ 变回独立窗口。
 */

import { hydrateIcons } from '/src/renderer/ui/icons.js';
import { bindTheme } from '/src/renderer/ui/theme.js';

hydrateIcons();
bindTheme(window.plugin);

const feedSelect = document.getElementById('feed');
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const updatedEl = document.getElementById('updated');

/** 下拉框只建一次：重建会把用户正打开的下拉关掉。 */
let feedsBuilt = false;

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
  listEl.hidden = items.length === 0;
  emptyEl.hidden = items.length !== 0;
  emptyEl.textContent = data.error ? `暂时拉不到（${data.error}）` : '暂时没有内容';

  updatedEl.textContent = data.at ? `更新于 ${new Date(data.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
}

feedSelect.addEventListener('change', () => {
  void window.plugin?.act?.('feed', { feed: feedSelect.value }).then(render);
});

document.getElementById('refresh').addEventListener('click', () => {
  void window.plugin?.act?.('refresh').then(render);
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
