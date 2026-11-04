import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebScript } from './helpers/load-web-script.js';

const { ScreenRecorderGif } = await loadWebScript('../../../plugins/screen-recorder/web/gif.js');

/** 造一帧纯色像素。 */
function solidFrame(width, height, r, g, b) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  }
  return rgba;
}

/**
 * 解一段 LZW 数据，返回索引序列。
 *
 * 这是**测试自己写的解码器**：编码器与解码器互相印证，
 * 才能发现「LZW 写反了」「码宽提前变了」这类结构性错误。
 */
function lzwDecode(bytes, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const dict = [];
  const reset = () => {
    dict.length = 0;
    for (let i = 0; i < clear; i += 1) dict[i] = [i];
    dict[clear] = [];
    dict[eoi] = [];
  };
  reset();
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let bitPos = 0;
  const out = [];
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byte = bytes[bitPos >> 3];
      if (byte === undefined) return eoi;
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos += 1;
    }
    return code;
  };
  let prev = null;
  for (;;) {
    const code = readCode();
    if (code === eoi) break;
    if (code === clear) {
      reset();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = null;
      continue;
    }
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error(`LZW 解码失败：码 ${code} 越界`);
    out.push(...entry);
    if (prev) {
      dict[next] = [...prev, entry[0]];
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  return out;
}

/** 把 GIF 的字节拆成：头、逻辑屏、每帧的像素。 */
function parseGif(bytes) {
  const text = (from, len) => String.fromCharCode(...bytes.slice(from, from + len));
  assert.equal(text(0, 6), 'GIF89a', '文件头得是 GIF89a');
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  let pos = 13;
  // 逻辑屏幕描述符的第 5 个字节：高位是「有没有全局颜色表」，
  // 低 3 位是颜色表大小（2^(n+1) 项，每项 3 字节）。
  const screenPacked = bytes[10];
  if (screenPacked & 0x80) {
    pos += 3 * 2 ** ((screenPacked & 0x07) + 1);
  }
  const frames = [];
  for (;;) {
    const marker = bytes[pos];
    if (marker === 0x3b) {
      pos += 1;
      break;
    }
    if (marker === 0x21) {
      // 扩展块：跳过，直到块结束
      pos += 2;
      while (bytes[pos] !== 0) pos += 1 + bytes[pos];
      pos += 1;
      continue;
    }
    if (marker === 0x2c) {
      const frameWidth = bytes[pos + 5] | (bytes[pos + 6] << 8);
      const frameHeight = bytes[pos + 7] | (bytes[pos + 8] << 8);
      const packed = bytes[pos + 9];
      let cursor = pos + 10;
      const palette = [];
      if (packed & 0x80) {
        const size = 2 ** ((packed & 0x07) + 1);
        for (let i = 0; i < size; i += 1) {
          palette.push([bytes[cursor], bytes[cursor + 1], bytes[cursor + 2]]);
          cursor += 3;
        }
      }
      const minCodeSize = bytes[cursor];
      cursor += 1;
      const data = [];
      while (bytes[cursor] !== 0) {
        const len = bytes[cursor];
        for (let i = 1; i <= len; i += 1) data.push(bytes[cursor + i]);
        cursor += 1 + len;
      }
      frames.push({ width: frameWidth, height: frameHeight, palette, pixels: lzwDecode(data, minCodeSize) });
      pos = cursor + 1;
      continue;
    }
    throw new Error(`没见过的块标记 0x${marker.toString(16)}（位置 ${pos}）`);
  }
  return { width, height, frames, tail: bytes.slice(pos) };
}

test('编码出来的 GIF 结构完整：头、尺寸、结尾', () => {
  const enc = new ScreenRecorderGif.GifEncoder({ width: 4, height: 2 });
  enc.addFrame(solidFrame(4, 2, 255, 0, 0), 100);
  const bytes = enc.bytes();
  const parsed = parseGif(bytes);
  assert.equal(parsed.width, 4);
  assert.equal(parsed.height, 2);
  assert.equal(parsed.frames.length, 1);
  assert.equal(bytes[bytes.length - 1], 0x3b, '结尾得是 0x3B');
  assert.equal(parsed.tail.length, 0, '结尾之后没有别的');
});

test('像素能原样回来：红色就是红色', () => {
  const enc = new ScreenRecorderGif.GifEncoder({ width: 4, height: 2 });
  enc.addFrame(solidFrame(4, 2, 255, 0, 0), 100);
  const parsed = parseGif(enc.bytes());
  const frame = parsed.frames[0];
  assert.equal(frame.pixels.length, 8, '4×2 = 8 个像素');
  for (const index of frame.pixels) {
    assert.deepEqual(frame.palette[index], [255, 0, 0]);
  }
});

test('多帧各自带自己的颜色', () => {
  const enc = new ScreenRecorderGif.GifEncoder({ width: 2, height: 1 });
  enc.addFrame(solidFrame(2, 1, 255, 0, 0), 100);
  enc.addFrame(solidFrame(2, 1, 0, 0, 255), 250);
  const parsed = parseGif(enc.bytes());
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual(parsed.frames[0].palette[parsed.frames[0].pixels[0]], [255, 0, 0]);
  assert.deepEqual(parsed.frames[1].palette[parsed.frames[1].pixels[0]], [0, 0, 255]);
});

test('颜色多于 256 种时会被量化，但像素仍然是那些颜色里的', () => {
  const width = 32;
  const height = 32;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = i % 256;
    rgba[i + 1] = (i * 3) % 256;
    rgba[i + 2] = (i * 7) % 256;
    rgba[i + 3] = 255;
  }
  const enc = new ScreenRecorderGif.GifEncoder({ width, height });
  enc.addFrame(rgba, 100);
  const parsed = parseGif(enc.bytes());
  const frame = parsed.frames[0];
  assert.ok(frame.palette.length <= 256, '调色板不超过 256 色');
  assert.equal(
    frame.palette.length,
    2 ** Math.round(Math.log2(frame.palette.length)),
    '颜色表大小得是 2 的幂'
  );
  assert.equal(frame.pixels.length, width * height);
  for (const index of frame.pixels) {
    assert.ok(index < frame.palette.length, '索引不能越界');
  }
});
