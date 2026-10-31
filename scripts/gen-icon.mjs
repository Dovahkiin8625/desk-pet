// 生成托盘图标 PNG，不依赖任何第三方图像库。
// 输出 32x32 与 64x64 两个尺寸，托盘优先使用 @2x。
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// 以 4 倍超采样绘制再降采样，得到平滑边缘。
export function drawIcon(size) {
  const S = 4;
  const W = size * S;
  const acc = new Float32Array(W * W * 4);
  const put = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const sa = a / 255;
    acc[i] = acc[i] * (1 - sa) + r * sa;
    acc[i + 1] = acc[i + 1] * (1 - sa) + g * sa;
    acc[i + 2] = acc[i + 2] * (1 - sa) + b * sa;
    acc[i + 3] = acc[i + 3] * (1 - sa) + a;
  };
  const ell = (cx, cy, rx, ry, color) => {
    const x0 = Math.floor((cx - rx) * W), x1 = Math.ceil((cx + rx) * W);
    const y0 = Math.floor((cy - ry) * W), y1 = Math.ceil((cy + ry) * W);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5) / W, ny = (y + 0.5) / W;
        const d = ((nx - cx) / rx) ** 2 + ((ny - cy) / ry) ** 2;
        if (d <= 1) put(x, y, color);
      }
    }
  };
  const arc = (cx, cy, r, thick, yMin, color) => {
    const x0 = Math.floor((cx - r - thick) * W), x1 = Math.ceil((cx + r + thick) * W);
    const y0 = Math.floor((cy - r - thick) * W), y1 = Math.ceil((cy + r + thick) * W);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5) / W, ny = (y + 0.5) / W;
        const d = Math.abs(Math.hypot(nx - cx, ny - cy) - r);
        if (d <= thick && ny >= yMin) put(x, y, color);
      }
    }
  };

  const HAIR = [138, 118, 196, 255];
  const SKIN = [250, 219, 191, 255];
  const INK = [58, 48, 68, 255];
  const BLUSH = [243, 146, 158, 150];
  const OUTLINE = [90, 74, 120, 255];

  ell(0.5, 0.40, 0.44, 0.36, HAIR);       // 头发
  ell(0.5, 0.44, 0.40, 0.30, OUTLINE);    // 外描边
  ell(0.5, 0.46, 0.38, 0.28, SKIN);       // 脸
  ell(0.5, 0.36, 0.40, 0.24, HAIR);       // 刘海
  ell(0.385, 0.53, 0.055, 0.075, INK);    // 左眼
  ell(0.615, 0.53, 0.055, 0.075, INK);    // 右眼
  ell(0.275, 0.62, 0.075, 0.045, BLUSH);  // 左腮红
  ell(0.725, 0.62, 0.075, 0.045, BLUSH);  // 右腮红
  arc(0.5, 0.60, 0.10, 0.018, 0.60, INK); // 微笑

  // 降采样到目标尺寸
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * W + (x * S + sx)) * 4;
          r += acc[i]; g += acc[i + 1]; b += acc[i + 2]; a += acc[i + 3];
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      if (alpha > 0) {
        // acc 中保存的是「预乘 alpha」的颜色，PNG 要求直通 alpha，
        // 因此要按累计 alpha 反预乘，否则边缘像素会按覆盖率变暗（出现黑边）。
        out[o] = Math.min(255, Math.round((255 * r) / a));
        out[o + 1] = Math.min(255, Math.round((255 * g) / a));
        out[o + 2] = Math.min(255, Math.round((255 * b) / a));
      }
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

export async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ICON_DIR = join(ROOT, 'assets', 'icons');
  await mkdir(ICON_DIR, { recursive: true });
  for (const size of [32, 64]) {
    const png = encodePng(size, size, drawIcon(size));
    const name = size === 32 ? 'tray.png' : 'tray@2x.png';
    await writeFile(join(ICON_DIR, name), png);
    console.log(`已生成 assets/icons/${name} (${size}x${size}, ${png.length} 字节)`);
  }
}

// 只有作为入口直接运行时才写文件；被 import 时不应产生副作用。
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  await main();
}
