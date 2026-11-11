/**
 * 模糊匹配：插件面板的搜索框用它。
 *
 * 这是**纯函数**，主进程与渲染层共用同一份实现——
 * 渲染层在本地搜索（每敲一个字不必过一次 IPC，那是这个交互手感的关键），
 * 主进程在单元测试里直接测它。
 *
 * 匹配分两档：
 * 1. **子串包含**：query 整段出现在 text 里（最常见的情形）；
 * 2. **子序列**：query 的字符按顺序出现在 text 里（中间可以隔着别的字）。
 *
 * 打分让「更贴切」的排前面：命中得越靠前、目标越短、越连续，分数越高。
 */

/** 这些字符之后算「词首」：命中词首比命中词中间更贴切。 */
const SEPARATORS = new Set([
  ' ',
  '\t',
  '-',
  '_',
  '.',
  '/',
  '\\',
  ':',
  '：',
  '·',
  ',',
  '，',
  '、',
  '（',
  '(',
]);

/** 命中一个字符的基准分。 */
const MATCH_SCORE = 16;
/** 连续命中的加分（挨着的命中比隔开的更贴切）。 */
const CONSECUTIVE_BONUS = 12;
/** 词首命中的加分。 */
const WORD_START_BONUS = 10;
/** 行首命中的加分。 */
const START_BONUS = 16;
/** 中间隔一个字符的扣分。 */
const GAP_PENALTY = 2;
/** 间隔扣分的上限：隔得太远也不该把分数扣成负数。 */
const MAX_GAP_PENALTY = 20;
/** 子串包含的基准分：必须高于任何子序列匹配的总分。 */
const SUBSTRING_BASE = 1000;

/**
 * 把 query 与 text 做一次模糊匹配。
 *
 * @param {string} query 用户输入
 * @param {string} text 被匹配的目标
 * @param {object} [options]
 * @param {boolean} [options.subsequence] 是否允许子序列匹配（默认允许）。
 *   匹配**路径**时要关掉：路径很长，子序列匹配几乎什么都算命中，
 *   「todo」能匹配到 `C:\Users\me\Documents\...`——那不是用户要找的东西。
 * @returns {{score: number, positions: number[]}|null} 不匹配时返回 null
 */
export function fuzzyMatch(query, text, { subsequence = true } = {}) {
  const q = String(query ?? '');
  const t = String(text ?? '');
  if (q === '') return { score: 0, positions: [] };
  if (t === '') return null;

  const qLower = q.toLowerCase();
  const tLower = t.toLowerCase();

  // —— 1. 子串包含 ——
  const idx = tLower.indexOf(qLower);
  if (idx >= 0) {
    const positions = [];
    for (let i = 0; i < qLower.length; i += 1) positions.push(idx + i);
    // 命中得越靠前、目标越短，分数越高。
    let score = SUBSTRING_BASE - idx * 4 - Math.max(0, t.length - q.length);
    if (idx === 0) score += START_BONUS;
    return { score, positions };
  }

  // —— 2. 子序列 ——
  if (!subsequence) return null;
  const positions = [];
  let score = 0;
  let cursor = 0;
  for (let qi = 0; qi < qLower.length; qi += 1) {
    const ch = qLower[qi];
    let found = -1;
    for (let k = cursor; k < tLower.length; k += 1) {
      if (tLower[k] === ch) {
        found = k;
        break;
      }
    }
    // 少一个字符都不算匹配：子序列必须是**完整**的 query。
    if (found < 0) return null;

    if (positions.length > 0) {
      const gap = found - positions[positions.length - 1] - 1;
      if (gap === 0) score += CONSECUTIVE_BONUS;
      else score -= Math.min(gap * GAP_PENALTY, MAX_GAP_PENALTY);
    }
    if (found === 0) score += START_BONUS;
    else if (SEPARATORS.has(t[found - 1])) score += WORD_START_BONUS;
    score += MATCH_SCORE;
    positions.push(found);
    cursor = found + 1;
  }
  // 目标越短越贴切：同样的命中，「待办」比「待办与提醒清单」更像用户要找的。
  score -= Math.max(0, t.length - q.length);
  return { score, positions };
}

/**
 * 把查询拆成词。
 *
 * 空白分开（中文没有空格，整句就是一个词）。
 * 多个词是**并且**的关系：打「记事本 calc」要两个都命中才算数——
 * 与 Win+S 的多词行为一致。
 */
export function tokenize(query) {
  return String(query ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 一组词在文本里的匹配：**所有词都要命中**。
 *
 * 分数取**最弱的那个词**：有一个词匹配得很勉强，整条结果就勉强。
 *
 * @param {string[]} tokens 词
 * @param {string[]} texts 候选文本（一个词可以落在不同的文本里）
 * @param {object} [options]
 * @param {boolean} [options.strict] 只要整段包含（不认顺序吻合的）
 * @returns {{score: number, positions: number[]}|null} 不匹配时返回 null
 */
function matchTokensIn(tokens, texts, { strict = false } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
  let worst = null;
  const positions = [];
  for (const token of tokens) {
    let best = null;
    for (const text of list) {
      if (!text) continue;
      const m = fuzzyMatch(token, text, { subsequence: !strict });
      if (!m) continue;
      if (!best || m.score > best.score) best = m;
    }
    if (!best) return null;
    if (!worst || best.score < worst.score) worst = best;
    positions.push(...best.positions);
  }
  if (!worst) return null;
  return { score: worst.score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

/**
 * 插件的搜索字段与它们的权重。
 *
 * 名称最重（用户多半直接打名字），关键词次之（英文/拼音），
 * 描述最轻（描述里常有「CPU」这类术语，能顺带命中）。
 */
const FIELDS = [
  { key: 'name', weight: 1 },
  { key: 'keywords', weight: 0.85, many: true },
  { key: 'description', weight: 0.7 },
];

/**
 * 在一批插件里做模糊搜索。
 *
 * @param {string} query 用户输入（空串表示「全部都显示」）
 * @param {Array<{id: string, name: string, description?: string, keywords?: string[]}>} plugins
 * @returns {Array<{plugin: object, score: number, field: string, positions: number[]}>}
 *   按分数降序排好；分数相同时保持插件的原始顺序（声明顺序）。
 */
export function searchPlugins(query, plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  const tokens = tokenize(query);
  // 空查询：全部返回，顺序就是声明顺序（第一个插件排在最上面）。
  if (!tokens.length) {
    return list.map((plugin) => ({ plugin, score: 0, field: '', positions: [] }));
  }

  const out = [];
  for (const plugin of list) {
    const best = bestFieldMatch(tokens, plugin);
    if (!best) continue;
    out.push({ plugin, score: best.score, field: best.field, positions: best.positions });
  }
  // 稳定排序：分数相同的不换位（Array.prototype.sort 在 V8 里是稳定的）。
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 在一个插件的所有字段里找分数最高的那次命中。 */
function bestFieldMatch(tokens, plugin) {
  let best = null;
  for (const field of FIELDS) {
    const value = plugin?.[field.key];
    if (field.many) {
      if (!Array.isArray(value)) continue;
      const m = matchTokensIn(tokens, value);
      if (!m) continue;
      const score = m.score * field.weight;
      if (!best || score > best.score) {
        best = { score, field: field.key, positions: m.positions };
      }
      continue;
    }
    if (typeof value !== 'string' || value === '') continue;
    const m = matchTokensIn(tokens, [value]);
    if (!m) continue;
    const score = m.score * field.weight;
    if (!best || score > best.score) {
      best = { score, field: field.key, positions: m.positions };
    }
  }
  return best;
}

/**
 * 在一批**系统条目**里做模糊搜索（程序、文件、设置页）。
 *
 * 条目只有**名字**与**路径/地址**，没有关键词与描述。
 * 命中名字的权重与插件的名字一样（1），两者放在同一个列表里排序时才公平；
 * 路径只作兜底，而且**只认整段包含**——路径很长，
 * 子序列匹配几乎什么都算命中，那不是用户要找的东西。
 *
 * **两轮**：先找「整段包含」的（名字或路径里连着几个字），
 * 一个都没有才退回去找「顺序吻合」的。
 * 顺序吻合很松：打「note」能匹配上「nvcontainer」「conda_auto_activate」——
 * 那种结果会把真正想找的记事本埋掉。有整段包含的结果时就不看它们了。
 *
 * @param {string} query 用户输入（空串表示「不搜」）
 * @param {Array<{id: string, name: string, target?: string}>} items
 * @returns {Array<{item: object, score: number, field: string, positions: number[]}>}
 */
export function searchItems(query, items) {
  const list = Array.isArray(items) ? items : [];
  const tokens = tokenize(query);
  // 空查询不列条目：打开面板时还是插件清单（几百个程序会把插件埋掉）。
  if (!tokens.length) return [];

  // 整段包含的结果（名字或路径里连着几个字）。
  const contains = [];
  // 顺序吻合的结果（只在没有整段包含时才用）。
  const fuzzy = [];

  for (const item of list) {
    const name = String(item?.name || '');
    const target = String(item?.target || '');
    const nameHit = matchTokensIn(tokens, [name], { strict: true });
    if (nameHit) {
      contains.push({ item, score: nameHit.score, field: 'name', positions: nameHit.positions });
      continue;
    }
    const targetHit = matchTokensIn(tokens, [target], { strict: true });
    if (targetHit) {
      // 路径命中要排在名字命中**后面**：打折就是干这个的。
      contains.push({ item, score: targetHit.score * 0.8, field: 'target', positions: [] });
      continue;
    }
    const looseHit = matchTokensIn(tokens, [name]);
    if (looseHit) fuzzy.push({ item, score: looseHit.score, field: 'name', positions: looseHit.positions });
  }

  const out = contains.length ? contains : fuzzy;
  // 稳定排序：分数相同的不换位。
  out.sort((a, b) => b.score - a.score);
  return out;
}
