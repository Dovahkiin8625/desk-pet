// plugins/music-player/lib/cover.js
/**
 * 歌单封面：歌曲文件里内嵌的那张图。
 *
 * 认得四种摆法：
 *
 * - mp3：ID3v2 的 APIC 帧（v2.2 叫 PIC）；
 * - flac：元数据块里的 PICTURE；
 * - mp4/m4a：moov → udta → meta → ilst → covr；
 * - ogg/opus：Vorbis 注释里的 METADATA_BLOCK_PICTURE。
 *
 * 认不出就返回 null——界面上画一个占位的封面就是了。
 *
 * 这里只管把图片**原样**取出来（不缩放）：缩放是主进程那边的事
 * （nativeImage），这个文件因此不依赖 Electron，能单独跑单测。
 */
import { open, stat } from 'node:fs/promises';

/** 开头这一段里找封面（ID3 的 APIC 与 FLAC 的 PICTURE 都在开头）。 */
const HEAD_SIZE = 512 * 1024;

/** mp4 的 moov 常在文件末尾：再从尾巴上找一遍。 */
const TAIL_SIZE = 4 * 1024 * 1024;

/** 读文件的前若干字节。 */
async function readHead(file, size) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** 读文件的最后若干字节。 */
async function readTail(file, size) {
  const info = await stat(file);
  const length = Math.min(size, info.size);
  if (length <= 0) return Buffer.alloc(0);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, info.size - length);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** ID3 的长度是「同步安全」的：每字节只有 7 位。 */
function synchsafe(buf, at) {
  return (
    ((buf[at] & 0x7f) << 21) |
    ((buf[at + 1] & 0x7f) << 14) |
    ((buf[at + 2] & 0x7f) << 7) |
    (buf[at + 3] & 0x7f)
  );
}

/** 把乱七八糟的 mime 收拾成能用的那种。 */
function normalizeMime(mime) {
  const value = String(mime || '').toLowerCase().trim();
  if (value === 'jpg' || value === 'jpeg' || value === 'image/jpg') return 'image/jpeg';
  if (value === 'png' || value === 'image/png') return 'image/png';
  if (value === 'gif' || value === 'image/gif') return 'image/gif';
  if (value === 'webp' || value === 'image/webp') return 'image/webp';
  if (value === 'bmp' || value === 'image/bmp') return 'image/bmp';
  return 'image/jpeg';
}

/** FLAC 的 PICTURE 块（ogg 的那张图也是这个格式）。 */
function parsePictureBlock(data) {
  if (!data || data.length < 32) return null;
  let at = 4; // 图片类型
  const mimeLen = data.readUInt32BE(at);
  at += 4;
  if (mimeLen > data.length) return null;
  const mime = data.toString('latin1', at, at + mimeLen);
  at += mimeLen;
  const descLen = data.readUInt32BE(at);
  at += 4 + descLen;
  at += 16; // 宽、高、位深、用的颜色数
  if (at + 4 > data.length) return null;
  const dataLen = data.readUInt32BE(at);
  at += 4;
  const bytes = data.subarray(at, at + dataLen);
  if (!bytes.length) return null;
  return { data: Buffer.from(bytes), mime: normalizeMime(mime) };
}

/** ID3 的 APIC 帧（v2.2 的 PIC 也在这儿处理）。 */
function parseApic(data, old) {
  if (!data || !data.length) return null;
  const encoding = data[0];
  let at = 1;
  let mime = '';
  if (old) {
    mime = data.toString('latin1', at, at + 3);
    at += 3;
  } else {
    const end = data.indexOf(0, at);
    if (end < 0) return null;
    mime = data.toString('latin1', at, end);
    at = end + 1;
  }
  at += 1; // 图片类型
  if (encoding === 0 || encoding === 1) {
    const end = data.indexOf(0, at);
    if (end < 0) return null;
    at = end + 1;
  } else {
    let end = at;
    while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end += 2;
    at = end + 2;
  }
  const bytes = data.subarray(at);
  if (!bytes.length) return null;
  return { data: Buffer.from(bytes), mime: normalizeMime(mime) };
}

/** mp3：ID3v2 的帧里找 APIC。 */
function id3Artwork(head) {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
  const version = head[3];
  const flags = head[5];
  const size = synchsafe(head, 6);
  const body = head.subarray(10, Math.min(head.length, 10 + size));
  const old = version === 2;
  const idLen = old ? 3 : 4;
  const sizeLen = old ? 3 : 4;
  const headerLen = idLen + sizeLen + (old ? 0 : 2);
  let at = 0;
  if (flags & 0x40) {
    // 扩展头：v2.3 是普通长度，v2.4 是同步安全长度。
    at = version === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
  }
  while (at + headerLen <= body.length) {
    const id = body.toString('latin1', at, at + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // 到了填充区
    const frameSize = old
      ? body.readUIntBE(at + idLen, sizeLen)
      : version === 4
        ? synchsafe(body, at + idLen)
        : body.readUInt32BE(at + idLen);
    const start = at + headerLen;
    if (id === 'APIC' || (old && id === 'PIC')) {
      const pic = parseApic(body.subarray(start, start + frameSize), old);
      if (pic) return pic;
    }
    at = start + frameSize;
  }
  return null;
}

/** flac：元数据块里的 PICTURE。 */
function flacArtwork(head) {
  if (head.length < 4 || head.toString('latin1', 0, 4) !== 'fLaC') return null;
  let at = 4;
  while (at + 4 <= head.length) {
    const last = (head[at] & 0x80) !== 0;
    const type = head[at] & 0x7f;
    const size = head.readUIntBE(at + 1, 3);
    const start = at + 4;
    if (start + size > head.length) return null; // 读不全
    if (type === 6) return parsePictureBlock(head.subarray(start, start + size));
    at = start + size;
    if (last) break;
  }
  return null;
}

/** 在 buf 的 [start,end) 里找一条 atom 路径。 */
function findAtomPath(buf, start, end, path) {
  const [type, ...rest] = path;
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const name = buf.toString('latin1', at + 4, at + 8);
    let headerLen = 8;
    if (size === 1) {
      if (at + 16 > end) return null;
      size = Number(buf.readBigUInt64BE(at + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < headerLen) return null;
    const dataStart = at + headerLen;
    const dataEnd = Math.min(at + size, end);
    if (name === type) {
      if (!rest.length) return { start: dataStart, end: dataEnd };
      // 'meta' 的头里还有 4 字节版本号。
      const skip = name === 'meta' ? 4 : 0;
      const found = findAtomPath(buf, dataStart + skip, dataEnd, rest);
      if (found) return found;
    }
    at += size;
  }
  return null;
}

/** mp4/m4a：ilst 里的 covr。 */
function mp4ArtworkIn(buf) {
  if (!buf || buf.length < 16) return null;
  let found = findAtomPath(buf, 0, buf.length, ['moov', 'udta', 'meta', 'ilst', 'covr']);
  let range = found;
  if (!range) {
    // 尾巴那一段是从中间开始的：直接找 'moov' 的标记。
    const at = buf.indexOf(Buffer.from('moov', 'latin1'));
    if (at < 4) return null;
    const atomStart = at - 4;
    let size = buf.readUInt32BE(atomStart);
    if (size === 1) {
      if (atomStart + 16 > buf.length) return null;
      size = Number(buf.readBigUInt64BE(atomStart + 8));
    } else if (size === 0) {
      size = buf.length - atomStart;
    }
    if (size < 8) return null;
    range = findAtomPath(
      buf,
      at + 4,
      Math.min(atomStart + size, buf.length),
      ['udta', 'meta', 'ilst', 'covr']
    );
  }
  if (!range) return null;
  const data = findAtomPath(buf, range.start, range.end, ['data']);
  if (!data) return null;
  // data 原子：4 字节类型（13 = JPEG，14 = PNG）+ 4 字节语言 + 图片。
  const kind = buf.readUInt32BE(data.start) & 0xffffff;
  const bytes = buf.subarray(data.start + 8, data.end);
  if (!bytes.length) return null;
  return { data: Buffer.from(bytes), mime: kind === 14 ? 'image/png' : 'image/jpeg' };
}

/** ogg/opus：Vorbis 注释里的 METADATA_BLOCK_PICTURE（base64）。 */
function oggArtwork(head) {
  const marker = Buffer.from('METADATA_BLOCK_PICTURE=', 'latin1');
  const at = head.indexOf(marker);
  if (at < 0) return null;
  let end = at + marker.length;
  while (end < head.length && /[A-Za-z0-9+/=]/.test(String.fromCharCode(head[end]))) end += 1;
  const text = head.toString('latin1', at + marker.length, end).replace(/\s+/g, '');
  if (!text) return null;
  let buf;
  try {
    buf = Buffer.from(text, 'base64');
  } catch {
    return null;
  }
  return parsePictureBlock(buf);
}

/** 这是不是 mp4（moov 常在末尾，要再读一次尾巴）。 */
function looksLikeMp4(head) {
  if (head.length < 12) return false;
  const type = head.toString('latin1', 4, 8);
  return type === 'ftyp' || type === 'moov' || type === 'mdat';
}

/**
 * 取一首歌里内嵌的封面。
 *
 * @param {string} file 歌曲文件的路径
 * @returns {Promise<{data: Buffer, mime: string} | null>}
 */
export async function extractArtwork(file) {
  const path = String(file || '').trim();
  if (!path) return null;
  let head;
  try {
    head = await readHead(path, HEAD_SIZE);
  } catch {
    return null;
  }
  if (!head.length) return null;
  const found =
    id3Artwork(head) || flacArtwork(head) || mp4ArtworkIn(head) || oggArtwork(head);
  if (found) return found;
  if (!looksLikeMp4(head)) return null;
  try {
    const tail = await readTail(path, TAIL_SIZE);
    return mp4ArtworkIn(tail);
  } catch {
    return null;
  }
}
