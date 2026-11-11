/**
 * 桌宠说话前的过滤：把内部话术与工具名清掉。
 *
 * 提示词是第一道防线，这里是第二道：模型偶尔还是会漏一个词出来，
 * 用户看见「后台任务」四个字，整套「只有桌宠的存在」的设定就破了。
 */

/** 内部话术的替换表：长的先替，免得被短的截胡（「派了个」是例外，见下）。 */
const REPLACEMENTS = [
  ['后台任务', '这件事'],
  ['后台的事', '这件事'],
  ['派出任务', '这件事'],
  ['后台', ''],
  ['派单', '安排'],
  ['派发', '安排'],
  ['派出去', '去做'],
  ['任务', '事情'],
  // 放在「任务」之后：「我派了个任务」→「我去做这件事」
  ['派了个', '去做了'],
  ['工具', ''],
  ['插件', ''],
  ['MCP', ''],
  ['<<META>>', ''],
];

/** 删空了之后说的那句。 */
export const SPEECH_FALLBACK = '这个我记下了。';

/** 中文与日文字：它们之间的空格是多余的（替换留下的）。 */
const CJK = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff';
const CJK_GAP = new RegExp(`([${CJK}])[ \\t]+([${CJK}])`, 'g');

/** 只剩标点（还有空白）——跟没说话一样。 */
const PUNCT_ONLY = /^[\s，。、！？；：,.!?;:~…—\-_「」『』《》（）()【】"'‘’]*$/;

/**
 * 清掉一段话里的内部话术与工具名。
 *
 * @param {string} text 原文
 * @param {string[]} toolNames 要一并藏起来的工具名（精确匹配）
 * @returns {string} 清干净的话；空的话返回兜底句
 */
export function sanitizeSpeech(text, { toolNames = [] } = {}) {
  return clean(text, toolNames) || SPEECH_FALLBACK;
}

/**
 * 流式版过滤器：模型逐字吐字，一个禁词可能被切成两半（「后台任」+「务」），
 * 所以 `push` 要**按住尾巴**——缓冲区末尾像禁词开头的那一段先不吐。
 *
 * @param {object} options
 * @param {string[]} options.toolNames 要一并藏起来的工具名（精确匹配）
 * @returns {{push: (delta: string) => string, finish: () => string, text: string}} `text` 是已经吐出去的那部分
 */
export function createSpeechFilter({ toolNames = [] } = {}) {
  const names = (Array.isArray(toolNames) ? toolNames : []).filter(Boolean);
  const words = [...REPLACEMENTS.map(([from]) => from), ...names];
  let raw = '';
  let emitted = '';

  return {
    push(delta) {
      raw += String(delta ?? '');
      const stable = raw.slice(0, raw.length - tailHold(raw, words));
      const safe = clean(stable, names);
      const out = suffixAfter(emitted, safe);
      emitted = safe;
      return out;
    },
    finish() {
      const safe = clean(raw, names);
      if (!safe) {
        emitted = SPEECH_FALLBACK;
        return SPEECH_FALLBACK;
      }
      const out = suffixAfter(emitted, safe);
      emitted = safe;
      return out;
    },
    get text() {
      return emitted;
    },
  };
}

/**
 * 缓冲区末尾有多长的一段是某个禁词的前缀——这一段先按住不吐。
 *
 * 禁词已经完整地出现在末尾时不按住（可以马上替换掉），
 * 但它同时是更长禁词的前缀时要按住（「后台」可能是「后台任务」的一半）。
 */
function tailHold(raw, words) {
  let hold = 0;
  for (const word of words) {
    const max = Math.min(word.length - 1, raw.length);
    for (let k = max; k > hold; k -= 1) {
      if (raw.endsWith(word.slice(0, k))) {
        hold = k;
        break;
      }
    }
  }
  return hold;
}

/** 已经吐出去的 `base` 与新算出的 `next` 之间的增量。 */
function suffixAfter(base, next) {
  if (next.startsWith(base)) return next.slice(base.length);
  let i = 0;
  while (i < base.length && i < next.length && base[i] === next[i]) i += 1;
  return next.slice(i);
}

/** 工具名 → 话术 → 收拾。 */
function clean(text, toolNames) {
  const names = (Array.isArray(toolNames) ? toolNames : []).filter(Boolean);
  let out = String(text ?? '');
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.split(name).join('这件事');
  }
  for (const [from, to] of REPLACEMENTS) {
    out = out.split(from).join(to);
  }
  out = out.replace(/[（(][ \t]*[）)]/g, '');
  out = out.replace(/\s+/g, ' ');
  let prev;
  do {
    prev = out;
    out = out.replace(CJK_GAP, '$1$2');
  } while (out !== prev);
  out = out.trim();
  out = out.replace(/^[\s，,。.、]+/, '').replace(/[\s，,。.、]+$/, '');
  return PUNCT_ONLY.test(out) ? '' : out;
}
