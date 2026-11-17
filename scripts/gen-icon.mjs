// 从 assets/icons/icon.png 派生托盘图标。
//
// icon.png 是设计稿（z-image 生成的 487×487 圆形头像）。
// 托盘需要 16×16（tray.png）与 32×32（tray@2x.png）——
// 从 487 一眼缩到 16 糊得不能看，所以这里做**面积平均**（每个输出像素
// 是它覆盖的全部源像素的加权平均），透明区域按直 alpha 处理，
// 边缘不会出黑毛刺。
//
// 想换图标设计稿：替换 assets/icons/icon.png，再跑一次本脚本。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, encodePng } from './png.js';

/**
 * 面积平均降采样到 target×target。
 *
 * 颜色按 alpha 预乘后再平均（透明像素的颜色不参与平均），
 * 输出端再除回来——直接平均直 alpha 的颜色会在透明边缘留下黑边。
 */
export function downsample({ width, height, data }, target) {
  const out = Buffer.alloc(target * target * 4);
  for (let oy = 0; oy < target; oy++) {
    const y0 = Math.floor((oy * height) / target);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / target));
    for (let ox = 0; ox < target; ox++) {
      const x0 = Math.floor((ox * width) / target);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / target));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const alpha = data[i + 3] / 255;
          // 预乘：透明像素的颜色是无意义的（可能是黑），权重按 alpha。
          r += data[i] * alpha;
          g += data[i + 1] * alpha;
          b += data[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (oy * target + ox) * 4;
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

export async function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ICON_DIR = join(ROOT, 'assets', 'icons');
  const source = decodePng(await readFile(join(ICON_DIR, 'icon.png')));
  for (const { name, size } of [
    { name: 'tray.png', size: 16 },
    { name: 'tray@2x.png', size: 32 },
  ]) {
    const png = encodePng(size, size, downsample(source, size));
    await writeFile(join(ICON_DIR, name), png);
    console.log(`已生成 assets/icons/${name} (${size}x${size}, ${png.length} 字节)`);
  }
}

// 只有作为入口直接运行时才写文件；被 import 时不应产生副作用。
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  await main();
}
