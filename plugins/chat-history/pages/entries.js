/**
 * 页面这边「现在有哪些记录」的小账本。
 *
 * ## 为什么单独一个文件
 *
 * 记录是**两路**来的：
 * - **首份快照**：界面打开时给一份完整的；
 * - **增量**：一条记录进来推一条。
 *
 * 两路会撞车：快照算出来的那一刻，可能已经有一条新的推到了页面上。
 * 这时候快照只能**合**进来，不能**换**——换掉就把那条新的弄丢了。
 *
 * 这套记账规矩是纯逻辑，不碰 DOM——所以它能在普通 node 里被测。
 */

/**
 * 造一个账本。
 *
 * @returns {{apply: (payload: object) => void, reset: () => void, list: () => Array}}
 */
export function createEntryStore() {
  /** 全部记录（按时间先后）。 */
  let entries = [];
  /** 已经收过的条目 id：同一条不显示两遍。 */
  const seen = new Set();

  /** 把一份记录并进来（重复的跳过）。 */
  function merge(payload) {
    const list = Array.isArray(payload?.entries) ? payload.entries : [];
    for (const entry of list) {
      const id = String(entry?.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push(entry);
    }
  }

  return {
    /**
     * 应用一份数据。
     *
     * `replace: true` = 这是一份**整份**清单（清空之后推过来的）：先清再合。
     * 不带这个标记 = **增量**（写一条记录推一条）：直接合。
     */
    apply(payload) {
      if (payload?.replace) {
        entries = [];
        seen.clear();
      }
      merge(payload);
    },

    /** 清空重来（用户点了「清空」）。 */
    reset() {
      entries = [];
      seen.clear();
    },

    /** 现在有哪些记录。 */
    list() {
      return entries;
    },
  };
}
