// plugins/music-player/lib/player.js
import { app, dialog, ipcMain, nativeImage } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEngine } from './engine.js';
import { extractArtwork } from './cover.js';
import { formatTime } from './format.js';
import { createLyricsWindow } from './lyrics-window.js';
import { lyricPathsFor, scanLibrary, searchTracks, makeTrack, AUDIO_EXTENSIONS } from './library.js';
import { decodeLyrics, lineIndexAt, parseLrc } from './lrc.js';
import {
  DEFAULT_PLAYLIST_ID,
  addPlaylist,
  addTracksToPlaylist,
  ensureDefaultPlaylist,
  readPlaylists,
  removePlaylist,
  removeTrackFromPlaylist,
  setPlaylistCover,
  writePlaylists,
} from './playlists.js';

/** 与 preload/mp.cjs 约定的通道。 */
const CHANNEL = 'mp:music-player:message';

/** 播放模式：配置里存的是中文，这里用好认的内部说法。 */
const PLAY_MODES = Object.freeze({
  order: '顺序播放',
  repeat: '单曲循环',
  shuffle: '随机播放',
});

const MODE_BY_LABEL = {
  [PLAY_MODES.order]: 'order',
  [PLAY_MODES.repeat]: 'repeat',
  [PLAY_MODES.shuffle]: 'shuffle',
};

/** 猜一张图片是什么类型（按后缀）。 */
function guessMime(path) {
  const ext = String(path || '').toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/jpeg';
}

/**
 * 端到端测试用：直接给出文件夹，不弹系统对话框。
 *
 * 系统对话框没法自动点，端到端测试就过不去这一步。
 */
function presetFolder() {
  if (!process.env.DESK_PET_E2E) return '';
  return String(process.env.DESK_PET_E2E_MUSIC_FOLDER || '');
}

/** 端到端测试用：直接给出封面图，不弹系统对话框。 */
function presetCover() {
  if (!process.env.DESK_PET_E2E) return '';
  return String(process.env.DESK_PET_E2E_MUSIC_COVER || '');
}

/**
 * 端到端测试用：直接给出要加进歌单的文件，不弹系统对话框。
 *
 * 多个文件用分号隔开（Windows 上的路径分隔符）。
 */
function presetFiles() {
  if (!process.env.DESK_PET_E2E) return [];
  return String(process.env.DESK_PET_E2E_MUSIC_FILES || '')
    .split(';')
    .map((file) => file.trim())
    .filter(Boolean);
}

/**
 * 播放器：一首一首放着，同时管着歌单、歌词窗与界面。
 *
 * 插件的界面（面板、独立窗口、小部件）只是它的一面镜子——
 * 状态在这里改，推给界面。
 */
export function createPlayer({ ctx, pluginDir }) {
  const preloadPath = join(pluginDir, 'preload', 'mp.cjs');
  const userDataDir = app.getPath('userData');

  const state = {
    /** 歌单（第一个永远是默认列表）。 */
    playlists: [],
    /** 现在放的是哪个歌单。 */
    activePlaylistId: DEFAULT_PLAYLIST_ID,
    /** 列表变了就加一：界面靠它知道列表要不要重画。 */
    listVersion: 0,
    /** 封面变了就加一。 */
    coversVersion: 0,
    /** 歌词变了就加一。 */
    lyricsVersion: 0,
    /** 歌单 id → 封面（数据 URL）。 */
    covers: {},
    /** 现在这首歌的封面：{ file, url }（file 是它属于哪首歌）。 */
    currentCover: null,
    index: -1,
    /** 引擎里正放着的那首歌（与列表下标分开：切歌单时歌还在放）。 */
    current: null,
    playing: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    mode: 'order',
    lyricsOpen: false,
    status: '',
  };

  /** 当前这首歌的歌词（按时间排好）。 */
  let lyricLines = [];
  /** 这份歌词属于哪首歌（换歌时别把上一首的词显示出来）。 */
  let lyricFile = '';
  /** 此刻该显示第几行。 */
  let lyricIndex = -1;
  /** 推给界面的那份是全量还是简版（列表变了才推全量）。 */
  let pushedVersion = -1;
  let pushedCovers = -1;
  /** 上次推出去的歌词是哪一版。 */
  let pushedLyrics = -1;
  /** 封面缓存：歌单 id → { key, dataUrl }。 */
  const coverCache = new Map();
  /** 歌曲内嵌封面的缓存：文件路径 → dataUrl（空串 = 没有）。 */
  const artCache = new Map();

  /**
   * 起来了没有。
   *
   * **配置要等插件登记上才读得到**：宿主是先调工厂函数、再把插件记进册子的，
   * 工厂函数里读 `ctx.config` 拿到的是空的。所以配置、歌单、歌词窗
   * 一律等到第一次真有人用这个插件时才做。
   */
  let started = false;

  let engine = null;
  let lyricsWindow = null;

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------

  function readConfig() {
    return ctx.config || {};
  }

  function volumeOfConfig() {
    const v = Number(readConfig().volume);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : 0.8;
  }

  function modeOfConfig() {
    return MODE_BY_LABEL[String(readConfig().playMode || '')] || 'order';
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /** 把配置里的东西同步进状态。配置是活的：用户改了要立刻生效。 */
  function syncConfig() {
    state.volume = volumeOfConfig();
    state.mode = modeOfConfig();
  }

  /** 第一次真有人用这个插件：读配置、读歌单、歌词窗该开着就开着。 */
  async function ensureStarted() {
    if (started) return;
    started = true;
    syncConfig();
    state.lyricsOpen = Boolean(readConfig().lyricsOn);
    if (state.lyricsOpen) ensureLyricsWindow().open();
    state.playlists = ensureDefaultPlaylist(await readPlaylists(userDataDir));
    state.activePlaylistId = DEFAULT_PLAYLIST_ID;
    void refreshCovers();
  }

  /** 现在放的是哪个歌单。 */
  function activePlaylist() {
    return state.playlists.find((p) => p.id === state.activePlaylistId) || null;
  }

  /** 现在在放的是哪一份列表。 */
  function sourceTracks() {
    return activePlaylist()?.tracks || [];
  }

  /** 现在这份列表叫什么。 */
  function sourceLabel() {
    return activePlaylist()?.name || '默认列表';
  }

  /** 所有歌单里的歌（同一首只算一次）。 */
  function allTracks() {
    const seen = new Set();
    const out = [];
    for (const playlist of state.playlists) {
      for (const track of playlist.tracks) {
        if (seen.has(track.file)) continue;
        seen.add(track.file);
        out.push(track);
      }
    }
    return out;
  }

  /** 列表变了：界面要重画。 */
  function touchList() {
    state.listVersion += 1;
  }

  /**
   * 一份状态快照。
   *
   * @param {boolean} withTracks 带上整份列表（界面要画列表）
   * @param {boolean} withLyrics 带上歌词（歌词只在换歌时重发）
   */
  function snapshot(withTracks = false, withLyrics = false) {
    syncConfig();
    const tracks = sourceTracks();
    const track = state.current;
    const out = {
      sourceLabel: sourceLabel(),
      trackCount: tracks.length,
      totalCount: allTracks().length,
      listVersion: state.listVersion,
      index: state.index,
      activePlaylistId: state.activePlaylistId,
      defaultPlaylistId: DEFAULT_PLAYLIST_ID,
      playlists: state.playlists.map((p) => ({
        id: p.id,
        name: p.name,
        count: p.tracks.length,
        cover: p.cover || '',
      })),
      current: track
        ? { id: track.id, title: track.title, artist: track.artist, file: track.file }
        : null,
      playing: state.playing,
      position: state.position,
      duration: state.duration,
      volume: state.volume,
      mode: state.mode,
      modeLabel: PLAY_MODES[state.mode],
      lyricsOpen: state.lyricsOpen,
      /** 此刻该唱到第几行歌词。 */
      lyricIndex,
      status: state.status,
    };
    if (withTracks) {
      out.tracks = tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        file: t.file,
      }));
      out.covers = { ...state.covers };
      out.currentCover = state.currentCover;
    }
    if (withLyrics) {
      out.lyrics = {
        file: lyricFile,
        lines: lyricLines.map((l) => ({ t: l.t, text: l.text })),
      };
    }
    return out;
  }

  /**
   * 状态变了：推给所有挂着这个插件的界面。
   *
   * 列表变了才推全量（带整份歌单），歌词变了才带歌词——
   * 播放头每 250ms 动一次，整份列表跟着动太浪费。
   */
  function notify() {
    try {
      const full =
        state.listVersion !== pushedVersion || state.coversVersion !== pushedCovers;
      const withLyrics = state.lyricsVersion !== pushedLyrics;
      if (full) {
        pushedVersion = state.listVersion;
        pushedCovers = state.coversVersion;
      }
      if (withLyrics) pushedLyrics = state.lyricsVersion;
      ctx.push?.(snapshot(full, withLyrics));
    } catch (err) {
      console.warn('[音乐] 状态推不出去：', err?.message);
    }
  }

  // -------------------------------------------------------------------------
  // 封面
  // -------------------------------------------------------------------------

  /** 这个歌单的封面该从哪儿来：自定义的图，还是第一首歌里内嵌的。 */
  function coverKeyOf(playlist) {
    if (playlist.cover) return `file:${playlist.cover}`;
    const first = playlist.tracks[0];
    return first ? `song:${first.file}` : '';
  }

  /** 缩成小图：整张原图塞进页面太慢。 */
  function toDataUrl(buffer, mime) {
    try {
      const image = nativeImage.createFromBuffer(buffer);
      if (!image.isEmpty()) {
        return image.resize({ width: 192, height: 192, quality: 'good' }).toDataURL();
      }
    } catch {
      /* 不是图片：原样给出去 */
    }
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  /** 取一张封面（缓存着，别反复读盘）。 */
  async function loadCover(key) {
    if (key.startsWith('file:')) {
      const path = key.slice(5);
      try {
        return toDataUrl(await readFile(path), guessMime(path));
      } catch {
        return '';
      }
    }
    const path = key.slice(5);
    if (artCache.has(path)) return artCache.get(path);
    const art = await extractArtwork(path);
    const url = art ? toDataUrl(art.data, art.mime) : '';
    artCache.set(path, url);
    return url;
  }

  /** 封面变了就重算（算完再推一次状态）。 */
  async function refreshCovers() {
    const next = {};
    for (const playlist of state.playlists) {
      const key = coverKeyOf(playlist);
      if (!key) continue;
      const cached = coverCache.get(playlist.id);
      if (cached && cached.key === key) {
        if (cached.dataUrl) next[playlist.id] = cached.dataUrl;
        continue;
      }
      const dataUrl = await loadCover(key);
      coverCache.set(playlist.id, { key, dataUrl });
      if (dataUrl) next[playlist.id] = dataUrl;
    }
    for (const id of [...coverCache.keys()]) {
      if (!state.playlists.some((p) => p.id === id)) coverCache.delete(id);
    }
    if (JSON.stringify(state.covers) === JSON.stringify(next)) return;
    state.covers = next;
    state.coversVersion += 1;
    notify();
  }

  // -------------------------------------------------------------------------
  // 引擎与歌词窗
  // -------------------------------------------------------------------------

  function ensureEngine() {
    if (!engine) {
      engine = createEngine({ pluginDir, preloadPath, onEvent: handleEngineEvent });
      engine.volume(state.volume);
    }
    return engine;
  }

  function ensureLyricsWindow() {
    if (!lyricsWindow) {
      lyricsWindow = createLyricsWindow({
        pluginDir,
        preloadPath,
        onCommand: (message) => {
          if (message?.type === 'ready') pushLyrics();
        },
        onClose: () => {
          // 用户自己把歌词窗收了：那个开关也要跟着关掉。
          if (!state.lyricsOpen) return;
          state.lyricsOpen = false;
          void ctx.host.setConfig({ lyricsOn: false });
          notify();
        },
      });
    }
    return lyricsWindow;
  }

  /** 引擎报上来的动静。 */
  function handleEngineEvent(message) {
    if (!message) return;
    if (message.type === 'time') {
      state.position = Number(message.current) || 0;
      const dur = Number(message.duration) || 0;
      if (dur > 0) state.duration = dur;
      syncLyric();
      notify();
    } else if (message.type === 'state') {
      state.playing = Boolean(message.playing);
      notify();
    } else if (message.type === 'ended') {
      void handleEnded();
    } else if (message.type === 'error') {
      state.playing = false;
      state.status = String(message.message || '这个文件放不了');
      notify();
    }
  }

  // -------------------------------------------------------------------------
  // 歌词
  // -------------------------------------------------------------------------

  async function loadLyrics(track) {
    lyricLines = [];
    lyricIndex = -1;
    lyricFile = track?.file || '';
    for (const file of lyricPathsFor(track)) {
      try {
        const buffer = await readFile(file);
        lyricLines = parseLrc(decodeLyrics(buffer));
        break;
      } catch {
        // 没有这个文件就试下一个（同名与只带歌名两种摆法）。
      }
    }
    state.lyricsVersion += 1;
    pushLyrics();
  }

  /**
   * 现在这首歌的封面：文件里内嵌的那张图。
   *
   * 歌单的封面是另一回事（用户自己挑的，或者第一首歌的图）——
   * 播放页面要的是**这一首**自己的封面。
   */
  async function refreshCurrentCover(track) {
    const url = track ? await loadCover(`song:${track.file}`) : '';
    // 换歌了：这张封面已经不该算数。
    if (state.current !== track) return;
    state.currentCover = url ? { file: track.file, url } : null;
    state.coversVersion += 1;
    notify();
  }

  /** 播放位置变了：看看该显示哪一行歌词。 */
  function syncLyric() {
    if (!lyricLines.length) return;
    const at = lineIndexAt(lyricLines, state.position);
    if (at === lyricIndex) return;
    lyricIndex = at;
    pushLyrics();
  }

  /** 把歌词推给歌词窗。 */
  function pushLyrics() {
    if (!state.lyricsOpen) return;
    const track = state.current;
    lyricsWindow?.send({
      lines: lyricLines.map((l) => ({ t: l.t, text: l.text })),
      index: lyricIndex,
      title: track?.title || '',
      artist: track?.artist || '',
      playing: state.playing,
    });
  }

  // -------------------------------------------------------------------------
  // 放歌
  // -------------------------------------------------------------------------

  /** 放第几首。不给下标就是「继续放现在这首」。 */
  async function play(index) {
    const tracks = sourceTracks();
    if (index === undefined || index === null) {
      if (state.current) return resume();
      return play(0);
    }
    if (!tracks.length) {
      state.status = '这个列表还没有歌';
      notify();
      return { ok: false, message: state.status };
    }
    let at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at >= tracks.length) at = 0;
    const track = tracks[at];
    state.index = at;
    state.current = track;
    state.position = 0;
    state.duration = 0;
    state.playing = true;
    state.status = `在放《${track.title}》`;
    void refreshCurrentCover(track);
    await loadLyrics(track);
    const eng = ensureEngine();
    eng.load(track.file);
    eng.play();
    notify();
    return { ok: true, message: state.status };
  }

  /** 接着放。 */
  function resume() {
    state.playing = true;
    ensureEngine().play();
    state.status = '继续播放';
    notify();
    return { ok: true, message: state.status };
  }

  function pause() {
    if (!state.playing) {
      state.status = '本来就没在放';
      notify();
      return { ok: false, message: state.status };
    }
    state.playing = false;
    engine?.pause();
    state.status = '暂停了';
    notify();
    return { ok: true, message: state.status };
  }

  function toggle() {
    return state.playing ? pause() : play(undefined);
  }

  /** 下一首是第几首。`auto` 是「这首放完了自己往下走」。 */
  function nextIndex(auto) {
    const total = sourceTracks().length;
    if (!total) return -1;
    if (state.mode === 'shuffle') {
      if (total === 1) return 0;
      let at = state.index;
      while (at === state.index) at = Math.floor(Math.random() * total);
      return at;
    }
    const at = state.index + 1;
    if (at < total) return at;
    // 顺序播放：到底了就停；单曲循环：再来一遍。
    return auto && state.mode === 'repeat' ? state.index : -1;
  }

  async function next() {
    const at = nextIndex(false);
    if (at < 0) {
      state.playing = false;
      state.status = '放完了';
      notify();
      return { ok: false, message: state.status };
    }
    return play(at);
  }

  async function prev() {
    if (!sourceTracks().length) {
      state.status = '这个列表还没有歌';
      notify();
      return { ok: false, message: state.status };
    }
    return play(Math.max(0, state.index - 1));
  }

  /** 这首放完了：按播放模式决定下一首。 */
  async function handleEnded() {
    const at = nextIndex(true);
    if (at < 0) {
      state.playing = false;
      state.position = state.duration;
      state.status = '放完了';
      notify();
      return;
    }
    await play(at);
  }

  function seek(seconds) {
    const t = Number(seconds);
    if (!Number.isFinite(t) || t < 0) {
      return { ok: false, message: '跳不过去' };
    }
    const at = state.duration > 0 ? Math.min(t, state.duration) : t;
    state.position = at;
    engine?.seek(at);
    syncLyric();
    notify();
    return { ok: true, message: `跳到 ${formatTime(at)}` };
  }

  // -------------------------------------------------------------------------
  // 歌单
  // -------------------------------------------------------------------------

  /** 歌单存盘。写坏了也不该把音乐弄停——记一条日志就算了。 */
  async function savePlaylists() {
    try {
      state.playlists = await writePlaylists(userDataDir, state.playlists);
    } catch (err) {
      console.warn('[音乐] 歌单存不下：', err?.message);
      state.status = `歌单存不下：${err?.message || err}`;
    }
  }

  /** 切到某个歌单。 */
  function selectPlaylist(id) {
    const want = String(id || '');
    const playlist = state.playlists.find((p) => p.id === want);
    if (!playlist) {
      return { ok: false, message: '这个歌单已经不在了' };
    }
    state.activePlaylistId = want;
    // 列表换了：正在放的歌不一定在里面，下标要重新对。
    const currentFile = state.current?.file || '';
    state.index = currentFile ? sourceTracks().findIndex((t) => t.file === currentFile) : -1;
    touchList();
    state.status = `在放「${playlist.name}」`;
    notify();
    return { ok: true, message: state.status };
  }

  /** 新建一个歌单。 */
  async function createPlaylist(name) {
    const clean = String(name || '').trim();
    if (!clean) return { ok: false, message: '歌单得有个名字' };
    state.playlists = addPlaylist(state.playlists, clean);
    const playlist = state.playlists[state.playlists.length - 1];
    state.activePlaylistId = playlist.id;
    state.index = -1;
    touchList();
    await savePlaylists();
    void refreshCovers();
    state.status = `建好了「${clean}」`;
    notify();
    return { ok: true, message: state.status };
  }

  /** 删掉一个歌单。 */
  async function deletePlaylist(id) {
    const target = String(id || '');
    if (target === DEFAULT_PLAYLIST_ID) {
      return { ok: false, message: '默认列表删不掉' };
    }
    const playlist = state.playlists.find((p) => p.id === target);
    if (!playlist) return { ok: false, message: '这个歌单已经不在了' };
    state.playlists = removePlaylist(state.playlists, target);
    if (state.activePlaylistId === target) {
      state.activePlaylistId = DEFAULT_PLAYLIST_ID;
      state.index = -1;
    }
    touchList();
    await savePlaylists();
    void refreshCovers();
    state.status = `删掉了「${playlist.name}」`;
    notify();
    return { ok: true, message: state.status };
  }

  /** 从本地挑几首歌加进歌单（按文件路径认，重复的不加）。 */
  async function addFilesToPlaylist(id) {
    const target = String(id || '');
    if (!state.playlists.some((p) => p.id === target)) {
      return { ok: false, message: '先选一个列表' };
    }
    let files = presetFiles();
    if (!files.length) {
      const result = await dialog.showOpenDialog({
        title: '选几首要加的歌',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '音频', extensions: AUDIO_EXTENSIONS }],
      });
      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, message: '没选歌' };
      }
      files = result.filePaths;
    }
    const tracks = files.map((file) => makeTrack(file));
    const { playlists, added } = addTracksToPlaylist(state.playlists, target, tracks);
    state.playlists = playlists;
    touchList();
    await savePlaylists();
    void refreshCovers();
    state.status = added ? `加了 ${added} 首` : '这些歌都在列表里了';
    notify();
    return { ok: true, message: state.status };
  }

  /** 把一个文件夹里的歌加进歌单。 */
  async function addFolderToPlaylist(id) {
    const target = String(id || '');
    if (!state.playlists.some((p) => p.id === target)) {
      return { ok: false, message: '先选一个列表' };
    }
    let folder = presetFolder();
    if (!folder) {
      const result = await dialog.showOpenDialog({
        title: '选一个音乐文件夹',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, message: '没选文件夹' };
      }
      folder = result.filePaths[0];
    }
    const { tracks } = await scanLibrary(folder);
    if (!tracks.length) {
      state.status = '这个文件夹里没找到音频文件';
      notify();
      return { ok: false, message: state.status };
    }
    const { playlists, added } = addTracksToPlaylist(state.playlists, target, tracks);
    state.playlists = playlists;
    touchList();
    await savePlaylists();
    void refreshCovers();
    state.status = added ? `加了 ${added} 首` : '这些歌都在列表里了';
    notify();
    return { ok: true, message: state.status };
  }

  /** 从歌单里去掉一首歌。 */
  async function removeSongFromPlaylist(id, file) {
    const target = String(id || '');
    if (!state.playlists.some((p) => p.id === target)) {
      return { ok: false, message: '这个歌单已经不在了' };
    }
    state.playlists = removeTrackFromPlaylist(state.playlists, target, file);
    const currentFile = state.current?.file || '';
    state.index = currentFile ? sourceTracks().findIndex((t) => t.file === currentFile) : -1;
    touchList();
    await savePlaylists();
    void refreshCovers();
    state.status = '从列表里拿掉了';
    notify();
    return { ok: true, message: state.status };
  }

  /** 换个封面。空字符串 = 用第一首歌里内嵌的那张。 */
  async function setPlaylistCoverImage(id, cover) {
    const target = String(id || '');
    if (!state.playlists.some((p) => p.id === target)) {
      return { ok: false, message: '这个歌单已经不在了' };
    }
    state.playlists = setPlaylistCover(state.playlists, target, cover);
    await savePlaylists();
    void refreshCovers();
    state.status = cover ? '封面换好了' : '封面恢复默认了';
    notify();
    return { ok: true, message: state.status };
  }

  /** 让用户挑一张封面图。 */
  async function choosePlaylistCover(id) {
    const target = String(id || '');
    if (!state.playlists.some((p) => p.id === target)) {
      return { ok: false, message: '这个歌单已经不在了' };
    }
    let file = presetCover();
    if (!file) {
      const result = await dialog.showOpenDialog({
        title: '选一张封面',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }],
      });
      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, message: '没选图片' };
      }
      file = result.filePaths[0];
    }
    return setPlaylistCoverImage(target, file);
  }

  // -------------------------------------------------------------------------
  // 音量、模式、歌词窗
  // -------------------------------------------------------------------------

  async function setVolume(value) {
    const n = Number(value);
    const v = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : state.volume;
    state.volume = v;
    engine?.volume(v);
    await ctx.host.setConfig({ volume: Math.round(v * 100) });
    notify();
    return { ok: true, message: `音量 ${Math.round(v * 100)}` };
  }

  async function setMode(value) {
    const mode = MODE_BY_LABEL[String(value || '')] || 'order';
    state.mode = mode;
    await ctx.host.setConfig({ playMode: PLAY_MODES[mode] });
    notify();
    return { ok: true, message: PLAY_MODES[mode] };
  }

  async function setLyrics(enabled) {
    const want = Boolean(enabled);
    state.lyricsOpen = want;
    await ctx.host.setConfig({ lyricsOn: want });
    if (want) {
      ensureLyricsWindow().open();
      pushLyrics();
    } else {
      lyricsWindow?.close();
    }
    notify();
    return { ok: true, message: want ? '桌面歌词开了' : '桌面歌词关了' };
  }

  // -------------------------------------------------------------------------
  // 找歌（给 agent 用）
  // -------------------------------------------------------------------------

  /** 有没有一首歌对得上这句话（歌名或歌手名）。 */
  function matches(track, query) {
    const q = query.toLowerCase();
    return track.title.toLowerCase().includes(q) || track.artist.toLowerCase().includes(q);
  }

  /**
   * 在所有列表里找歌。
   *
   * `song` 按**歌名**过滤，`artist` 按**歌手**过滤；两个都给就都要对上。
   *
   * @param {{song?: string, artist?: string}} filter
   * @returns {Array<{title: string, artist: string, file: string}>}
   */
  function search(filter) {
    const list = searchTracks(allTracks(), filter);
    return list.slice(0, 20).map((t) => ({ title: t.title, artist: t.artist, file: t.file }));
  }

  /** 放一首歌：给了名字就在列表里找，找不到就放第一首。 */
  async function playMatch(query) {
    const q = String(query || '').trim();
    if (!q) return play(undefined);
    const track = allTracks().find((t) => matches(t, q));
    if (!track) {
      state.status = `没有找到「${q}」`;
      notify();
      return { ok: false, message: state.status };
    }
    // 这首歌不在当前这份列表里：先切到它所在的列表，不然放不了它。
    const owner = state.playlists.find((p) => p.tracks.some((t) => t.file === track.file));
    if (owner && owner.id !== state.activePlaylistId) {
      state.activePlaylistId = owner.id;
      touchList();
    }
    const at = sourceTracks().findIndex((t) => t.file === track.file);
    return play(at);
  }

  // -------------------------------------------------------------------------
  // 起来
  // -------------------------------------------------------------------------

  ipcMain.on(CHANNEL, (_event, message) => {
    if (message?.role === 'engine') engine?.handleMessage(message);
    else if (message?.role === 'lyrics') lyricsWindow?.handleMessage(message);
  });

  /**
   * 插件被关掉时把音乐停掉。
   *
   * 宿主没有「插件被关了」的回调（录屏也有同样的毛病），所以自己看着点：
   * 不然它会在看不见的地方一直放，用户还没法停。
   */
  const guard = setInterval(() => {
    if (ctx.host.isEnabled('music-player')) return;
    clearInterval(guard);
    engine?.pause();
    engine?.destroy();
    lyricsWindow?.close();
  }, 3000);

  // 退出前把自建的窗口都拆掉：Electron 自己关窗口会卡住。
  app.on('before-quit', () => {
    clearInterval(guard);
    engine?.destroy();
    lyricsWindow?.close();
  });

  return {
    snapshot,
    ensureStarted,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    setMode,
    setLyrics,
    search,
    playMatch,
    selectPlaylist,
    createPlaylist,
    deletePlaylist,
    addFilesToPlaylist,
    addFolderToPlaylist,
    removeSongFromPlaylist,
    setPlaylistCoverImage,
    choosePlaylistCover,
  };
}
