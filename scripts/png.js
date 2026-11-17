// PNG 读写（不依赖第三方图像库）。
//
// 编码：8 位 RGBA、无隔行（与 gen-icon 过去手写的一致）。
// 解码：8 位、colorType 6/2/0/4/3 的常规 PNG；
// 无隔行要求（z-image 之类的工具导出的通常都满足）。
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 把 RGBA 像素编码成 PNG。 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 读一个 PNG，返回 { width, height, data }（RGBA，直 alpha）。 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('decodePng: 需要 Buffer');
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('不是 PNG 文件');
  }
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') chunks.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === 'IHDR') {
      chunks.ihdr = buf.subarray(off + 8, off + 8 + len);
    }
    off += 12 + len;
  }
  const ihdr = chunks.ihdr;
  if (!ihdr) throw new Error('缺 IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error(`只支持 8 位深（这个是 ${bitDepth}）`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 colorType：${colorType}`);

  // 调色板（colorType 3 用）。
  let palette = null;
  off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'PLTE') palette = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
  }

  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks));
  const img = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride, 0);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    if (filter === 1) {
      for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0;
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? line[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    } else if (filter !== 0) {
      throw new Error(`未知的 filter：${filter}`);
    }
    line.copy(img, y * stride);
    prev = line;
  }

  // 统一展开成 RGBA。
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (colorType === 6) {
      rgba[d] = img[s]; rgba[d + 1] = img[s + 1]; rgba[d + 2] = img[s + 2]; rgba[d + 3] = img[s + 3];
    } else if (colorType === 2) {
      rgba[d] = img[s]; rgba[d + 1] = img[s + 1]; rgba[d + 2] = img[s + 2]; rgba[d + 3] = 255;
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = img[s]; rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = img[s]; rgba[d + 3] = img[s + 1];
    } else if (colorType === 3 && palette) {
      const idx = img[s] * 3;
      rgba[d] = palette[idx]; rgba[d + 1] = palette[idx + 1]; rgba[d + 2] = palette[idx + 2]; rgba[d + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}
