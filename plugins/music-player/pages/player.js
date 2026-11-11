// plugins/music-player/pages/player.js
/**
 * 音乐播放器的界面（面板里与独立窗口里是同一份）。
 *
 * 三件事：
 *
 * - **画**：主进程给什么就画什么（首份、推来的新状态、动作的回包）；
 * - **送动作**：点一下就送一个动作给主进程；
 * - **报高度**：面板的窗口是按内容撑开的，页面要报自己的高度。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { formatTime } from '../lib/format.js';

const surface = bindSurface();

// 面板里与独立窗口里，高度策略是**相反**的（见 body.dp-panel）。
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const $ = (id) => document.getElementById(id);

const el = {
  folder: $('folder'),
  pick: $('pick'),
  scan: $('scan'),
  npTitle: $('np-title'),
  npSub: $('np-sub'),
  bar: $('bar'),
  barFill: $('bar-fill'),
  pos: $('pos'),
  dur: $('dur'),
  prev: $('prev'),
  play: $('play'),
  next: $('next'),
  vol: $('vol'),
  lyrics: $('lyrics'),
  libCount: $('lib-count'),
  mode: $('mode'),
  list: $('list'),
  empty: $('empty'),
};

/** 主进程给的状态。 */
let state = { tracks: [], index: -1, playing: false, position: 0, duration: 0, volume: 0.8 };
/** 曲库上次画的是哪一版（变了才重画列表）。 */
let listVersion = -1;

/** 送一个动作给主进程，顺手把回来的状态画上去。 */
async function act(actionId, payload) {
  try {
    const res = await surface.act(actionId, payload);
    if (res?.state) applyState(res.state);
    if (res?.message) surface.setStatus(res.message);
  } catch (err) {
    surface.setStatus(`做不了：${err?.message || err}`);
  }
}

function applyState(next) {
  if (!next) return;
  state = { ...state, ...next };
  render();
}

function render() {
  const cur = state.current;
  el.npTitle.textContent = cur ? cur.title : '还没在放';
  el.npSub.textContent = cur
    ? `${cur.artist ? cur.artist + ' · ' : ''}${state.playing ? '在放' : '暂停'}`
    : state.trackCount
      ? `曲库里 ${state.trackCount} 首`
      : '选一个音乐文件夹开始';
  el.pos.textContent = formatTime(state.position);
  el.dur.textContent = formatTime(state.duration);
  const ratio = state.duration > 0 ? state.position / state.duration : 0;
  el.barFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  el.play.textContent = state.playing ? '⏸' : '▶';
  el.folder.textContent = state.folder || '';
  el.folder.title = state.folder || '';
  el.vol.value = String(Math.round((state.volume ?? 0.8) * 100));
  el.lyrics.setAttribute('aria-pressed', state.lyricsOpen ? 'true' : 'false');
  el.mode.value = state.modeLabel || '顺序播放';
  el.libCount.textContent = state.scanning
    ? '正在扫…'
    : state.trackCount
      ? `曲库 ${state.trackCount} 首`
      : '曲库';
  el.empty.hidden = state.trackCount > 0;
  renderList();
}

/** 画曲库：列表没变就不重画（重画会把滚动位置弄丢）。 */
function renderList() {
  if (listVersion !== state.libraryVersion) {
    listVersion = state.libraryVersion;
    el.list.textContent = '';
    for (const track of state.tracks || []) {
      const li = document.createElement('li');
      li.dataset.index = String(el.list.children.length);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = track.title;
      li.append(label);
      if (track.artist) {
        const artist = document.createElement('span');
        artist.className = 'artist';
        artist.textContent = track.artist;
        li.append(artist);
      }
      el.list.append(li);
    }
  }
  const items = el.list.children;
  for (let i = 0; i < items.length; i += 1) {
    items[i].classList.toggle('current', i === state.index);
  }
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

el.pick.addEventListener('click', () => act('choose-folder'));
el.scan.addEventListener('click', () => act('scan'));
el.prev.addEventListener('click', () => act('prev'));
el.play.addEventListener('click', () => act('toggle'));
el.next.addEventListener('click', () => act('next'));
el.lyrics.addEventListener('click', () => act('lyrics', { enabled: !state.lyricsOpen }));

el.vol.addEventListener('change', () => act('volume', { value: Number(el.vol.value) / 100 }));

el.mode.addEventListener('change', () => act('mode', { value: el.mode.value }));

el.list.addEventListener('click', (event) => {
  const item = event.target.closest('li');
  if (!item) return;
  act('select', { index: Number(item.dataset.index) });
});

// 点进度条跳到那儿。
el.bar.addEventListener('click', (event) => {
  if (!state.duration) return;
  const rect = el.bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  act('seek', { seconds: ratio * state.duration });
});

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

surface.onData((data) => applyState(data));
surface.onTick((data) => applyState(data));
void surface.data().then((data) => applyState(data));

// ---------------------------------------------------------------------------
// 报高度：面板的窗口是按内容撑开的
// ---------------------------------------------------------------------------

function reportHeight() {
  requestAnimationFrame(() => {
    // 量**内容**的高度，不是视口的（见插件开发指南）。
    const rect = document.body.getBoundingClientRect();
    surface.setHeight(Math.ceil(Math.max(rect.height, document.body.scrollHeight)));
  });
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => reportHeight()).observe(document.body);
}
window.addEventListener('resize', reportHeight);
reportHeight();
