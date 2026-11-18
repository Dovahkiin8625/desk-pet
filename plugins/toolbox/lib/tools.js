// plugins/toolbox/lib/tools.js
/**
 * 工具箱的纯逻辑。不碰 Node 与 Electron：
 * 页面（渲染进程）直接 import 来实时计算，单测也直接 import 验证。
 */

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** 从 JSON.parse 的报错里扒出「位置」，算出行号与列号。拿不到就给一行清理过的报错。 */
export function jsonErrorAt(text, error) {
  const raw = String(error?.message || error || '不是合法的 JSON');
  const named = raw.match(/line (\d+) column (\d+)/i);
  if (named) {
    return { message: raw, line: Number(named[1]), column: Number(named[2]) };
  }
  const positioned = raw.match(/position (\d+)/);
  if (positioned) {
    const position = Number(positioned[1]);
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < position && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        line += 1;
        lineStart = i + 1;
      }
    }
    return { message: raw, position, line, column: position - lineStart + 1 };
  }
  // 拿不到位置：V8 有时把整段原文嵌在报错里，去掉它，只留一句。
  const message = raw
    .replace(/,?\s*"[\s\S]*"\s+is not valid JSON$/, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return { message: message || raw, line: 0, column: 0 };
}

/** 顶层是什么、多少元素的一句话。 */
function jsonSummary(value) {
  if (Array.isArray(value)) return `合法的 JSON：数组，${value.length} 个元素`;
  if (value !== null && typeof value === 'object') {
    return `合法的 JSON：对象，${Object.keys(value).length} 个键`;
  }
  const TYPE_NAMES = { string: '字符串', number: '数字', boolean: '布尔', undefined: '空' };
  return `合法的 JSON：${value === null ? 'null' : TYPE_NAMES[typeof value] || typeof value}`;
}

/** JSON：格式化（indent 空格）。 */
export function formatJson(text, indent = 2) {
  const source = String(text ?? '');
  try {
    const value = JSON.parse(source);
    return { ok: true, output: JSON.stringify(value, null, indent), summary: jsonSummary(value) };
  } catch (error) {
    return { ok: false, error: jsonErrorAt(source, error) };
  }
}

/** JSON：压缩成一行。 */
export function minifyJson(text) {
  const source = String(text ?? '');
  try {
    const value = JSON.parse(source);
    return { ok: true, output: JSON.stringify(value), summary: jsonSummary(value) };
  } catch (error) {
    return { ok: false, error: jsonErrorAt(source, error) };
  }
}

/** JSON：只校验，不改原文。 */
export function validateJson(text) {
  const source = String(text ?? '');
  try {
    const value = JSON.parse(source);
    return { ok: true, summary: jsonSummary(value) };
  } catch (error) {
    return { ok: false, error: jsonErrorAt(source, error) };
  }
}

// ---------------------------------------------------------------------------
// Base64 / URL 编解码
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 安全的 Base64 编码。 */
export function base64Encode(text) {
  const bytes = encoder.encode(String(text ?? ''));
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** UTF-8 安全的 Base64 解码。不是合法 Base64 时抛错。 */
export function base64Decode(text) {
  const input = String(text ?? '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw new Error('不是有效的 Base64 字符串');
  }
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decoder.decode(bytes);
}

export function urlEncode(text) {
  return encodeURIComponent(String(text ?? ''));
}

/** URL 解码。% 序列不合法时抛错。 */
export function urlDecode(text) {
  return decodeURIComponent(String(text ?? ''));
}

// ---------------------------------------------------------------------------
// 时间戳
// ---------------------------------------------------------------------------

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间字符串：YYYY-MM-DD HH:mm:ss */
export function formatLocal(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** ISO 字符串转 "YYYY-MM-DDTHH:mm:ss.sssZ" 的精简读法：本地可读的 UTC 串。 */
export function formatUtc(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`
  );
}

/**
 * 时间戳 → 日期。
 *
 * unit: 'auto' | 's' | 'ms'。auto 按数量级判断：
 * |v| >= 1e12 当毫秒，否则当秒（1e12 是 2001 年对应的秒数，之前当秒也合理）。
 */
export function timestampToDate(value, unit = 'auto') {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: '先填一个时间戳' };
  const num = Number(raw);
  if (!Number.isFinite(num)) return { ok: false, error: '不是数字' };
  let resolve = unit;
  if (resolve === 'auto') resolve = Math.abs(num) >= 1e12 ? 'ms' : 's';
  const ms = resolve === 's' ? num * 1000 : num;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return { ok: false, error: '这个时间戳超出了范围' };
  return {
    ok: true,
    unit: resolve,
    ms,
    seconds: Math.floor(ms / 1000),
    local: formatLocal(ms),
    utc: formatUtc(ms),
    iso: date.toISOString(),
    weekday: WEEKDAYS[date.getDay()],
  };
}

/** 日期（datetime-local 的值）→ 时间戳。 */
export function dateToTimestamp(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: '先选一个日期时间' };
  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) return { ok: false, error: '这个日期时间认不出来' };
  return { ok: true, ms, seconds: Math.floor(ms / 1000) };
}

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/g;

/**
 * 粗略估算 token 数。
 *
 * 中文按 1.5 token/字、其余按 4 字符 1 token 估，
 * 不同模型的 tokenizer 会不一样，只当个量级参考。
 */
export function estimateTokens(text) {
  const source = String(text ?? '');
  const cjk = (source.match(CJK_PATTERN) || []).length;
  const other = source.length - cjk;
  const tokens = Math.round(cjk * 1.5 + other / 4);
  return {
    tokens,
    characters: source.length,
    bytes: encoder.encode(source).length,
    lines: source ? source.split('\n').length : 0,
    cjk,
    other,
  };
}

// ---------------------------------------------------------------------------
// 正则表达式
// ---------------------------------------------------------------------------

export const REGEX_FLAGS = ['g', 'i', 'm', 's', 'u'];

/**
 * 跑一遍正则，收集匹配。
 *
 * 匹配最多收 100 条（防止文本巨大时把界面撑爆），
 * 零宽匹配自动往后挪一格，避免死循环。
 */
export function testRegex({ pattern, flags = 'g', text = '', maxMatches = 100 }) {
  const source = String(pattern ?? '');
  if (!source) return { ok: false, error: '先写一个正则' };
  let regex;
  try {
    regex = new RegExp(source, flags);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
  const input = String(text ?? '');
  const matches = [];
  let truncated = false;
  regex.lastIndex = 0;
  for (;;) {
    const match = regex.exec(input);
    if (match === null) break;
    matches.push({
      index: match.index,
      match: match[0],
      groups: match.slice(1),
      namedGroups: match.groups ? { ...match.groups } : null,
    });
    // 没有 g 标志时 exec 每次都从 0 开始：只取第一处就够了，再跑下去是死循环。
    if (!regex.global) break;
    if (matches.length >= maxMatches) {
      // 再探一步，确认真的还有下一处，免得恰好收满时误报。
      if (match[0] === '') regex.lastIndex += 1;
      truncated = regex.exec(input) !== null;
      break;
    }
    if (match[0] === '') regex.lastIndex += 1;
  }
  return { ok: true, count: matches.length, truncated, matches };
}
