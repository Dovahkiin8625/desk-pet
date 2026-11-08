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
 * `run(prompt, opts)` / `cancel(taskId)` / `history()`。
 * L3 之前没有运行时，`run()` / `cancel()` 会**明确说「还没上线」**，
 * 不假装成功——给插件一个假成功，它会以为任务在跑，而它根本没进队列。
 * L3 之后（src/main/assistant/index.js）把真的运行时接了进来。
 */

/** 运行时还没上线时，run/cancel 给出的回话。 */
const NOT_READY = '后台任务运行时还没上线';

/**
 * 造一个 agent 接口。
 *
 * @param {object} options
 * @param {object} [options.tools] agent 的工具表（插件提供的工具也挂在这里）
 * @param {object} [options.runtime] 后台任务运行时（L3 才有）
 * @param {Function} [options.getHistory] 读聊天记录
 */
export function createAgentFacade({ tools = null, runtime = null, getHistory = null } = {}) {
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

    /** 聊天记录（给插件读）。 */
    history() {
      if (typeof runtime?.history === 'function') return runtime.history() || [];
      if (typeof getHistory === 'function') return getHistory() || [];
      return [];
    },

    /**
     * 订阅 agent 事件。返回取消订阅的函数。
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
     * 把一个事件推给订阅者。
     *
     * 运行时（L3）产出事件后调它——插件只认这一个入口，
     * 运行时换了实现也不用改插件。
     */
    emit(event) {
      for (const cb of [...listeners]) {
        try {
          cb(event);
        } catch (err) {
          console.warn('[desk-pet] agent 事件的订阅者出错：', err?.message);
        }
      }
    },
  };
}
