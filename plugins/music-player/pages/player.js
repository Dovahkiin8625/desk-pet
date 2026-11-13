// plugins/music-player/pages/player.js
/**
 * 音乐播放器的界面（面板里与独立窗口里是同一份）。
 *
 * 三件事：
 *
 * - **画**：主进程给什么就画什么（首份、推来的新状态、动作的回包）；
 * - **送动作**：点一下就送一个动作给主进程；
 * - **报高度**：面板里报一个定高（窗口不跟内容一高一低），独立窗口按内容。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { createDrawer } from '/src/renderer/ui/drawer.js';
import { formatTime } from '../lib/format.js';

const surface = bindSurface();

// 面板里与独立窗口里，高度策略是**相反**的（见 body.dp-panel）。
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const $ = (id) => document.getElementById(id);

const el = {
  back: $('back'),
  filter: $('filter'),
  playlists: $('playlists'),
  plNew: $('pl-new'),
  plNewRow: $('pl-new-row'),
  plName: $('pl-name'),
  plNameOk: $('pl-name-ok'),
  plNameCancel: $('pl-name-cancel'),
  plFolder: $('pl-folder'),
  plSong: $('pl-song'),
  mainCover: $('main-cover'),
  mainCoverImg: $('main-cover-img'),
  mainCoverFallback: $('main-cover-fallback'),
  mainName: $('main-name'),
  mainCount: $('main-count'),
  playAll: $('play-all'),
  list: $('list'),
  empty: $('empty'),
  now: $('now'),
  nowCover: $('now-cover'),
  nowCoverImg: $('now-cover-img'),
  nowCoverFallback: $('now-cover-fallback'),
  npTitle: $('np-title'),
  npSub: $('np-sub'),
  track: $('track'),
  trackFill: $('track-fill'),
  pos: $('pos'),
  dur: $('dur'),
  prev: $('prev'),
  play: $('play'),
  next: $('next'),
  gear: $('gear'),
  menu: $('menu'),
  menuCover: $('menu-cover'),
  menuCoverReset: $('menu-cover-reset'),
  songPage: $('song-page'),
  songClose: $('song-close'),
  songCover: $('song-cover'),
  songCoverImg: $('song-cover-img'),
  songCoverFallback: $('song-cover-fallback'),
  songName: $('song-name'),
  songArtist: $('song-artist'),
  songLyrics: $('song-lyrics'),
};

/** 播放模式：图标上写什么字。 */
const MODES = [
  { label: '顺序播放' },
  { label: '单曲循环' },
  { label: '随机播放' },
];

// ---------------------------------------------------------------------------
// 设置抽屉
//
// 播放器的设置（音量、播放模式、桌面歌词）都在这里：
// 与剪贴板插件、宿主的面板共用同一份抽屉（src/renderer/ui/drawer.js）。
// ---------------------------------------------------------------------------

const drawer = createDrawer({ button: el.gear });

/** 抽屉里的一行：左边是名字，右边是控件。 */
function settingRow(name, control) {
  const row = document.createElement('label');
  row.className = 'dp-field';
  const label = document.createElement('span');
  label.textContent = name;
  row.append(label, control);
  return row;
}

const volInput = document.createElement('input');
volInput.id = 'setVolume';
volInput.className = 'dp-range';
volInput.type = 'range';
volInput.min = '0';
volInput.max = '100';

const modeSelect = document.createElement('select');
modeSelect.id = 'setMode';
modeSelect.className = 'dp-input';
for (const mode of MODES) {
  const option = document.createElement('option');
  option.value = mode.label;
  option.textContent = mode.label;
  modeSelect.append(option);
}

const lyricsInput = document.createElement('input');
lyricsInput.id = 'setLyrics';
lyricsInput.type = 'checkbox';

drawer.body.append(
  settingRow('音量', volInput),
  settingRow('播放模式', modeSelect),
  settingRow('桌面歌词', lyricsInput)
);

// 抽屉里的三个控件（它们不在底部的控制条里）。
el.vol = volInput;
el.mode = modeSelect;
el.lyrics = lyricsInput;

/** 主进程给的状态。 */
let state = {
  tracks: [],
  playlists: [],
  covers: {},
  currentCover: null,
  lyrics: null,
  lyricIndex: -1,
  index: -1,
  playing: false,
  position: 0,
  duration: 0,
  volume: 0.8,
};
/** 歌单那一栏上次画的是哪一版。 */
let sideSig = '';
/** 歌曲列表上次画的是哪一版。 */
let listSig = '';
/** 搜索框里的字。 */
let filter = '';
/** 正在放着的那首歌的下标（用来把它滚进视野）。 */
let lastIndex = -1;
/** 菜单是给哪个歌单开的。 */
let menuPlaylistId = '';
/** 删歌单要点两下：第一下记住是哪个。 */
let confirmingId = '';
/**
 * 音量滑块上现在显示的值。
 *
 * 主进程每 500ms 推一次状态。用户正拖着滑块的时候把它顶回去，
 * 看着就像「点了一下又弹回去了」——所以只有主进程给的音量**真的变了**
 * 才动滑块。
 */
let volShown = -1;
/** 播放页面（正在放的那一首）开着没有。 */
let songPageOpen = false;
/** 歌词里唱到第几行了（变了才滚一次）。 */
let lastLyricIndex = -1;

/** 切窄版看的那一块：'playlists' 歌单列表 / 'songs' 歌曲列表（宽版两栏都在，不受影响）。 */
function setView(next) {
  document.body.dataset.view = next === 'songs' ? 'songs' : 'playlists';
}

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
  renderNow();
  renderSide();
  renderList();
  renderSong();
  el.filter.placeholder = `在「${state.sourceLabel || '默认列表'}」里搜`;
}

/** 底部那条：现在在放什么、走到哪儿了。 */
function renderNow() {
  const cur = state.current;
  el.npTitle.textContent = cur ? cur.title : '还没在放';
  el.npSub.textContent = cur
    ? `${cur.artist ? cur.artist + ' · ' : ''}${state.playing ? '在放' : '暂停'}`
    : `${state.sourceLabel || '默认列表'} ${state.trackCount || 0} 首`;
  el.pos.textContent = formatTime(state.position);
  el.dur.textContent = formatTime(state.duration);
  const ratio = state.duration > 0 ? state.position / state.duration : 0;
  el.trackFill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  el.play.textContent = state.playing ? '⏸' : '▶';
  renderSettings();
  renderNowCover();
}

/** 抽屉里的设置项：跟着状态走。 */
function renderSettings() {
  // 音量：主进程给的数没变就别动滑块（见 volShown）。
  const vol = Math.round((state.volume ?? 0.8) * 100);
  if (vol !== volShown) {
    volShown = vol;
    el.vol.value = String(vol);
  }
  const mode = MODES.find((m) => m.label === state.modeLabel) || MODES[0];
  if (el.mode.value !== mode.label) el.mode.value = mode.label;
  if (el.lyrics.checked !== Boolean(state.lyricsOpen)) el.lyrics.checked = Boolean(state.lyricsOpen);
}

/** 底部那块的小封面：这一首自己的图。 */
function renderNowCover() {
  const cover = currentCoverUrl();
  if (cover) {
    el.nowCoverImg.src = cover;
    el.nowCoverImg.hidden = false;
    el.nowCoverFallback.hidden = true;
  } else {
    el.nowCoverImg.removeAttribute('src');
    el.nowCoverImg.hidden = true;
    el.nowCoverFallback.hidden = false;
  }
}

/** 这一首的封面（封面是跟着歌走的，对不上号就别用）。 */
function currentCoverUrl() {
  const cover = state.currentCover;
  if (!cover || !state.current) return '';
  return cover.file === state.current.file ? cover.url : '';
}

/** 这一首的歌词（歌词也是跟着歌走的，对不上号就别用）。 */
function currentLyrics() {
  const lyrics = state.lyrics;
  if (!lyrics || !state.current) return [];
  return lyrics.file === state.current.file ? lyrics.lines : [];
}

/** 歌单那一栏（封面 + 名字 + 首数）。 */
function renderSide() {
  const playlists = state.playlists || [];
  const sig = [
    playlists.map((p) => `${p.id}:${p.name}:${p.count}`).join(','),
    state.activePlaylistId,
  ].join('|');
  if (el.playlists.dataset.sig !== sig) {
    el.playlists.dataset.sig = sig;
    el.playlists.textContent = '';
    for (const playlist of playlists) {
      const li = document.createElement('li');
      li.dataset.id = playlist.id;
      if (playlist.id === state.activePlaylistId) li.classList.add('on');
      const cover = document.createElement('div');
      cover.className = 'cover';
      li.append(cover);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = playlist.name;
      li.append(name);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = playlist.count ? `${playlist.count}` : '';
      li.append(count);
      if (playlist.id !== state.defaultPlaylistId) {
        const remove = document.createElement('button');
        remove.className = 'rm';
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = '删掉这个歌单';
        remove.dataset.id = playlist.id;
        li.append(remove);
      }
      el.playlists.append(li);
    }
  }
  renderCovers();
}

/**
 * 封面单独换。
 *
 * 封面是异步算出来的：重画整列会把鼠标底下的删除按钮弄没，
 * 所以这里只换图，行本身不动。
 */
function renderCovers() {
  const covers = state.covers || {};
  for (const li of el.playlists.children) {
    const cover = li.querySelector('.cover');
    if (!cover) continue;
    const url = covers[li.dataset.id] || '';
    if (cover.dataset.url === url) continue;
    cover.dataset.url = url;
    cover.textContent = '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      cover.append(img);
    } else {
      cover.textContent = '♪';
    }
  }
}

/** 歌曲列表：列表没变就不重画（重画会把滚动位置弄丢）。 */
function renderList() {
  const tracks = state.tracks || [];
  const sig = `${state.listVersion}|${state.activePlaylistId}|${filter}`;
  if (el.list.dataset.sig !== sig) {
    el.list.dataset.sig = sig;
    el.list.textContent = '';
    const query = filter.trim().toLowerCase();
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      if (query && !matchTrack(track, query)) continue;
      const li = document.createElement('li');
      li.dataset.index = String(i);
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      li.append(idx);
      const bars = document.createElement('span');
      bars.className = 'bars';
      bars.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      li.append(bars);
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
      const remove = document.createElement('button');
      remove.className = 'rm';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = '从这个列表里拿掉';
      remove.dataset.file = track.file;
      li.append(remove);
      el.list.append(li);
    }
  }
  const items = el.list.children;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const on = Number(item.dataset.index) === state.index;
    item.classList.toggle('on', on);
    item.classList.toggle('playing', on && state.playing);
  }
  if (state.index !== lastIndex) {
    lastIndex = state.index;
    const current = el.list.querySelector('li.on');
    current?.scrollIntoView({ block: 'nearest' });
  }
  el.mainName.textContent = state.sourceLabel || '默认列表';
  el.mainCount.textContent = `${state.trackCount || 0} 首`;
  el.playAll.disabled = !(state.tracks || []).length;
  const noMatch = Boolean(filter.trim()) && !el.list.children.length;
  el.empty.hidden = (state.tracks || []).length > 0 && !noMatch;
  el.empty.textContent = noMatch
    ? '没找到匹配的歌。'
    : '这个列表还没有歌。用上面的按钮把歌加进来。';
  const cover = (state.covers || {})[state.activePlaylistId];
  if (cover) {
    el.mainCoverImg.src = cover;
    el.mainCoverImg.hidden = false;
    el.mainCoverFallback.hidden = true;
  } else {
    el.mainCoverImg.removeAttribute('src');
    el.mainCoverImg.hidden = true;
    el.mainCoverFallback.hidden = false;
  }
}

/** 搜得到这首歌吗（歌名或歌手）。 */
function matchTrack(track, query) {
  return (
    String(track.title || '').toLowerCase().includes(query) ||
    String(track.artist || '').toLowerCase().includes(query)
  );
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

el.prev.addEventListener('click', () => act('prev'));
el.play.addEventListener('click', () => act('toggle'));
el.next.addEventListener('click', () => act('next'));
el.playAll.addEventListener('click', () => act('select', { index: 0 }));

// —— 抽屉里的设置 ——
el.vol.addEventListener('change', () => act('volume', { value: Number(el.vol.value) / 100 }));

el.mode.addEventListener('change', () => {
  act('mode', { value: el.mode.value });
});

el.lyrics.addEventListener('change', () => {
  act('lyrics', { enabled: el.lyrics.checked });
});

el.filter.addEventListener('input', () => {
  filter = el.filter.value;
  renderList();
});

// 点进度条跳到那儿。
el.track.addEventListener('click', (event) => {
  if (!state.duration) return;
  const rect = el.track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  act('seek', { seconds: ratio * state.duration });
});

// ---------------------------------------------------------------------------
// 歌单
// ---------------------------------------------------------------------------

el.playlists.addEventListener('click', (event) => {
  const remove = event.target.closest('button.rm');
  if (remove) {
    event.stopPropagation();
    const id = remove.dataset.id;
    // 删歌单是拆东西：先问一句，再点一下才算。
    if (confirmingId !== id) {
      confirmingId = id;
      remove.title = '再点一下就删掉';
      remove.style.color = 'var(--dp-danger)';
      setTimeout(() => {
        confirmingId = '';
        remove.title = '删掉这个歌单';
        remove.style.color = '';
      }, 3000);
      return;
    }
    confirmingId = '';
    act('playlist-delete', { id });
    return;
  }
  const cover = event.target.closest('.cover');
  const item = event.target.closest('li');
  if (!item) return;
  const id = item.dataset.id;
  if (cover) {
    openMenu(id, cover);
    return;
  }
  act('playlist-select', { id });
  // 窄版里点开歌单才看歌：宽版两栏都在，切了也没影响。
  setView('songs');
});

el.back.addEventListener('click', () => setView('playlists'));

el.plNew.addEventListener('click', () => {
  el.plNewRow.hidden = false;
  el.plName.value = '';
  el.plName.focus();
});

el.plNameCancel.addEventListener('click', () => {
  el.plNewRow.hidden = true;
});

el.plNameOk.addEventListener('click', () => {
  const name = el.plName.value.trim();
  if (!name) return;
  el.plNewRow.hidden = true;
  act('playlist-create', { name });
});

el.plName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el.plNameOk.click();
  if (event.key === 'Escape') el.plNewRow.hidden = true;
});

el.plFolder.addEventListener('click', () => {
  act('playlist-add-folder', { id: state.activePlaylistId });
});

el.plSong.addEventListener('click', () => {
  act('playlist-add-files', { id: state.activePlaylistId });
});

el.list.addEventListener('click', (event) => {
  const remove = event.target.closest('button.rm');
  if (remove) {
    event.stopPropagation();
    act('playlist-remove-song', { id: state.activePlaylistId, file: remove.dataset.file });
    return;
  }
  const item = event.target.closest('li');
  if (!item) return;
  act('select', { index: Number(item.dataset.index) });
});

// ---------------------------------------------------------------------------
// 封面
// ---------------------------------------------------------------------------

/** 打开封面菜单。 */
function openMenu(playlistId, anchor) {
  menuPlaylistId = playlistId;
  const rect = anchor.getBoundingClientRect();
  el.menu.hidden = false;
  const height = el.menu.offsetHeight;
  const top = Math.min(rect.bottom + 6, window.innerHeight - height - 6);
  el.menu.style.left = `${Math.min(rect.left, window.innerWidth - 150)}px`;
  el.menu.style.top = `${Math.max(6, top)}px`;
}

function closeMenu() {
  el.menu.hidden = true;
  menuPlaylistId = '';
}

el.mainCover.addEventListener('click', () => openMenu(state.activePlaylistId, el.mainCover));

el.menuCover.addEventListener('click', () => {
  const id = menuPlaylistId;
  closeMenu();
  act('playlist-cover-pick', { id });
});

el.menuCoverReset.addEventListener('click', () => {
  const id = menuPlaylistId;
  closeMenu();
  act('playlist-cover', { id, cover: '' });
});

document.addEventListener('click', (event) => {
  if (el.menu.hidden) return;
  if (event.target.closest('#menu')) return;
  // 点开菜单的那一下不算「点外面」。
  if (event.target.closest('#main-cover')) return;
  if (event.target.closest('#playlists .cover')) return;
  closeMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // 抽屉开着的时候，Esc 归抽屉管（它先处理，标记了 defaultPrevented）。
  if (event.defaultPrevented) return;
  if (!el.menu.hidden) closeMenu();
  if (songPageOpen) closeSongPage();
});

// ---------------------------------------------------------------------------
// 播放页面（正在放的那一首）
// ---------------------------------------------------------------------------

/** 打开播放页面。 */
function openSongPage() {
  songPageOpen = true;
  el.songPage.hidden = false;
  renderSong();
}

function closeSongPage() {
  songPageOpen = false;
  el.songPage.hidden = true;
}

/** 播放页面：封面、歌名与歌词。 */
function renderSong() {
  if (!songPageOpen) return;
  const cur = state.current;
  el.songName.textContent = cur ? cur.title : '还没在放';
  el.songArtist.textContent = cur?.artist || '';
  const cover = currentCoverUrl();
  if (cover) {
    el.songCoverImg.src = cover;
    el.songCoverImg.hidden = false;
    el.songCoverFallback.hidden = true;
  } else {
    el.songCoverImg.removeAttribute('src');
    el.songCoverImg.hidden = true;
    el.songCoverFallback.hidden = false;
  }
  renderLyrics();
}

/** 歌词：当前那行高亮，并滚到中间。 */
function renderLyrics() {
  const lines = currentLyrics();
  const sig = `${state.current?.file || ''}|${lines.length}`;
  if (el.songLyrics.dataset.sig !== sig) {
    el.songLyrics.dataset.sig = sig;
    el.songLyrics.textContent = '';
    if (lines.length) {
      for (const line of lines) {
        const item = document.createElement('div');
        item.className = 'line';
        item.textContent = line.text;
        el.songLyrics.append(item);
      }
    } else {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = state.current ? '这首歌没有歌词' : '还没在放';
      el.songLyrics.append(none);
    }
    lastLyricIndex = -1;
  }
  const items = el.songLyrics.children;
  const index = Number(state.lyricIndex ?? -1);
  for (let i = 0; i < items.length; i += 1) {
    items[i].classList.toggle('on', i === index);
  }
  if (index === lastLyricIndex) return;
  lastLyricIndex = index;
  const item = items[index];
  if (!item) return;
  el.songLyrics.scrollTop =
    item.offsetTop - el.songLyrics.clientHeight / 2 + item.offsetHeight / 2;
}

el.now.addEventListener('click', () => openSongPage());
el.songClose.addEventListener('click', () => closeSongPage());
el.songPage.addEventListener('click', (event) => {
  // 点浮层本身（就是它周围那一圈）就关掉。
  if (event.target === el.songPage) closeSongPage();
});

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

surface.onData((data) => applyState(data));
surface.onTick((data) => applyState(data));
void surface.data().then((data) => applyState(data));

// ---------------------------------------------------------------------------
// 报高度
// ---------------------------------------------------------------------------

/** 面板里插件页面的固定高度（像素）。 */
const PANEL_HEIGHT = 460;

/** 上次报给宿主的高度。 */
let reportedHeight = 0;

function reportHeight() {
  // 面板里高度是定值：歌单多、歌曲多都不改它（面板窗口也就不一高一低）。
  if (surface.inPanel) {
    setHeightOnce(PANEL_HEIGHT);
    return;
  }
  requestAnimationFrame(() => {
    // 量**内容**的高度，不是视口的（见插件开发指南）。
    const rect = document.body.getBoundingClientRect();
    setHeightOnce(Math.ceil(Math.max(rect.height, document.body.scrollHeight)));
  });
}

/** 报高度；一样的高度不重复报（面板照着报的高度摆 iframe，来回报会抖）。 */
function setHeightOnce(height) {
  if (height === reportedHeight) return;
  reportedHeight = height;
  surface.setHeight(height);
}

if (!surface.inPanel && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => reportHeight()).observe(document.body);
}
window.addEventListener('resize', reportHeight);
reportHeight();
