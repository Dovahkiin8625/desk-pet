import { APPROVAL_DECISION } from '../shared/assistant.js';

/**
 * 审批气泡的「等答复」这件事。
 *
 * 为什么要单独一个文件：气泡控制器（src/main/bubble.js）引了 electron，
 * 在普通 node 里测不了。而「答复按 id 认」「谁先答谁算数」
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
 * 挂着的请求被顶掉了（应用退出），用户**压根没点过按钮**——
 * 那不能记成「用户拒绝」，所以作废时给的是 `supersede`（没等到确认）。
 *
 * ## 可以挂着好几个
 *
 * 挂着的是一条**队列**（先进先出）：后来的排在后面，
 * 不打断已经显示出来的那一张。谁先答谁算数——后答的那个
 * 拿到「这个已经答复过了」，状态一点不动。
 */

/** 合法的决议（用户能点出来的那些）。 */
const DECISIONS = new Set([
  APPROVAL_DECISION.ALLOW,
  APPROVAL_DECISION.DENY,
  APPROVAL_DECISION.ALWAYS,
  APPROVAL_DECISION.CANCEL,
]);

export function createApprovalInbox() {
  /** id → { resolve, request }。Map 保持插入顺序：那就是排队顺序。 */
  const waiting = new Map();
  /** 答复过的 id：用来分辨「已经答复过了」与「压根没有这个审批」。 */
  const answered = new Set();

  return {
    /**
     * 挂一个审批请求，等用户的答复。
     *
     * @param {object} request { id, taskId, title, text, risk }
     * @returns {Promise<'allow'|'deny'|'always'|'cancel'>}
     */
    request(request) {
      const id = String(request?.id || '');
      if (!id) return Promise.resolve(APPROVAL_DECISION.DENY);
      return new Promise((resolve) => {
        waiting.set(id, { resolve, request: request || {} });
      });
    },

    /**
     * 用户答复了。
     *
     * **谁先答谁算数**：对不上的（已经答复过、压根没有这个 id）
     * 都不改任何状态。
     *
     * @returns {{ok: boolean, message: string}}
     */
    respond({ id, decision } = {}) {
      const key = String(id || '');
      const item = waiting.get(key);
      if (!item) {
        return answered.has(key)
          ? { ok: false, message: '这个已经答复过了' }
          : { ok: false, message: '没有这个审批' };
      }
      waiting.delete(key);
      answered.add(key);
      const d = String(decision || '');
      item.resolve(DECISIONS.has(d) ? d : APPROVAL_DECISION.DENY);
      return { ok: true, message: '已答复' };
    },

    /**
     * 还挂着哪些审批：排队顺序（先进先出）。
     *
     * @returns {Array<{id: string, taskId: string, title: string, text: string, risk: string}>}
     */
    list() {
      return [...waiting.values()].map((item) => ({
        id: String(item.request?.id || ''),
        taskId: String(item.request?.taskId || ''),
        title: String(item.request?.title || ''),
        text: String(item.request?.text || ''),
        risk: String(item.request?.risk || ''),
      }));
    },

    /** 还有几个在等。 */
    pending() {
      return waiting.size;
    },

    /** 全都作废（应用退出）：挂着的请求要有交代。 */
    clear() {
      for (const item of waiting.values()) item.resolve(APPROVAL_DECISION.SUPERSEDE);
      waiting.clear();
    },
  };
}
