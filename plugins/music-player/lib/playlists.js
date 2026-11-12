// plugins/music-player/lib/playlists.js
/**
 * 播放列表：歌单的数据与落盘。
 *
 * 歌单存在 `userData/music-playlists.json`——不放插件目录里
 * （插件目录在安装目录下，多半没有写权限）。
 *
 * 歌单里存的是**整首歌**（路径、歌名、歌手），不是别处的下标：
 * 下标会变，歌单却不该跟着变。
 *
 * 这里的函数都是**纯的**：给一份歌单，返回一份新的。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

/** 歌单文件的名字。 */
export const PLAYLISTS_FILE = 'music-playlists.json';

/** 默认列表：永远在第一个，删不掉。 */
export const DEFAULT_PLAYLIST_ID = 'default';

/** 默认列表的名字。 */
export const DEFAULT_PLAYLIST_NAME = '默认列表';

/** 歌单文件的位置。 */
export function playlistsPath(userDataDir) {
  return join(userDataDir, PLAYLISTS_FILE);
}

/** 一个歌单 id。 */
export function makeId() {
  return `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 一首歌在歌单里存的样子。 */
function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = String(raw.file || '').trim();
  if (!file) return null;
  const title = String(raw.title || '').trim();
  const base = String(raw.base || '').trim() || basename(file, extname(file));
  return {
    id: file,
    file,
    base,
    title: title || base,
    artist: String(raw.artist || '').trim(),
  };
}

/**
 * 把读进来的东西收拾成一个像样的歌单表。
 *
 * 磁盘上的文件是上一次运行留下的，可能缺字段、可能类型不对——
 * 认不出来的直接丢掉（歌单是给人看的东西，宁可少一个也别画错）。
 *
 * @param {unknown} raw
 * @returns {Array<{id: string, name: string, tracks: object[]}>}
 */
export function normalizePlaylists(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.playlists) ? raw.playlists : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    const tracks = [];
    const seen = new Set();
    for (const raw2 of Array.isArray(item.tracks) ? item.tracks : []) {
      const track = normalizeTrack(raw2);
      if (!track || seen.has(track.file)) continue;
      seen.add(track.file);
      tracks.push(track);
    }
    out.push({
      id: String(item.id || '').trim() || makeId(),
      name,
      cover: String(item.cover || '').trim(),
      tracks,
    });
  }
  return out;
}

/**
 * 默认列表永远在第一个。
 *
 * 没有就补一个空的；名字固定（默认列表是内置的，不给改）。
 *
 * @param {Array} playlists
 * @returns {Array}
 */
export function ensureDefaultPlaylist(playlists) {
  const list = Array.isArray(playlists) ? playlists : [];
  const base = list.find((p) => p.id === DEFAULT_PLAYLIST_ID);
  const head = {
    ...(base || {}),
    id: DEFAULT_PLAYLIST_ID,
    name: DEFAULT_PLAYLIST_NAME,
    cover: String(base?.cover || ''),
    tracks: Array.isArray(base?.tracks) ? base.tracks : [],
  };
  return [head, ...list.filter((p) => p.id !== DEFAULT_PLAYLIST_ID)];
}

/** 换个封面（空字符串 = 用第一首歌的图）。 */
export function setPlaylistCover(playlists, id, cover) {
  const want = String(cover || '').trim();
  return playlists.map((p) => (p.id === id ? { ...p, cover: want } : p));
}

/** 加一个歌单（放最后）。 */
export function addPlaylist(playlists, name) {
  const clean = String(name || '').trim();
  if (!clean) return playlists;
  return [...playlists, { id: makeId(), name: clean, tracks: [] }];
}

/** 删掉一个歌单。 */
export function removePlaylist(playlists, id) {
  return playlists.filter((p) => p.id !== id);
}

/**
 * 往歌单里加歌。
 *
 * 同一首歌只加一次（按文件路径认）。
 *
 * @param {Array} playlists
 * @param {string} id 歌单 id
 * @param {object[]} tracks 要加的歌
 * @returns {{playlists: Array, added: number}} 新的歌单表与这次加进去几首
 */
export function addTracksToPlaylist(playlists, id, tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  let added = 0;
  const out = playlists.map((p) => {
    if (p.id !== id) return p;
    const have = new Set(p.tracks.map((t) => t.file));
    const fresh = [];
    for (const raw of list) {
      const track = normalizeTrack(raw);
      if (!track || have.has(track.file)) continue;
      have.add(track.file);
      fresh.push(track);
    }
    added = fresh.length;
    return { ...p, tracks: [...p.tracks, ...fresh] };
  });
  return { playlists: out, added };
}

/** 从歌单里去掉一首歌。 */
export function removeTrackFromPlaylist(playlists, id, file) {
  const target = String(file || '');
  return playlists.map((p) =>
    p.id === id ? { ...p, tracks: p.tracks.filter((t) => t.file !== target) } : p
  );
}

/**
 * 读歌单；读不到或读坏了都当作空的。
 *
 * @param {string} userDataDir
 * @returns {Promise<Array>}
 */
export async function readPlaylists(userDataDir) {
  try {
    const text = await readFile(playlistsPath(userDataDir), 'utf8');
    return normalizePlaylists(JSON.parse(text));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[音乐] 歌单读不了，当作空的：', err?.message);
    }
    return [];
  }
}

/**
 * 写歌单（原子：先写 .tmp 再 rename）。
 *
 * 普通 writeFile 会先把目标截断成 0 字节，写到一半被强杀就留下一个空文件，
 * 下次启动歌单全丢。
 *
 * @param {string} userDataDir
 * @param {Array} playlists
 * @returns {Promise<Array>} 写下去的那份（已规整过）
 */
export async function writePlaylists(userDataDir, playlists) {
  const value = normalizePlaylists(playlists);
  await mkdir(userDataDir, { recursive: true });
  const target = playlistsPath(userDataDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify({ playlists: value }, null, 2), 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return value;
}
