// plugins/clipboard/lib/history.js
/**
 * 剪贴板历史的**纯逻辑**。
 *
 * 不碰 Electron、不碰磁盘（除了 node:crypto 算哈希）：条目怎么加、怎么排、
 * 怎么淘汰都在这儿，于是能直接用 node --test 验。
 *
 * 一条条目可以带多种格式（文本 + HTML + 图片 + 文件，跟复制出来的东西本来
 * 就是多格式的）。**去重认 `key`**——key 一样就是同一条内容，复制第二次
 * 只挪到最上面，不新增一条。key 由「里面有什么」算出来（见 keyFor）：
 *
 *   image:<图片哈希>     复制的是图片
 *   files:<路径哈希>     复制的是文件（text/uri-list）
 *   text:<内容哈希>      其余（纯文本 / HTML / RTF；哈希覆盖三种格式里的全部内容）
 *
 * 图片的字节**不落 JSON**：只存 `img-<哈希>.png` 这个名字，
 * 字节由 store.js 写到 userData/clipboard-images/ 里。
 */
import { createHash } from 'node:crypto';

/** 默认最多留多少条（**不含**固定的那些）。 */
export const DEFAULT_MAX_ENTRIES = 200;

/** 文本类格式（text/html、text/rtf）单条最大多少字符（超了不记，避免 5MB 的网页源码灌进 JSON）。 */
export const MAX_TEXT_CHARS = 256 * 1024;

/** 单条里最多记多少个文件路径。 */
export const MAX_FILES = 200;

/** 图片最大多少字节（超了不记）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 图片（PNG）文件名长这样：`img-<40 位 hex>.png`。 */
export const IMAGE_FILE_RE = /^img-[0-9a-f]{40}\.png$/;

/**
 * 造一个新的条目 id。
 *
 * **必须唯一**：固定、删除都是按 id 办的——
 * 两个条目撞了同一个 id，删一条就会把两条都删掉。
 */
let idSeq = 0;
export function newId() {
  idSeq += 1;
  return `e${Date.now().toString(36)}${idSeq.toString(36)}`;
}

const sha1 = (text) => createHash('sha1').update(String(text), 'utf8').digest('hex');

/**
 * 一条内容的 key：key 一样 = 同一条内容。
 *
 * @param {object} payload
 * @param {string} [payload.imageSha] 图片字节的 sha1（图片条目专用）
 * @param {string[]} [payload.files] 文件的绝对路径
 * @param {string} [payload.text]
 * @param {string|null} [payload.html]
 * @param {string|null} [payload.rtf]
 * @returns {string}
 */
export function keyFor(payload) {
  if (payload?.imageSha) return `image:${payload.imageSha}`;
  // 磁盘上的条目只有文件名没有字节哈希——而文件名就是 `img-<哈希>.png`，
  // 反推出来的 key 与记的时候算的是同一个。
  const m = typeof payload?.imageFile === 'string' ? /^img-([0-9a-f]{40})\.png$/.exec(payload.imageFile) : null;
  if (m) return `image:${m[1]}`;
  if (Array.isArray(payload?.files) && payload.files.length) {
    return `files:${sha1(payload.files.join('\u0000'))}`;
  }
  const text = String(payload?.text ?? '');
  const html = typeof payload?.html === 'string' ? payload.html : '';
  const rtf = typeof payload?.rtf === 'string' ? payload.rtf : '';
  return `text:${sha1([text, html, rtf].join('\u0000'))}`;
}

/** 字符串或者 null：空串当 null（没有就是没有）。 */
const strOrNull = (value) => {
  if (typeof value !== 'string') return null;
  return value ? value : null;
};

const numOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** 文件清单：字符串数组、去空、封顶。 */
function filesOrNull(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    if (!clean) continue;
    out.push(clean);
    if (out.length >= MAX_FILES) break;
  }
  return out.length ? out : null;
}

/** 图片文件名：只认 `img-<40 位 hex>.png`，别的一律丢（防路径穿越）。 */
const imageFileOrNull = (value) =>
  typeof value === 'string' && IMAGE_FILE_RE.test(value) ? value : null;

const KINDS = new Set(['text', 'image', 'files']);

/** 主类型：图片 > 文件 > 文本（富文本也算文本）。 */
export function kindOf(payload) {
  if (payload?.imageFile) return 'image';
  if (Array.isArray(payload?.files) && payload.files.length) return 'files';
  return 'text';
}

/**
 * 把一份「从剪贴板读出来的 / 从磁盘读回来的」数据收拾成一条条目。
 *
 * 认不出来的字段直接丢（宁可少存，别让整个插件崩掉）。
 *
 * @param {object} payload
 * @returns {object} 一条条目（id 已造好）
 */
export function makeEntry(payload, { at = Date.now(), id = '' } = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const text = String(source.text ?? '').slice(0, MAX_TEXT_CHARS);
  const htmlRaw = typeof source.html === 'string' ? source.html : null;
  const rtfRaw = typeof source.rtf === 'string' ? source.rtf : null;
  const entry = {
    id: typeof id === 'string' && id ? id : newId(),
    kind: KINDS.has(source.kind) ? source.kind : 'text',
    key: '',
    text,
    // 超大的 HTML / RTF 只丢那一路，条目本身还留着（纯文本还在）。
    html: htmlRaw ? htmlRaw.slice(0, MAX_TEXT_CHARS) : null,
    rtf: rtfRaw ? rtfRaw.slice(0, MAX_TEXT_CHARS) : null,
    files: filesOrNull(source.files),
    imageFile: imageFileOrNull(source.imageFile),
    imageWidth: numOrNull(source.imageWidth),
    imageHeight: numOrNull(source.imageHeight),
    imageBytes: numOrNull(source.imageBytes),
    at: Number.isFinite(Number(at)) ? Number(at) : 0,
    pinned: Boolean(source.pinned),
  };
  // 主类型以「实际有什么」为准（磁盘上的 kind 可能过期）。
  entry.kind = kindOf(entry);
  // key：给了就沿用（磁盘上存的），否则现算。
  entry.key = typeof source.key === 'string' && source.key ? source.key : keyFor(entry);
  return entry;
}

/**
 * 这条条目里到底写了点什么。空的不算一条——
 * 剪贴板被清空时读出来的东西哪种格式都没有。
 */
export function hasContent(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return Boolean(
    String(entry.text || '').trim() ||
      entry.html ||
      entry.rtf ||
      (Array.isArray(entry.files) && entry.files.length) ||
      entry.imageFile
  );
}

/**
 * 加一条。
 *
 * 同样的内容再复制一次：**挪到最上面**，不新增一条——
 * 列表里全是重复项等于没有列表。
 *
 * @param {Array} entries 现有的条目
 * @param {object} payload 读出来的内容（见 makeEntry）
 * @param {object} [opts]
 * @param {number} [opts.at] 什么时候复制的（毫秒时间戳）
 * @param {string} [opts.id] 新条目的 id（不给就自己造一个）
 * @param {number} [opts.max] 最多留多少条（不含固定的）
 * @returns {Array} 新的条目列表
 */
export function addEntry(entries, payload, { at = Date.now(), id = '', max = DEFAULT_MAX_ENTRIES } = {}) {
  const item = makeEntry(payload, { at, id });
  // 空的不算一条。
  if (!hasContent(item)) return entries;

  const same = entries.find((entry) => entry.key === item.key);
  const rest = same ? entries.filter((entry) => entry.id !== same.id) : entries;
  const merged = same
    ? // 重复的那条**沿用原来的 id 和固定状态**：它还是同一条内容，只是又复制了一遍。
      { ...item, id: same.id, pinned: Boolean(same.pinned) }
    : item;
  return trimEntries([merged, ...rest], max);
}

/**
 * 淘汰：固定的一律留着，其余的按新到旧留够 max 条。
 *
 * **按时间排过再留**：列表的顺序不一定是「新的在前」
 * （固定与取消固定会打乱它），不排就不知道该淘汰哪一条。
 *
 * @param {Array} entries
 * @param {number} [max]
 * @returns {Array}
 */
export function trimEntries(entries, max = DEFAULT_MAX_ENTRIES) {
  const pinned = entries.filter((item) => item.pinned);
  const rest = entries
    .filter((item) => !item.pinned)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, Math.max(0, max));
  return [...pinned, ...rest];
}

/**
 * 展示用的顺序：固定的在前，其余按时间倒序（新的在上面）。
 *
 * @param {Array} entries
 * @returns {Array}
 */
export function listEntries(entries) {
  const byTime = (a, b) => (b.at || 0) - (a.at || 0);
  return [
    ...entries.filter((item) => item.pinned).sort(byTime),
    ...entries.filter((item) => !item.pinned).sort(byTime),
  ];
}

/**
 * 最近复制的那一条。
 *
 * **不看固定的**：固定的只是「不让它被淘汰」，不是「它最新」。
 * 「粘贴最近一条」要的是时间上最后复制的那条。
 *
 * @param {Array} entries
 * @returns {object|null}
 */
export function newestEntry(entries) {
  let best = null;
  for (const item of entries || []) {
    if (!best || (item.at || 0) > (best.at || 0)) best = item;
  }
  return best;
}

/**
 * 两份列表是不是一模一样。
 *
 * 加一条之前要问一句：「真的变了吗？」——
 * 复制的内容与上一条一样时，列表其实没变（只是挪到了最上面），
 * 那就不必重画界面、不必写盘。
 *
 * @param {Array} a
 * @param {Array} b
 * @returns {boolean}
 */
export function sameEntries(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.key !== y.key || x.at !== y.at || Boolean(x.pinned) !== Boolean(y.pinned)) {
      return false;
    }
  }
  return true;
}

/**
 * 固定 / 取消固定。
 *
 * @param {Array} entries
 * @param {string} id
 * @returns {Array}
 */
export function togglePin(entries, id) {
  return entries.map((item) => (item.id === id ? { ...item, pinned: !item.pinned } : item));
}

/**
 * 删掉一条。
 *
 * @param {Array} entries
 * @param {string} id
 * @returns {Array}
 */
export function removeEntry(entries, id) {
  return entries.filter((item) => item.id !== id);
}

/**
 * 清空历史（固定的也一起清掉：用户点了「清空」就是要清空）。
 *
 * @returns {Array}
 */
export function clearEntries() {
  return [];
}

/**
 * 把磁盘上读回来的东西收拾干净。
 *
 * 磁盘上的文件是用户（或上一次运行）留下的，可能缺字段、可能类型不对。
 * 认不出来的条目直接丢掉：宁可少几条，别让整个插件崩掉。
 *
 * @param {unknown} raw
 * @returns {Array}
 */
export function normalizeEntries(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  // **id 不能重**：重了就删一条连着删两条。
  const used = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    let id = typeof item.id === 'string' && item.id ? item.id : '';
    if (!id || used.has(id)) id = newId();
    used.add(id);
    const entry = makeEntry(item, { at: Number.isFinite(item.at) ? item.at : 0, id });
    entry.pinned = Boolean(item.pinned);
    if (!hasContent(entry)) continue;
    out.push(entry);
  }
  return out;
}
