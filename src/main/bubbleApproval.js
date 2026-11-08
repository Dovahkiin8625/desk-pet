import { APPROVAL_DECISION } from '../shared/assistant.js';

/**
 * 审批气泡的「等答复」这件事。
 *
 * 为什么要单独一个文件：气泡控制器（src/main/bubble.js）引了 electron，
 * 在普通 node 里测不了。而「答复按 id 认」「没人管时要有个交代」
 * 这两件事最容易做错，必须能单测，所以抽出来。
 *
 * ## 用户能给的决议有四种
 *
 * allow（本次放行）/ deny（本次不给）/ always（本任务内同风险都放行）/
 * cancel（取消整个任务）。
 * **不认识的一律当 deny**——宁可多问一次，也不要因为一个坏值就放行。
 *
 * ## 但「作废」不是「拒绝」
 *
 * 挂着的请求被顶掉了（来了新的审批、或者气泡被别的东西占了），
 * 用户**压根没点过按钮**——那不能记成「用户拒绝」，
 * 所以作废时给的是 `supersede`（没等到确认）。
 */

/** 合法的决议（用户能点出来的那些）。 */
const DECISIONS = new Set([
  APPROVAL_DECISION.ALLOW,
  APPROVAL_DECISION.DENY,
  APPROVAL_DECISION.ALWAYS,
  APPROVAL_DECISION.CANCEL,
]);

export function createApprovalInbox() {
  /** id → { resolve, request }。 */
  const waiting = new Map();

  return {
    /**
     * 挂一个审批请求，等用户的答复。
     *
     * @param {object} request { id, title, text, risk }
     * @returns {Promise<'allow'|'deny'|'always'|'cancel'>}
     */
    request(request) {
      const id = String(request?.id || '');
      if (!id) return Promise.resolve(APPROVAL_DECISION.DENY);
      return new Promise((resolve) => {
        waiting.set(id, { resolve, request });
      });
    },

    /**
     * 用户答复了。
     *
     * @returns {boolean} 有没有对上号（对不上就别乱改状态）
     */
    respond({ id, decision } = {}) {
      const key = String(id || '');
      const item = waiting.get(key);
      if (!item) return false;
      waiting.delete(key);
      const d = String(decision || '');
      item.resolve(DECISIONS.has(d) ? d : APPROVAL_DECISION.DENY);
      return true;
    },

    /** 还有几个在等。 */
    pending() {
      return waiting.size;
    },

    /** 全都作废（应用退出、气泡被关掉）：挂着的请求要有交代。 */
    clear() {
      for (const item of waiting.values()) item.resolve(APPROVAL_DECISION.SUPERSEDE);
      waiting.clear();
    },
  };
}
