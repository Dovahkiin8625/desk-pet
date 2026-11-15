// plugins/clipboard/lib/formats.js
/**
 * 剪贴板**多格式**读取：把电子（Electron）剪贴板 API 读出来的东西
 * 收拾成一条可记的内容。
 *
 * 不直接拽 electron（只收一个长得像 ClipboardItem 的对象进来），
 * 于是「解析」这段能直接用 node --test 验。
 *
 * 支持的格式（跟 CopyQ 的常见子集对齐）：
 *
 *   text/plain      纯文本
 *   text/html       富文本（HTML）
 *   text/rtf        富文本（RTF）
 *   text/uri-list   **复制的文件**（Windows 上就是 CF_HDROP，Explorer 里 Ctrl+C 的那种）
 *   image/*         图片（存 PNG）
 *
 * 其余格式（自定义 MIME、书签……）一律不记。
 */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { keyFor, MAX_TEXT_CHARS, MAX_FILES, MAX_IMAGE_BYTES, IMAGE_FILE_RE } from './history.js';

/** 图片格式优先级：能原样存就存，其余用 nativeImage 转成 PNG。 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/bmp', 'image/gif', 'image/webp', 'image/tiff'];

/**
 * 解析 text/uri-list（RFC 2483）→ 绝对路径数组。
 *
 * 只认 file:// 的 URI——别的（http:// 之类）不算「复制的文件」。
 * 注释行（以 # 开头）按规范跳过。
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseUriList(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const item = line.trim();
    if (!item || item.startsWith('#')) continue;
    if (!/^file:\/\//i.test(item)) continue;
    try {
      out.push(fileURLToPath(item));
    } catch {
      // 解析不了的 URI 跳过：宁可少一个文件，别让整条记录挂掉。
    }
  }
  return out;
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * HTML → 纯文本（粗糙但够用）。
 *
 * 去掉 script/style、剥掉标签、解常见实体、压空白——
 * 给「没有 text/plain、只有 text/html」的复制（比如从某些富文本编辑器里
 * 复制）当显示文本与粘贴时的纯文本兜底。
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  const source = String(html || '');
  if (!source) return '';
  const withoutBlocks = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|head)[\s\S]*?<\/\1>/gi, ' ')
    // 块级元素换行，省得整段糊成一行。
    .replace(/<\/(p|div|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const decoded = withoutBlocks.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
    const name = String(entity).toLowerCase();
    if (name.startsWith('#x')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
  return decoded.replace(/[\t\f\v ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/**
 * 从一条 ClipboardItem 里读出所有支持的格式。
 *
 * @param {object} item { types: string[], getType(type): Promise<Blob> }
 * @param {object} [deps]
 * @param {object} [deps.nativeImage] electron 的 nativeImage（转 PNG 用；不给就不转非 PNG 的图）
 * @returns {Promise<object>} 见下：
 *   { ok: true, snapshot, png }  正常
 *   { ok: true, empty: true }    剪贴板里没有支持的格式
 *   { ok: true, tooBig: true, signature }  内容太大了（signature 已算好，调用方自行决定怎么提示）
 *   { ok: false }                读不了（抛异常了）
 */
export async function readSnapshot(item, { nativeImage } = {}) {
  try {
    const types = Array.isArray(item?.types) ? item.types : [];
    const has = (type) => types.includes(type);
    if (!types.length) return { ok: true, empty: true };

    /** 读一路文本格式；读不出来 / 超限就算没有。 */
    const readTextFormat = async (type) => {
      try {
        const blob = await item.getType(type);
        const text = await blob.text();
        return typeof text === 'string' ? text : '';
      } catch {
        return null;
      }
    };

    const rawText = has('text/plain') ? await readTextFormat('text/plain') : null;
    const html = has('text/html') ? await readTextFormat('text/html') : null;
    const rtf = has('text/rtf') ? await readTextFormat('text/rtf') : null;

    // 文本类格式超限：整条不记（记半截的 HTML 贴出去是坏的）。
    if ([rawText, html, rtf].some((value) => typeof value === 'string' && value.length > MAX_TEXT_CHARS)) {
      // 哈希还是要算的：外部拿去作为「这一条已经看过了」的记号，免得每轮轮询都重新读一遍大文件。
      return { ok: true, tooBig: true, signature: keyFor({ text: rawText || '', html, rtf }) };
    }

    let files = null;
    if (has('text/uri-list')) {
      try {
        const blob = await item.getType('text/uri-list');
        const parsed = parseUriList(await blob.text()).slice(0, MAX_FILES);
        files = parsed.length ? parsed : null;
      } catch {
        files = null;
      }
    }

    let png = null;
    let imageSha = null;
    let imageWidth = null;
    let imageHeight = null;
    const imageType = IMAGE_TYPES.find(has);
    if (imageType) {
      try {
        const blob = await item.getType(imageType);
        const bytes = Buffer.from(await blob.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) {
          return { ok: true, tooBig: true, signature: `image-too-big:${createHash('sha1').update(bytes).digest('hex')}` };
        }
        if (imageType === 'image/png') {
          png = bytes;
        } else if (nativeImage?.createFromBuffer) {
          // 非 PNG 的图统一转成 PNG 存（bmp/gif/jpeg/webp/tiff）。
          const image = nativeImage.createFromBuffer(bytes);
          if (!image.isEmpty()) {
            const size = image.getSize();
            imageWidth = Number.isFinite(size?.width) ? size.width : null;
            imageHeight = Number.isFinite(size?.height) ? size.height : null;
            png = image.toPNG();
          }
        }
        if (png && png.length) {
          imageSha = createHash('sha1').update(png).digest('hex');
          if (imageWidth === null) {
            // 从 PNG 头里解尺寸（不需要 nativeImage）。
            const size = pngSize(png);
            imageWidth = size.width;
            imageHeight = size.height;
          }
        }
      } catch {
        png = null;
        imageSha = null;
      }
    }

    const text =
      typeof rawText === 'string' && rawText.length
        ? rawText
        : html
          ? stripHtml(html)
          : '';
    // files 里自己也可能带 text/plain（比如 Explorer 复制文件时附的路径文本）——
    // 那就照原样存下来，贴的时候两个都写回去。

    if (!text && !html && !rtf && !files && !png) {
      return { ok: true, empty: true };
    }

    const snapshot = {
      kind: png ? 'image' : files ? 'files' : 'text',
      text,
      html: html || null,
      rtf: rtf || null,
      files,
      imageSha,
      imageFile: imageSha ? `img-${imageSha}.png` : null,
      imageWidth,
      imageHeight,
      imageBytes: png ? png.length : null,
    };
    snapshot.key = keyFor(snapshot);
    if (imageType && !IMAGE_FILE_RE.test(snapshot.imageFile || '')) {
      // 兜底：文件名对不起格式就当没图（正常不会走到这儿）。
      return { ok: true, empty: true };
    }
    return { ok: true, snapshot, png };
  } catch {
    return { ok: false };
  }
}

/** 从 PNG 字节的前几个字节里解宽高（合法 PNG 必有 IHDR，宽高就在偏移 16 与 20）。 */
export function pngSize(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 24) return { width: null, height: null };
    if (bytes.toString('ascii', 1, 4) !== 'PNG') return { width: null, height: null };
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch {
    return { width: null, height: null };
  }
}
