// plugins/music-player/lib/lrc.js

/**
 * LRC 歌词：解析与对时。
 *
 * LCR 的一行是一个时间戳加一句词：`[00:12.50]歌词`。
 * 一行里可以挂好几个时间戳（同一句唱几遍），也可以有元信息
 * （`[ti:歌名]`、`[ar:歌手]`）——元信息不长得像时间戳，天然被跳过。
 */

/** 一行里的时间戳：`[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`。 */
function timeTags() {
  return /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
}

/**
 * 把一份 LRC 解析成按时间排好的行。
 *
 * @param {string} text LRC 的内容
 * @returns {Array<{t: number, text: string}>} t 是秒
 */
export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(timeTags())];
    if (!stamps.length) continue;
    const content = raw.replace(timeTags(), '').trim();
    for (const m of stamps) {
      const frac = m[3] || '';
      // ".5" 是半秒，".50" 是半秒，".500" 还是半秒——按位数算才对。
      const sub = frac ? Number(frac) / 10 ** frac.length : 0;
      lines.push({ t: Number(m[1]) * 60 + Number(m[2]) + sub, text: content });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

/**
 * 此刻该显示哪一行：最后一个时间到了的那一行。
 *
 * 没到第一行时是 -1（还没唱到）。
 */
export function lineIndexAt(lines, seconds) {
  const at = Number(seconds) || 0;
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].t <= at) index = i;
    else break;
  }
  return index;
}

/**
 * 歌词文件的解码。
 *
 * 中文歌词多半是 GBK 的，用 UTF-8 解会得到一堆乱码。
 * 先按严格的 UTF-8 试一次：解得动就是它，解不动再按 GBK 读。
 */
export function decodeLyrics(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}
