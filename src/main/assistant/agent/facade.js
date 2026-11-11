/**
 * agent 的对外接口。
 *
 * 插件通过 `ctx.agent` 用它（规格 §5.5）：提交一个后台任务、取消一个任务、
 * 读聊天记录、订阅 agent 事件。
 *
 * 插件跑在主进程里，与 agent 运行时同处一个进程，所以这是**直接调用**，
 * 不需要 IPC。
 *
 * ## 为什么单独一个文件
 *
 * `src/main/assistant/index.js` 引了 electron 的 `powerMonitor`，
 * 在普通 node 里测不了。而这个接口是插件与 agent 之间**唯一的约定**，
 * 必须能测——所以它不引 electron，单独成文件。
 *
 * ## 运行时的接缝
 *
 * 这个文件**不知道**后台任务怎么跑——它只认一个 `runtime` 对象：
 * `run(prompt, opts)` / `cancel(taskId)` / `history()` /
 * `list()` / `steer(taskId, note)` / `archive(taskId)`。
 * L3 之前没有运行时，`run()` / `cancel()` 会**明确说「还没上线」**，
 * 不假装成功——给插件一个假成功，它会以为任务在跑，而它根本没进队列。
 * L3 之后（src/main/assistant/index.js）把真的运行时接了进来。
 *
 * ## 审批的接缝
 *
 * 待答的审批**不住在运行时里**——它住在气泡那边（src/main/bubble.js），
 * 因为审批是要**给人看**的。所以这里认第二个接缝 `approvals`：
 * `list()` / `answer(id, decision)`。
 * 没接上时一样降级：列表是空的，答复明确说「还没上线」。
 */

/** 运行时还没上线时，run/cancel 给出的回话。 */
const NOT_READY = '后台任务运行时还没上线';

/**
 * 造一个 agent 接口。
 *
 * @param {object} options
 * @param {object} [options.tools] agent 的工具表（插件提供的工具也挂在这里）
 * @param {object} [options.runtime] 后台任务运行时（L3 才有）
 * @param {object} [options.approvals] 待答审批的队列（气泡那边）
 * @param {Function} [options.getHistory] 读聊天记录
 */
export function createAgentFacade({
  tools = null,
  runtime = null,
  approvals = null,
  getHistory = null,
} = {}) {
  /** 订阅 agent 事件的回调。 */
  const listeners = new Set();

  return {
    /** agent 的工具表。 */
    tools,

    /**
     * 提交一个后台任务。
     *
     * @returns {Promise<{ok: boolean, taskId?: string, message?: string}>}
     */
    async run(prompt, opts) {
      if (typeof runtime?.run === 'function') return runtime.run(prompt, opts);
      return { ok: false, message: NOT_READY };
    },

    /**
     * 取消一个后台任务。
     *
     * @returns {Promise<{ok: boolean, message?: string}>}
     */
    async cancel(taskId) {
      if (typeof runtime?.cancel === 'function') return runtime.cancel(taskId);
      return { ok: false, message: NOT_READY };
    },

    /**
     * 现在有哪些后台任务（不含归档）。
     *
     * 走的是**看板视图**：带步骤时间线与完整结果——
     * 插件的界面要给人看整个过程，不是给模型看的简报。
     *
     * @returns {Promise<Array<object>>}
     */
    async tasks() {
      if (typeof runtime?.board === 'function') return runtime.board() || [];
      if (typeof runtime?.list === 'function') return runtime.list() || [];
      return [];
    },

    /**
     * 给正在跑的任务追加一句要求。
     *
     * @returns {Promise<{ok: boolean, message?: string, dropped?: boolean}>}
     */
    async steer(taskId, note) {
      if (typeof runtime?.steer === 'function') return runtime.steer(taskId, note);
      return { ok: false, message: NOT_READY };
    },

    /**
     * 归档一个已经结束的任务。
     *
     * @returns {Promise<{ok: boolean, message?: string}>}
     */
    async archive(taskId) {
      if (typeof runtime?.archive === 'function') return runtime.archive(taskId);
      return { ok: false, message: NOT_READY };
    },

    /**
     * 现在等着用户点头的审批。
     *
     * @returns {Promise<Array<{id: string, taskId: string, title: string, text: string, risk: string}>>}
     */
    async approvals() {
      if (typeof approvals?.list === 'function') return approvals.list() || [];
      return [];
    },

    /**
     * 答复一个审批（allow / deny / always / cancel）。
     *
     * **谁先答谁算数**：后答的那个拿到「这个已经答复过了」。
     *
     * @returns {Promise<{ok: boolean, message?: string}>}
     */
    async answerApproval(id, decision) {
      if (typeof approvals?.answer === 'function') return approvals.answer(id, decision);
      return { ok: false, message: NOT_READY };
    },

    /** 聊天记录（给插件读）。 */
    history() {
      if (typeof runtime?.history === 'function') return runtime.history() || [];
      if (typeof getHistory === 'function') return getHistory() || [];
      return [];
    },

    /**
     * 订阅 agent 的动静。返回取消订阅的函数。
     *
     * **收到的是聊天记录条目**（带 kind / text / meta）：
     * 写一条记录就推一条，插件页面照着画就行。
     *
     * 订阅者抛异常不许带崩别人——一个插件的坏回调不该让
     * 另一个插件收不到事件。
     */
    onEvent(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /**
     * 把一条**聊天记录条目**推给订阅者。
     *
     * 运行时（L3）每写一条记录就调它——插件的聊天记录界面
     * 靠它实时更新（规格 §10.2）。
     *
     * **推的是条目，不是运行时事件**：条目里有 kind、text、meta，
     * 页面拿到就能画；原始事件（task / step / approval）
     * 在写成条目之前是中间产物。
     */
    emit(entry) {
      for (const cb of [...listeners]) {
        try {
          cb(entry);
        } catch (err) {
          console.warn('[desk-pet] agent 事件的订阅者出错：', err?.message);
        }
      }
    },
  };
}
