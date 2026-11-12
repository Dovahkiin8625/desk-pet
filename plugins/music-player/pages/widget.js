// plugins/music-player/pages/widget.js
/**
 * 桌面小部件：挂在桌面上的迷你播放器。
 *
 * 小部件的页面是**原样加载**的（自带 preload，不走壳、不走 iframe），
 * 所以这里用的是裸 API：`window.plugin`。
 */
import { formatTime } from '../lib/format.js';

const $ = (id) => document.getElementById(id);

const el = {
  title: $('title'),
  sub: $('sub'),
  bar: $('bar'),
  fill: $('fill'),
  time: $('time'),
  prev: $('prev'),
  play: $('play'),
  next: $('next'),
  lyrics: $('lyrics'),
  expand: $('expand'),
  close: $('close'),
};

/** 主进程给的状态。 */
let state = { playing: false, position: 0, duration: 0, lyricsOpen: false };

function applyState(next) {
  if (!next) return;
  state = { ...state, ...next };
  const cur = state.current;
  el.title.textContent = cur ? cur.title : '还没在放';
  el.sub.textContent = cur
    ? `${cur.artist ? cur.artist + ' · ' : ''}${state.playing ? '在放' : '暂停'}`
    : state.trackCount
      ? `${state.sourceLabel || '默认列表'} ${state.trackCount} 首`
      : '还没有歌';
  el.time.textContent = `${formatTime(state.position)} / ${formatTime(state.duration)}`;
  const ratio = state.duration > 0 ? state.position / state.duration : 0;
  el.fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  el.play.textContent = state.playing ? '⏸' : '▶';
  el.lyrics.setAttribute('aria-pressed', state.lyricsOpen ? 'true' : 'false');
}

/** 送一个动作给主进程。 */
async function act(actionId, payload) {
  try {
    const res = await window.plugin.act(actionId, payload);
    if (res?.state) applyState(res.state);
  } catch {
    /* 主进程没答：下一轮 tick 会把状态带过来。 */
  }
}

el.prev.addEventListener('click', () => act('prev'));
el.play.addEventListener('click', () => act('toggle'));
el.next.addEventListener('click', () => act('next'));
el.lyrics.addEventListener('click', () => act('lyrics', { enabled: !state.lyricsOpen }));

el.bar.addEventListener('click', (event) => {
  if (!state.duration) return;
  const rect = el.bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  act('seek', { seconds: ratio * state.duration });
});

el.expand.addEventListener('click', () => {
  // 变回独立窗口：切形态会重建窗口，这一页马上就死了。
  window.plugin?.window?.setMode?.('window');
});

el.close.addEventListener('click', () => {
  window.plugin?.window?.close?.();
});

window.plugin?.onTick?.(applyState);
window.plugin?.onData?.(applyState);
void window.plugin?.data?.().then(applyState);
