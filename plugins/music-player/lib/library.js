// plugins/music-player/lib/library.js
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/** 认得的音频格式。 */
const AUDIO_EXT = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus',
  '.wma', '.ape', '.aif', '.aiff', '.alac',
]);

/** 扫到这么深就停。 */
const MAX_DEPTH = 4;

/** 最多收这么多首——再多界面也用不完。 */
const MAX_TRACKS = 5000;

/**
 * 一首歌的样子。
 *
 * 歌名与歌手从**文件名**里认：「歌手 - 歌名.mp3」。
 * 认不出就整个文件名当歌名——总比空着强。
 */
function makeTrack(file) {
  const base = basename(file, extname(file));
  // 开头的曲号（"01 - "、"03."）不是歌名的一部分。
  const cleaned = base.replace(/^\s*\d{1,3}\s*[-_.]\s*/, '');
  const dash = cleaned.indexOf(' - ');
  const artist = dash > 0 ? cleaned.slice(0, dash).trim() : '';
  const title = dash > 0 ? cleaned.slice(dash + 3).trim() : cleaned;
  return {
    id: file,
    file,
    base,
    title: title || cleaned || base,
    artist,
  };
}

/**
 * 扫一个文件夹，把音频文件收成曲库。
 *
 * @param {string} folder 音乐文件夹
 * @returns {Promise<{tracks: object[], truncated: boolean}>}
 */
export async function scanLibrary(folder) {
  const root = String(folder || '').trim();
  if (!root) return { tracks: [], truncated: false };
  const tracks = [];
  let truncated = false;

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 读不了的目录跳过（权限、失效的链接）。
      return;
    }
    for (const entry of entries) {
      if (tracks.length >= MAX_TRACKS) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!AUDIO_EXT.has(extname(entry.name).toLowerCase())) continue;
      tracks.push(makeTrack(full));
    }
  }

  await walk(root, 0);
  tracks.sort((a, b) => a.file.localeCompare(b.file, 'zh-CN'));
  return { tracks, truncated };
}

/**
 * 这首歌的歌词文件在哪：同目录下的 `.lrc`。
 *
 * 两种常见摆法都认：与歌曲同名的（「周杰伦 - 稻香.lrc」），
 * 以及只用歌名的（「稻香.lrc」）。按顺序试。
 */
export function lyricPathsFor(track) {
  const dir = dirname(track.file);
  const out = [join(dir, `${track.base}.lrc`)];
  if (track.title && track.title !== track.base) out.push(join(dir, `${track.title}.lrc`));
  return out;
}
