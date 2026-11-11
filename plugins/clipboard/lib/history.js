// plugins/clipboard/lib/history.js
/**
 * 剪贴板历史的**纯逻辑**。
 *
 * 不碰 Electron、不碰磁盘：条目怎么加、怎么排、怎么淘汰都在这儿，
 * 于是能直接用 node --test 验。
 */

/** 默认最多留多少条（**不含**固定的那些）。 */
export const DEFAULT_MAX_ENTRIES = 200;

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

/**
 * 加一条。
 *
 * 同样的内容再复制一次：**挪到最上面**，不新增一条——
 * 列表里全是重复项等于没有列表。
 *
 * @param {Array} entries 现有的条目
 * @param {string} text 复制来的内容
 * @param {object} [opts]
 * @param {number} [opts.at] 什么时候复制的（毫秒时间戳）
 * @param {string} [opts.id] 新条目的 id（不给就自己造一个）
 * @param {number} [opts.max] 最多留多少条（不含固定的）
 * @returns {Array} 新的条目列表
 */
export function addEntry(entries, text, { at = Date.now(), id = '', max = DEFAULT_MAX_ENTRIES } = {}) {
  const content = String(text ?? '');
  // 空白不算一条：剪贴板被清空时内容是空串。
  if (!content.trim()) return entries;

  const same = entries.find((item) => item.text === content);
  const rest = same ? entries.filter((item) => item.id !== same.id) : entries;
  const item = {
    // 重复的那条**沿用原来的 id**：它还是同一条内容，只是又复制了一遍。
    id: same ? same.id : id || newId(),
    text: content,
    at,
    pinned: same ? same.pinned : false,
  };
  return trimEntries([item, ...rest], max);
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
    if (x.id !== y.id || x.text !== y.text || x.at !== y.at || Boolean(x.pinned) !== Boolean(y.pinned)) {
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
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text.trim()) continue;
    let id = typeof item.id === 'string' && item.id ? item.id : '';
    if (!id || used.has(id)) id = newId();
    used.add(id);
    const at = Number.isFinite(item.at) ? item.at : 0;
    out.push({ id, text, at, pinned: Boolean(item.pinned) });
  }
  return out;
}
