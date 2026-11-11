// plugins/music-player/lib/player.js
import { app, dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEngine } from './engine.js';
import { formatTime } from './format.js';
import { createLyricsWindow } from './lyrics-window.js';
import { lyricPathsFor, scanLibrary } from './library.js';
import { decodeLyrics, lineIndexAt, parseLrc } from './lrc.js';

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

  const state = {
    folder: '',
    tracks: [],
    truncated: false,
    scanning: false,
    /** 曲库变了就加一：界面靠它知道列表要不要重画。 */
    libraryVersion: 0,
    index: -1,
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

  /** 第一次真有人用这个插件：读配置、扫曲库、歌词窗该开着就开着。 */
  async function ensureStarted() {
    if (started) return;
    started = true;
    syncConfig();
    state.lyricsOpen = Boolean(readConfig().lyricsOn);
    if (state.lyricsOpen) ensureLyricsWindow().open();
    await scan();
  }

  /** 一份状态快照。`withTracks` 为真时带上整份曲库（界面要画列表）。 */
  function snapshot(withTracks = false) {
    syncConfig();
    const track = state.tracks[state.index] || null;
    const out = {
      folder: state.folder,
      trackCount: state.tracks.length,
      truncated: state.truncated,
      scanning: state.scanning,
      libraryVersion: state.libraryVersion,
      index: state.index,
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
      out.tracks = state.tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        file: t.file,
      }));
    }
    return out;
  }

  /** 状态变了：推给所有挂着这个插件的界面。 */
  function notify() {
    try {
      ctx.push?.(snapshot(false));
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
    const track = state.tracks[state.index] || null;
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
    if (index === undefined || index === null) {
      if (state.index >= 0 && state.index < state.tracks.length) return resume();
      return play(0);
    }
    if (!state.tracks.length) {
      state.status = '曲库是空的，先选一个音乐文件夹';
      notify();
      return { ok: false, message: state.status };
    }
    let at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at >= state.tracks.length) at = 0;
    const track = state.tracks[at];
    state.index = at;
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
    const total = state.tracks.length;
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
    if (!state.tracks.length) {
      state.status = '曲库是空的';
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
      state.tracks = [];
      state.libraryVersion += 1;
      state.index = -1;
      state.playing = false;
      state.status = '还没有音乐文件夹';
      notify();
      return { ok: false, message: state.status };
    }
    state.scanning = true;
    notify();
    const currentId = state.tracks[state.index]?.id || '';
    try {
      const { tracks, truncated } = await scanLibrary(folder);
      state.tracks = tracks;
      state.truncated = truncated;
      state.libraryVersion += 1;
      const at = currentId ? tracks.findIndex((t) => t.id === currentId) : -1;
      state.index = at;
      if (at < 0) {
        state.playing = false;
        state.position = 0;
        state.duration = 0;
      }
      state.status = tracks.length
        ? `曲库里 ${tracks.length} 首${truncated ? '（只收了前面一部分）' : ''}`
        : '这个文件夹里没找到音频文件';
    } catch (err) {
      state.status = `扫不了：${err?.message || err}`;
    }
    state.scanning = false;
    notify();
    return { ok: state.tracks.length > 0, message: state.status };
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

  function matches(track, query) {
    const q = query.toLowerCase();
    return track.title.toLowerCase().includes(q) || track.artist.toLowerCase().includes(q);
  }

  function search(query) {
    const q = String(query || '').trim();
    const list = q ? state.tracks.filter((t) => matches(t, q)) : state.tracks;
    return list.slice(0, 20).map((t) => ({ title: t.title, artist: t.artist, file: t.file }));
  }

  /** 放一首歌：给了名字就在曲库里找，找不到就放第一首。 */
  async function playMatch(query) {
    const q = String(query || '').trim();
    if (!q) return play(undefined);
    const at = state.tracks.findIndex((t) => matches(t, q));
    if (at < 0) {
      state.status = `曲库里没有「${q}」`;
      notify();
      return { ok: false, message: state.status };
    }
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
  };
}
