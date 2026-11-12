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

/** 只剩标点（还有空白）——跟没说话一样。 */
const PUNCT_ONLY = /^[\s，。、！？；：,.!?;:~…—\-_「」『』《》（）()【】"'‘’]*$/;

/** 清理的迭代上限：每轮要么删字要么换词，长度不增，所以轮数有界。 */
const MAX_PASSES = 64;

/**
 * 清掉一段话里的内部话术与工具名。
 *
 * @param {string} text 原文
 * @param {string[]} toolNames 要一并藏起来的工具名（精确匹配）
 * @returns {string} 清干净的话；空的话返回兜底句
 */
export function sanitizeSpeech(text, { toolNames = [] } = {}) {
  return clean(String(text ?? ''), buildRules(toolNames)) || SPEECH_FALLBACK;
}

/**
 * 流式版过滤器：模型逐字吐字，一个禁词可能被切成两半（「后台任」+「务」），
 * 所以 `push` 要**按住尾巴**——缓冲区末尾像禁词开头的那一段先不吐。
 *
 * 两条按住规则：
 * 1. 原文尾巴：末尾是某个禁词的真前缀（词还没凑齐），或者有没配上的开括号。
 * 2. 清完之后：清出来的尾巴若是某个禁词的真前缀（将来可能被补成禁词），也不吐。
 *
 * @param {object} options
 * @param {string[]} options.toolNames 要一并藏起来的工具名（精确匹配）
 * @returns {{push: (delta: string) => string, finish: () => string, text: string}} `text` 是已经吐给上层的文本
 */
export function createSpeechFilter({ toolNames = [] } = {}) {
  const names = normalizeNames(toolNames);
  const rules = buildRules(names);
  const words = [...REPLACEMENTS.map(([from]) => from), ...names];
  let raw = '';
  let emitted = '';
  let done = false;

  return {
    push(delta) {
      if (done) return '';
      raw += String(delta ?? '');
      const stable = raw.slice(0, raw.length - tailHold(raw, words));
      const safe = clean(stable, rules);
      let keep = safe.length - prefixHold(safe, words);
      // 切掉尾巴后可能剩个空格在末尾——将来收拾时会去掉，先别吐。
      while (keep > 0 && /\s/.test(safe[keep - 1])) keep -= 1;
      const candidate = safe.slice(0, keep);
      if (!candidate.startsWith(emitted)) return '';
      const out = candidate.slice(emitted.length);
      emitted = candidate;
      return out;
    },
    finish() {
      if (done) return '';
      done = true;
      const final = clean(raw, rules);
      if (!final) {
        if (emitted) return '';
        emitted = SPEECH_FALLBACK;
        return SPEECH_FALLBACK;
      }
      if (final.startsWith(emitted)) {
        const out = final.slice(emitted.length);
        emitted = final;
        return out;
      }
      // 收尾时与已吐出的对不上（清理向左传播到了已吐出的部分）：
      // 拼起来若会带出禁词，就不吐。
      const p = commonPrefix(emitted, final);
      const merged = emitted + final.slice(p);
      if (hasForbidden(merged, rules)) return '';
      const out = final.slice(p);
      emitted = merged;
      return out;
    },
    /** 已经吐给上层的文本。 */
    get text() {
      return emitted;
    },
  };
}

/** 工具名 → 话术 → 收拾。 */
function buildRules(toolNames) {
  const names = [...new Set(normalizeNames(toolNames))].sort((a, b) => b.length - a.length);
  return [
    ...names.map((name) => ({ re: matcherFor(name), to: '这件事' })),
    ...REPLACEMENTS.map(([from, to]) => ({ re: matcherFor(from), to })),
  ];
}

function normalizeNames(toolNames) {
  return (Array.isArray(toolNames) ? toolNames : []).filter(Boolean);
}

/**
 * 一个禁词的匹配器：中文词允许字与字之间夹空格（模型偶尔会把词拆开写），
 * 词两边的空格也一并算进来——换成中文词时那两侧的空格不该留着。
 */
function matcherFor(word) {
  const ascii = /^[\x20-\x7e]+$/.test(word);
  const body = ascii ? escapeRe(word) : [...word].map(escapeRe).join('[ \\t]*');
  return new RegExp(`([ \\t]*)${body}([ \\t]*)`, 'g');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyRules(text, rules) {
  let out = text;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    // 换成中文词时把两侧的空格一并吃掉；删空时留着，不把两句话粘起来。
    out = out.replace(rule.re, rule.to ? rule.to : '$1$2');
  }
  return out;
}

function hasForbidden(text, rules) {
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) return true;
  }
  return false;
}

/**
 * 清干净一段话：反复「收拾 → 替词」，直到不再变化。
 *
 * 替词是最后一步，所以删空的括号造出的新禁词也会被扫掉。
 * 每轮长度不增（删字或换成不含禁词的词），所以轮数有界。
 */
function clean(text, rules) {
  let out = String(text ?? '');
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = out;
    out = out.replace(/\s+/g, ' ');
    out = stripEmptyParens(out);
    out = stripUnmatchedClose(out);
    out = applyRules(out, rules);
    if (out === before) break;
  }
  out = out.trim();
  // **句末的句号留着**：那是句子的标点，不是替换留下的渣。
  out = out.replace(/^[\s，,。.、]+/, '').replace(/[\s，,、.]+$/, '');
  if (PUNCT_ONLY.test(out)) return '';
  // 兜底：清不干净就不说话——宁可少说一句，也不让禁词漏出去。
  return hasForbidden(out, rules) ? '' : out;
}

/** 删空了的括号对（「（）」「()」）整个去掉。 */
function stripEmptyParens(text) {
  return text.replace(/[（(][ \t]*[）)]/g, '');
}

/** 去掉没有配对左括号的右括号——落单的括号说出来像口误。 */
function stripUnmatchedClose(text) {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '（' || ch === '(') {
      depth += 1;
      out += ch;
    } else if (ch === '）' || ch === ')') {
      if (depth > 0) {
        depth -= 1;
        out += ch;
      }
    } else out += ch;
  }
  return out;
}

/**
 * 末尾有多长的一段不能吐——先按住，等下一段来了看清了再吐。
 *
 * 按住之后截短出来的前缀自己可能还有隐患（尾巴是禁词的真前缀、括号没配上），
 * 所以要一直按到前缀「干净」为止。
 */
function tailHold(raw, words) {
  let hold = 0;
  while (hold < raw.length) {
    const stable = raw.slice(0, raw.length - hold);
    const open = firstUnmatchedOpen(stable);
    if (open >= 0) {
      hold += stable.length - open;
      continue;
    }
    const close = firstUnmatchedClose(stable);
    if (close >= 0) {
      // 落单的右括号会被删掉，删掉之后它左边那个字会跟将来拼起来。
      hold += stable.length - close + 1;
      continue;
    }
    const pre = prefixHold(stable, words);
    if (!pre) break;
    // 紧挨着禁词前缀的那一个字也得按住：禁词删掉之后会跟它拼起来。
    hold += pre + 1;
  }
  return Math.min(hold, raw.length);
}

/**
 * 末尾有多长的一段是某个禁词的真前缀——那段的将来可能被补成禁词，先按住。
 */
function prefixHold(text, words) {
  let hold = 0;
  for (const word of words) {
    const max = Math.min(word.length - 1, text.length);
    for (let k = max; k > hold; k -= 1) {
      if (endsWithWord(text, word.slice(0, k))) {
        hold = k;
        break;
      }
    }
  }
  return hold;
}

/** `text` 的末尾是不是 `word`（字与字之间可以夹空格）。 */
function endsWithWord(text, word) {
  const chars = [...word];
  let pos = text.length;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    while (pos > 0 && /[ \t]/.test(text[pos - 1])) pos -= 1;
    if (pos === 0 || text[pos - 1] !== chars[i]) return false;
    pos -= 1;
  }
  return true;
}

/** 第一个没配上右括号的开括号的位置；都配上了就是 -1。 */
function firstUnmatchedOpen(text) {
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '（' || ch === '(') stack.push(i);
    else if (ch === '）' || ch === ')') {
      if (stack.length) stack.pop();
    }
  }
  return stack.length ? stack[0] : -1;
}

/** 第一个没配上左括号的右括号的位置；都配上了就是 -1。 */
function firstUnmatchedClose(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '（' || ch === '(') depth += 1;
    else if ((ch === '）' || ch === ')') && depth === 0) return i;
  }
  return -1;
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}
