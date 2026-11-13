import { APPROVAL_DECISION, MESSAGE_KIND } from '../shared/assistant.js';

/**
 * 气泡上「等人回话」的那些卡片。
 *
 * 为什么单独一个文件：气泡控制器（src/main/bubble.js）引了 electron，
 * 在普通 node 里测不了。而「答复按 id 认」「谁先答谁算数」
 * 这两件事最容易做错，必须能单测，所以抽出来。
 *
 * ## 两种卡片
 *
 * - **审批**（`approval`）：问「这么干行不行」。用户能给的决议有四种：
 *   allow（本次放行）/ deny（本次不给）/ always（本任务内同风险都放行）/
 *   cancel（取消整个任务）。
 *   **不认识的一律当 deny**——宁可多问一次，也不要因为一个坏值就放行。
 * - **选择**（`choice`）：问「你要哪个」。用户回的就是**选项本身**，
 *   不是那几个决议里的一个；不在选项里的答复不算数。
 *
 * ## 但「作废」不是「拒绝」
 *
 * 挂着的请求被顶掉了（应用退出）、或者任务在等的时候被取消了——
 * 用户**压根没点过按钮**。那不能记成「用户拒绝」，
 * 所以作废时给的是 `supersede`（没等到确认）。
 *
 * ## 可以挂着好几个
 *
 * 挂着的是一条**队列**（先进先出）：后来的排在后面，
 * 不打断已经显示出来的那一张。谁先答谁算数——后答的那个
 * 拿到「这个已经答复过了」，状态一点不动。
 */

/** 合法的审批决议（用户能点出来的那些）。 */
const DECISIONS = new Set([
  APPROVAL_DECISION.ALLOW,
  APPROVAL_DECISION.DENY,
  APPROVAL_DECISION.ALWAYS,
  APPROVAL_DECISION.CANCEL,
]);

/** 一张选择卡最多几个选项：气泡就那么大，选项多了挤成一片。 */
export const MAX_ASK_OPTIONS = 6;

export function createAskInbox() {
  /** id → { resolve, request }。Map 保持插入顺序：那就是排队顺序。 */
  const waiting = new Map();
  /** 答复过的 id：用来分辨「已经答复过了」与「压根没有这个卡片」。 */
  const answered = new Set();

  /** 把一份请求规整成卡片的形状。 */
  function normalize(request) {
    const kind =
      String(request?.kind || '') === MESSAGE_KIND.CHOICE
        ? MESSAGE_KIND.CHOICE
        : MESSAGE_KIND.APPROVAL;
    const options =
      kind === MESSAGE_KIND.CHOICE
        ? (Array.isArray(request?.options) ? request.options : [])
            .map((o) => String(o ?? '').trim())
            .filter(Boolean)
            .slice(0, MAX_ASK_OPTIONS)
        : [];
    return {
      id: String(request?.id || ''),
      kind,
      taskId: String(request?.taskId || ''),
      title: String(request?.title || ''),
      text: String(request?.text || ''),
      risk: String(request?.risk || ''),
      question: String(request?.question || ''),
      options,
    };
  }

  return {
    /**
     * 挂一个请求，等用户的答复。
     *
     * @param {object} request { id, kind, taskId, title, text, risk, question, options }
     * @returns {Promise<string>} 审批给决议；选择给用户选中的那个选项
     */
    request(request) {
      const item = normalize(request);
      if (!item.id) return Promise.resolve(APPROVAL_DECISION.DENY);
      // 没有选项的选择卡没法选：直接当成没人回答。
      if (item.kind === MESSAGE_KIND.CHOICE && !item.options.length) return Promise.resolve('');
      return new Promise((resolve) => {
        waiting.set(item.id, { resolve, request: item });
      });
    },

    /**
     * 用户答复了。
     *
     * **谁先答谁算数**：对不上的（已经答复过、压根没有这个 id）
     * 都不改任何状态。
     *
     * @param {object} payload { id, answer }
     * @returns {{ok: boolean, message: string}}
     */
    respond({ id, answer } = {}) {
      const key = String(id || '');
      const item = waiting.get(key);
      if (!item) {
        return answered.has(key)
          ? { ok: false, message: '这个已经答复过了' }
          : { ok: false, message: '没有这个待答的卡片' };
      }
      waiting.delete(key);
      answered.add(key);
      const request = item.request;
      if (request.kind === MESSAGE_KIND.CHOICE) {
        const value = String(answer ?? '');
        // 不在选项里的答复**不算数**：那是坏值，不是用户选了什么。
        if (!request.options.includes(value)) {
          item.resolve('');
          return { ok: false, message: '没有这个选项' };
        }
        item.resolve(value);
        return { ok: true, message: '已选' };
      }
      const d = String(answer || '');
      item.resolve(DECISIONS.has(d) ? d : APPROVAL_DECISION.DENY);
      return { ok: true, message: '已答复' };
    },

    /**
     * 还挂着哪些卡片：排队顺序（先进先出）。
     *
     * @param {string} [kind] 只看某一种（`approval` / `choice`）；不给就是全部
     * @returns {Array<object>}
     */
    list(kind = '') {
      const want = String(kind || '');
      return [...waiting.values()]
        .map((item) => item.request)
        .filter((request) => !want || request.kind === want);
    },

    /** 还有几个在等。 */
    pending(kind = '') {
      const want = String(kind || '');
      if (!want) return waiting.size;
      let n = 0;
      for (const item of waiting.values()) if (item.request.kind === want) n += 1;
      return n;
    },

    /** 全都作废（应用退出）：挂着的请求要有交代。 */
    clear() {
      for (const item of waiting.values()) {
        item.resolve(
          item.request.kind === MESSAGE_KIND.CHOICE ? '' : APPROVAL_DECISION.SUPERSEDE
        );
      }
      waiting.clear();
    },
  };
}
