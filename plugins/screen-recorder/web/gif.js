// plugins/screen-recorder/web/gif.js
/**
 * GIF89a 编码器。
 *
 * 这个文件是**经典脚本**：渲染层页面用 `<script src>` 加载它。
 * 插件的页面走 file://，ES module 的 import 会被 CORS 拦掉，
 * 所以这里挂到 globalThis 上，而不是 export。
 *
 * MediaRecorder 产不出 GIF，所以这一路是**完全独立**的编码：
 * 逐帧取像素 → median cut 量化 → 索引 → LZW → GIF 的块结构。
 */
(function () {
  const MAGIC = 'GIF89a';

  function pushU16(bytes, value) {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  function pushString(bytes, text) {
    for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i));
  }

  /** 一个盒子：一批颜色，以及它们在三个通道上的取值范围。 */
  function makeBox(colors) {
    let rMin = 255;
    let rMax = 0;
    let gMin = 255;
    let gMax = 0;
    let bMin = 255;
    let bMax = 0;
    for (const c of colors) {
      const r = (c >> 16) & 0xff;
      const g = (c >> 8) & 0xff;
      const b = c & 0xff;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    return { colors, rMin, rMax, gMin, gMax, bMin, bMax };
  }

  function boxRange(box) {
    return Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
  }

  /** 沿范围最大的通道对半切。 */
  function splitBox(box) {
    const dr = box.rMax - box.rMin;
    const dg = box.gMax - box.gMin;
    const db = box.bMax - box.bMin;
    const shift = dr >= dg && dr >= db ? 16 : dg >= db ? 8 : 0;
    const sorted = box.colors.slice().sort((a, b) => ((a >> shift) & 255) - ((b >> shift) & 255));
    const mid = sorted.length >> 1;
    return [makeBox(sorted.slice(0, mid)), makeBox(sorted.slice(mid))];
  }

  function averageColor(colors) {
    if (!colors.length) return 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of colors) {
      r += (c >> 16) & 0xff;
      g += (c >> 8) & 0xff;
      b += c & 0xff;
    }
    const n = colors.length;
    return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
  }

  /**
   * 量化：把一帧的像素压到不超过 maxColors 种颜色。
   *
   * 颜色数不多时原样保留；多了才做 median cut。
   */
  function quantize(rgba, maxColors) {
    const unique = new Set();
    for (let i = 0; i < rgba.length; i += 4) {
      unique.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    }
    let colors = Array.from(unique);
    if (colors.length > maxColors) {
      const boxes = [makeBox(colors)];
      while (boxes.length < maxColors) {
        boxes.sort((a, b) => boxRange(b) - boxRange(a));
        const box = boxes.shift();
        if (!box) break;
        if (box.colors.length < 2 || boxRange(box) === 0) {
          // 切不动了（颜色都一样或只剩一个）：放回去，别把它的颜色丢了。
          boxes.push(box);
          break;
        }
        const [left, right] = splitBox(box);
        boxes.push(left, right);
      }
      colors = boxes.map((b) => averageColor(b.colors));
    }
    // GIF 的颜色表大小必须是 2 的幂，且至少 2 项。
    let bits = 1;
    while ((1 << bits) < colors.length) bits += 1;
    const tableSize = Math.min(256, 1 << bits);
    const palette = colors.slice(0, tableSize);
    while (palette.length < tableSize) palette.push(0);
    return { palette, tableSize };
  }

  /**
   * 把像素映射成调色板索引。
   *
   * **必须带缓存**：每帧 23 万个像素 × 256 色线性查找，单帧要 200ms 以上，
   * 逐帧编码直接卡死。缓存命中后是 O(1)。
   */
  function mapIndices(rgba, palette) {
    const cache = new Map();
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const key = (r << 16) | (g << 8) | b;
      let index = cache.get(key);
      if (index === undefined) {
        let best = 0;
        let bestDistance = Infinity;
        for (let p = 0; p < palette.length; p += 1) {
          const c = palette[p];
          const dr = r - ((c >> 16) & 0xff);
          const dg = g - ((c >> 8) & 0xff);
          const db = b - (c & 0xff);
          const distance = dr * dr + dg * dg + db * db;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = p;
          }
        }
        index = best;
        cache.set(key, index);
      }
      out[j] = index;
    }
    return out;
  }

  /**
   * GIF 的变长 LZW 编码。
   *
   * 与 PNG 的 LZW 不同：码宽从最小码长 + 1 起，涨到 12 位；
   * 码表满了要发一个 clear 码重新开始。
   *
   * **码宽的检查点很要紧**：必须在**加新条目前**检查。
   * 编码器的码表比解码器多一条（编码器先知道下一个字符），
   * 早一步加宽就会跟标准解码器错开一位——错在第 255 个码之后，
   * 那之后解出来的全是垃圾，而且只有画面够大时才看得出来。
   */
  function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let table = new Map();
    const out = [];
    let bitBuffer = 0;
    let bitCount = 0;

    const emit = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        out.push(bitBuffer & 0xff);
        bitBuffer >>= 8;
        bitCount -= 8;
      }
    };

    emit(clearCode);
    if (!indices.length) {
      emit(eoiCode);
      if (bitCount > 0) out.push(bitBuffer & 0xff);
      return out;
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      const k = indices[i];
      const key = prefix * 4096 + k;
      const found = table.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (nextCode < 4096) {
        if (nextCode > (1 << codeSize) - 1 && codeSize < 12) codeSize += 1;
        table.set(key, nextCode);
        nextCode += 1;
      } else {
        // 码表满了：发一个 clear，重新开始。
        emit(clearCode);
        table = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (bitCount > 0) out.push(bitBuffer & 0xff);
    return out;
  }

  /**
   * 一个 GIF 编码器。
   *
   * 帧是**逐个加**进去的：每一帧自己编码成字节就存起来，
   * 不把原始像素留在内存里（480×360×4 = 691KB/帧，攒一分钟就是几百 MB）。
   */
  class GifEncoder {
    constructor({ width, height, loop = 0, maxColors = 256 } = {}) {
      this.width = Math.max(1, Math.round(width));
      this.height = Math.max(1, Math.round(height));
      this.loop = loop;
      this.maxColors = maxColors;
      this.frames = [];

      const head = [];
      pushString(head, MAGIC);
      pushU16(head, this.width);
      pushU16(head, this.height);
      // 有全局颜色表（2 项占位）、色深 8 位、背景色 0、宽高比 0
      head.push(0xf0, 0x00, 0x00);
      head.push(0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
      // Netscape 循环扩展
      head.push(0x21, 0xff, 0x0b);
      pushString(head, 'NETSCAPE2.0');
      head.push(0x03, 0x01);
      pushU16(head, loop);
      head.push(0x00);
      this.head = head;
    }

    /**
     * 加一帧。
     *
     * @param {Uint8Array} rgba 一整帧的像素（width×height×4）
     * @param {number} delayMs 这一帧显示多久
     * @returns {Uint8Array} 这一帧自己的字节
     */
    addFrame(rgba, delayMs) {
      const { palette, tableSize } = quantize(rgba, this.maxColors);
      const indices = mapIndices(rgba, palette);
      const bits = Math.max(1, Math.round(Math.log2(tableSize)));
      const minCodeSize = Math.max(2, bits);

      const bytes = [];
      // 图形控制扩展：disposal=1（不处理）、不透明、延时（1/100 秒）
      bytes.push(0x21, 0xf9, 0x04, 0x04);
      pushU16(bytes, Math.max(1, Math.round((delayMs || 100) / 10)));
      bytes.push(0x00, 0x00);
      // 图像描述：局部颜色表、尺寸
      bytes.push(0x2c);
      pushU16(bytes, 0);
      pushU16(bytes, 0);
      pushU16(bytes, this.width);
      pushU16(bytes, this.height);
      bytes.push(0x80 | (bits - 1));
      for (const c of palette) bytes.push((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
      for (let i = palette.length; i < tableSize; i += 1) bytes.push(0x00, 0x00, 0x00);
      // LZW 数据
      bytes.push(minCodeSize);
      const data = lzwEncode(indices, minCodeSize);
      for (let i = 0; i < data.length; i += 255) {
        const chunk = data.slice(i, i + 255);
        bytes.push(chunk.length);
        for (const b of chunk) bytes.push(b);
      }
      bytes.push(0x00);

      const frame = Uint8Array.from(bytes);
      this.frames.push(frame);
      return frame;
    }

    /** 完整的 GIF 文件字节。 */
    bytes() {
      const total = this.head.length + this.frames.reduce((n, f) => n + f.length, 0) + 1;
      const out = new Uint8Array(total);
      let pos = 0;
      for (const b of this.head) {
        out[pos] = b;
        pos += 1;
      }
      for (const frame of this.frames) {
        out.set(frame, pos);
        pos += frame.length;
      }
      out[pos] = 0x3b; // 结尾
      return out;
    }
  }

  globalThis.ScreenRecorderGif = { GifEncoder };
})();
