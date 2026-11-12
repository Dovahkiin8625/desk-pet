// plugins/music-player/lib/player.js
import { app, dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEngine } from './engine.js';
import { formatTime } from './format.js';
import { createLyricsWindow } from './lyrics-window.js';
import { lyricPathsFor, scanLibrary, searchTracks } from './library.js';
import { decodeLyrics, lineIndexAt, parseLrc } from './lrc.js';
import {
  addPlaylist,
  addTracksToPlaylist,
  readPlaylists,
  removePlaylist,
  removeTrackFromPlaylist,
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

/**
 * 播放器：一首一首放着，同时管着曲库、歌词窗与界面。
 *
 * 插件的界面（面板、独立窗口、小部件）只是它的一面镜子——
 * 状态在这里改，推给界面。
 */
export function createPlayer({ ctx, pluginDir }) {
  const preloadPath = join(pluginDir, 'preload', 'mp.cjs');
  const userDataDir = app.getPath('userData');

  const state = {
    folder: '',
    /** 曲库：扫出来的全部歌。 */
    library: [],
    /** 播放列表。 */
    playlists: [],
    /** 现在放的是哪个歌单（空 = 放曲库）。 */
    activePlaylistId: '',
    truncated: false,
    scanning: false,
    /** 曲库变了就加一：界面靠它知道列表要不要重画。 */
    libraryVersion: 0,
    /** 列表（曲库或歌单）变了就加一。 */
    listVersion: 0,
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
  /** 此刻该显示第几行。 */
  let lyricIndex = -1;
  /** 推给界面的那份是全量还是简版（列表变了才推全量）。 */
  let pushedVersion = -1;

  /**
   * 起来了没有。
   *
   * **配置要等插件登记上才读得到**：宿主是先调工厂函数、再把插件记进册子的，
   * 工厂函数里读 `ctx.config` 拿到的是空的。所以配置、曲库、歌词窗
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

  function folderOfConfig() {
    return String(readConfig().musicFolder || '').trim();
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /** 把配置里的东西同步进状态。配置是活的：用户改了要立刻生效。 */
  function syncConfig() {
    state.volume = volumeOfConfig();
    state.mode = modeOfConfig();
    state.folder = folderOfConfig();
  }

  /** 第一次真有人用这个插件：读配置、读歌单、扫曲库、歌词窗该开着就开着。 */
  async function ensureStarted() {
    if (started) return;
    started = true;
    syncConfig();
    state.lyricsOpen = Boolean(readConfig().lyricsOn);
    if (state.lyricsOpen) ensureLyricsWindow().open();
    state.playlists = await readPlaylists(userDataDir);
    await scan();
  }

  /** 现在在放的是哪一份列表：选中的歌单，或者曲库。 */
  function sourceTracks() {
    const playlist = state.playlists.find((p) => p.id === state.activePlaylistId);
    return playlist ? playlist.tracks : state.library;
  }

  /** 现在这份列表叫什么（曲库，还是歌单的名字）。 */
  function sourceLabel() {
    const playlist = state.playlists.find((p) => p.id === state.activePlaylistId);
    return playlist ? playlist.name : '曲库';
  }

  /** 列表变了：界面要重画。 */
  function touchList() {
    state.listVersion += 1;
  }

  /** 一份状态快照。`withTracks` 为真时带上整份列表（界面要画列表）。 */
  function snapshot(withTracks = false) {
    syncConfig();
    const tracks = sourceTracks();
    const track = state.current;
    const out = {
      folder: state.folder,
      sourceLabel: sourceLabel(),
      trackCount: tracks.length,
      libraryCount: state.library.length,
      truncated: state.truncated,
      scanning: state.scanning,
      libraryVersion: state.libraryVersion,
      listVersion: state.listVersion,
      index: state.index,
      activePlaylistId: state.activePlaylistId,
      playlists: state.playlists.map((p) => ({
        id: p.id,
        name: p.name,
        count: p.tracks.length,
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
      status: state.status,
    };
    if (withTracks) {
      out.tracks = tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        file: t.file,
      }));
      out.library = state.library.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        file: t.file,
      }));
    }
    return out;
  }

  /**
   * 状态变了：推给所有挂着这个插件的界面。
   *
   * 列表变了才推全量（带整份歌单），其余时候推简版——
   * 播放头每 250ms 动一次，整份列表跟着动太浪费。
   */
  function notify() {
    try {
      const full = state.listVersion !== pushedVersion;
      if (full) pushedVersion = state.listVersion;
      ctx.push?.(snapshot(full));
    } catch (err) {
      console.warn('[音乐] 状态推不出去：', err?.message);
    }
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
    for (const file of lyricPathsFor(track)) {
      try {
        const buffer = await readFile(file);
        lyricLines = parseLrc(decodeLyrics(buffer));
        break;
      } catch {
        // 没有这个文件就试下一个（同名与只带歌名两种摆法）。
      }
    }
    pushLyrics();
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
      state.status = state.activePlaylistId ? '这个歌单是空的' : '曲库是空的，先选一个音乐文件夹';
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
      state.status = state.activePlaylistId ? '这个歌单是空的' : '曲库是空的';
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
  // 曲库
  // -------------------------------------------------------------------------

  async function scan() {
    const folder = folderOfConfig();
    state.folder = folder;
    if (!folder) {
      state.library = [];
      state.libraryVersion += 1;
      touchList();
      state.index = -1;
      state.current = null;
      state.playing = false;
      state.status = '还没有音乐文件夹';
      notify();
      return { ok: false, message: state.status };
    }
    state.scanning = true;
    notify();
    const currentFile = state.current?.file || '';
    try {
      const { tracks, truncated } = await scanLibrary(folder);
      state.library = tracks;
      state.truncated = truncated;
      state.libraryVersion += 1;
      touchList();
      const at = currentFile ? sourceTracks().findIndex((t) => t.file === currentFile) : -1;
      state.index = at;
      if (at < 0 && !state.activePlaylistId) {
        // 正在放的那首没了：停掉。
        state.playing = false;
        state.position = 0;
        state.duration = 0;
        state.current = null;
      }
      state.status = tracks.length
        ? `曲库里 ${tracks.length} 首${truncated ? '（只收了前面一部分）' : ''}`
        : '这个文件夹里没找到音频文件';
    } catch (err) {
      state.status = `扫不了：${err?.message || err}`;
    }
    state.scanning = false;
    notify();
    return { ok: state.library.length > 0, message: state.status };
  }

  /** 让用户挑一个音乐文件夹。 */
  async function chooseFolder() {
    const result = await dialog.showOpenDialog({
      title: '选一个音乐文件夹',
      defaultPath: folderOfConfig() || undefined,
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, message: '没选文件夹' };
    }
    const folder = result.filePaths[0];
    await ctx.host.setConfig({ musicFolder: folder });
    state.folder = folder;
    await scan();
    return { ok: true, message: `音乐库：${folder}` };
  }

  // -------------------------------------------------------------------------
  // 播放列表
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

  /** 切到某个歌单（空 = 曲库）。 */
  function selectPlaylist(id) {
    const want = String(id || '');
    if (want && !state.playlists.some((p) => p.id === want)) {
      return { ok: false, message: '这个歌单已经不在了' };
    }
    state.activePlaylistId = want;
    // 列表换了：正在放的歌不一定在里面，下标要重新对。
    const currentFile = state.current?.file || '';
    state.index = currentFile ? sourceTracks().findIndex((t) => t.file === currentFile) : -1;
    touchList();
    const label = sourceLabel();
    state.status = want ? `在放「${label}」` : '在放曲库';
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
    state.status = `建好了「${clean}」`;
    notify();
    return { ok: true, message: state.status };
  }

  /** 删掉一个歌单。 */
  async function deletePlaylist(id) {
    const target = String(id || '');
    const playlist = state.playlists.find((p) => p.id === target);
    if (!playlist) return { ok: false, message: '这个歌单已经不在了' };
    state.playlists = removePlaylist(state.playlists, target);
    if (state.activePlaylistId === target) {
      state.activePlaylistId = '';
      state.index = -1;
    }
    touchList();
    await savePlaylists();
    state.status = `删掉了「${playlist.name}」`;
    notify();
    return { ok: true, message: state.status };
  }

  /** 往歌单里加歌（按文件路径认，重复的不加）。 */
  async function addSongToPlaylist(id, file) {
    const target = String(id || '');
    if (!state.playlists.some((p) => p.id === target)) {
      return { ok: false, message: '这个歌单已经不在了' };
    }
    const path = String(file || '');
    const track =
      state.library.find((t) => t.file === path) ||
      state.playlists.flatMap((p) => p.tracks).find((t) => t.file === path);
    if (!track) return { ok: false, message: '曲库里没有这首歌' };
    const { playlists, added } = addTracksToPlaylist(state.playlists, target, [track]);
    state.playlists = playlists;
    touchList();
    await savePlaylists();
    state.status = added ? `加了《${track.title}》` : '这首歌已经在歌单里了';
    notify();
    return { ok: true, message: state.status };
  }

  /** 把一个文件夹里的歌加进歌单。 */
  async function addFolderToPlaylist(id) {
    const target = String(id || '');
    if (!state.playlists.some((p) => p.id === target)) {
      return { ok: false, message: '先选一个播放列表' };
    }
    const result = await dialog.showOpenDialog({
      title: '选一个文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, message: '没选文件夹' };
    }
    const { tracks } = await scanLibrary(result.filePaths[0]);
    if (!tracks.length) {
      state.status = '这个文件夹里没找到音频文件';
      notify();
      return { ok: false, message: state.status };
    }
    const { playlists, added } = addTracksToPlaylist(state.playlists, target, tracks);
    state.playlists = playlists;
    touchList();
    await savePlaylists();
    state.status = added ? `加了 ${added} 首` : '这些歌都在歌单里了';
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
    state.status = '从歌单里拿掉了';
    notify();
    return { ok: true, message: state.status };
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

  /** 曲库里有没有一首歌对得上这句话（歌名或歌手名）。 */
  function matches(track, query) {
    const q = query.toLowerCase();
    return track.title.toLowerCase().includes(q) || track.artist.toLowerCase().includes(q);
  }

  /**
   * 在曲库里找歌。
   *
   * `song` 按**歌名**过滤，`artist` 按**歌手**过滤；两个都给就都要对上。
   *
   * @param {{song?: string, artist?: string}} filter
   * @returns {Array<{title: string, artist: string, file: string}>}
   */
  function search(filter) {
    const list = searchTracks(state.library, filter);
    return list.slice(0, 20).map((t) => ({ title: t.title, artist: t.artist, file: t.file }));
  }

  /** 放一首歌：给了名字就在曲库里找，找不到就放第一首。 */
  async function playMatch(query) {
    const q = String(query || '').trim();
    if (!q) return play(undefined);
    const track = state.library.find((t) => matches(t, q));
    if (!track) {
      state.status = `曲库里没有「${q}」`;
      notify();
      return { ok: false, message: state.status };
    }
    // 这首歌不在当前这份列表里：先把列表切回曲库，不然放不了它。
    if (!sourceTracks().some((t) => t.file === track.file)) {
      state.activePlaylistId = '';
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
    scan,
    chooseFolder,
    search,
    playMatch,
    selectPlaylist,
    createPlaylist,
    deletePlaylist,
    addSongToPlaylist,
    addFolderToPlaylist,
    removeSongFromPlaylist,
  };
}
