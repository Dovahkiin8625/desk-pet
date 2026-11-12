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
  plSelect: $('pl-select'),
  plNew: $('pl-new'),
  plDel: $('pl-del'),
  plFolder: $('pl-folder'),
  plSong: $('pl-song'),
  plNewRow: $('pl-new-row'),
  plName: $('pl-name'),
  plNameOk: $('pl-name-ok'),
  plNameCancel: $('pl-name-cancel'),
  picker: $('picker'),
  pickerList: $('picker-list'),
  pickerFilter: $('picker-filter'),
  pickerTitle: $('picker-title'),
  pickerClose: $('picker-close'),
};

/** 主进程给的状态。 */
let state = {
  tracks: [],
  library: [],
  playlists: [],
  index: -1,
  playing: false,
  position: 0,
  duration: 0,
  volume: 0.8,
};
/** 曲库上次画的是哪一版（变了才重画列表）。 */
let listVersion = -1;
/** 挑歌那块浮层画的是哪一版。 */
let pickerSig = '';
/** 删除按钮是不是正等着用户再点一下。 */
let confirming = false;

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
  const label = state.sourceLabel || '曲库';
  // 歌单是空的也是歌单：得写出是哪一个，不然只看到一个「0 首」。
  const counted = state.trackCount > 0 || state.activePlaylistId;
  el.npTitle.textContent = cur ? cur.title : '还没在放';
  el.npSub.textContent = cur
    ? `${cur.artist ? cur.artist + ' · ' : ''}${state.playing ? '在放' : '暂停'}`
    : counted
      ? `${label} ${state.trackCount} 首`
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
  el.libCount.textContent = state.scanning ? '正在扫…' : counted ? `${label} ${state.trackCount} 首` : '曲库';
  el.empty.hidden = state.trackCount > 0;
  el.empty.textContent = state.activePlaylistId
    ? '这个歌单还没有歌。用「＋歌曲」或「＋文件夹」往里加。'
    : '还没有音乐库。点右上角的「音乐库」选一个文件夹。';
  renderPlaylistBar();
  renderList();
  renderPicker();
}

/** 画播放列表那一排：下拉框（曲库 + 各个歌单）与几个按钮。 */
function renderPlaylistBar() {
  const playlists = state.playlists || [];
  const sig = playlists.map((p) => `${p.id}:${p.count}`).join('|');
  if (el.plSelect.dataset.sig !== sig) {
    el.plSelect.dataset.sig = sig;
    el.plSelect.textContent = '';
    const library = document.createElement('option');
    library.value = '';
    library.textContent = '曲库';
    el.plSelect.append(library);
    for (const playlist of playlists) {
      const option = document.createElement('option');
      option.value = playlist.id;
      option.textContent = `${playlist.name}（${playlist.count}）`;
      el.plSelect.append(option);
    }
  }
  el.plSelect.value = state.activePlaylistId || '';
  // 往歌单里加东西，得先有个歌单。
  const on = Boolean(state.activePlaylistId);
  el.plDel.disabled = !on;
  el.plFolder.disabled = !on;
  el.plSong.disabled = !on;
}

/** 画列表：列表没变就不重画（重画会把滚动位置弄丢）。 */
function renderList() {
  if (listVersion !== state.listVersion) {
    listVersion = state.listVersion;
    el.list.textContent = '';
    const tracks = state.tracks || [];
    for (let i = 0; i < tracks.length; i += 1) {
      const track = tracks[i];
      const li = document.createElement('li');
      li.dataset.index = String(i);
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
      if (state.activePlaylistId) {
        const remove = document.createElement('button');
        remove.className = 'rm';
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = '从这个歌单里拿掉';
        remove.dataset.file = track.file;
        li.append(remove);
      }
      el.list.append(li);
    }
  }
  const items = el.list.children;
  for (let i = 0; i < items.length; i += 1) {
    items[i].classList.toggle('current', i === state.index);
  }
}

/** 画挑歌的那块浮层（关着时什么都不做）。 */
function renderPicker() {
  if (el.picker.hidden) {
    pickerSig = '';
    return;
  }
  const query = el.pickerFilter.value.trim().toLowerCase();
  const sig = `${state.libraryVersion}|${state.listVersion}|${query}`;
  if (sig === pickerSig) return;
  pickerSig = sig;
  const have = new Set((state.tracks || []).map((t) => t.file));
  el.pickerList.textContent = '';
  let shown = 0;
  for (const track of state.library || []) {
    const artist = track.artist || '';
    if (
      query &&
      !track.title.toLowerCase().includes(query) &&
      !artist.toLowerCase().includes(query)
    ) {
      continue;
    }
    shown += 1;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = track.title;
    li.append(label);
    if (artist) {
      const name = document.createElement('span');
      name.className = 'artist';
      name.textContent = artist;
      li.append(name);
    }
    if (have.has(track.file)) {
      li.classList.add('added');
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = '✓';
      li.append(mark);
    } else {
      li.addEventListener('click', () => {
        act('playlist-add-song', { id: state.activePlaylistId, file: track.file });
      });
    }
    el.pickerList.append(li);
  }
  if (!shown) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = query ? '没找到' : '曲库是空的';
    el.pickerList.append(li);
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

// 点进度条跳到那儿。
el.bar.addEventListener('click', (event) => {
  if (!state.duration) return;
  const rect = el.bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  act('seek', { seconds: ratio * state.duration });
});

// ---------------------------------------------------------------------------
// 播放列表
// ---------------------------------------------------------------------------

el.plSelect.addEventListener('change', () => {
  act('playlist-select', { id: el.plSelect.value });
});

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

el.plDel.addEventListener('click', () => {
  const id = state.activePlaylistId;
  if (!id) return;
  // 删歌单是拆东西：先问一句，再点一下才算。
  if (!confirming) {
    confirming = true;
    el.plDel.textContent = '真删？';
    el.plDel.classList.add('confirm');
    setTimeout(() => {
      confirming = false;
      el.plDel.textContent = '删除';
      el.plDel.classList.remove('confirm');
    }, 3000);
    return;
  }
  confirming = false;
  el.plDel.textContent = '删除';
  el.plDel.classList.remove('confirm');
  act('playlist-delete', { id });
});

el.plFolder.addEventListener('click', () => {
  act('playlist-add-folder', { id: state.activePlaylistId });
});

el.plSong.addEventListener('click', () => {
  el.picker.hidden = false;
  el.pickerFilter.value = '';
  el.pickerTitle.textContent = `往「${
    (state.playlists || []).find((p) => p.id === state.activePlaylistId)?.name || '歌单'
  }」里加歌`;
  renderPicker();
});

el.pickerClose.addEventListener('click', () => {
  el.picker.hidden = true;
});

el.pickerFilter.addEventListener('input', () => renderPicker());

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
