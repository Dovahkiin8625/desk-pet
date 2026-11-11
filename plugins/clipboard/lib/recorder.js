// plugins/clipboard/lib/recorder.js
/**
 * 盯着剪贴板，把新复制的内容记下来。
 *
 * **不碰 electron**：读剪贴板的方式由外面给进来
 * （main.js 传的是 electron 的 clipboard.readText），
 * 于是这段逻辑能直接用 node --test 验。
 *
 * 三处讲究：
 *
 * 1. **启动时不报旧内容**：刚启动时剪贴板里已经有的东西不是「你复制了」，
 *    是「你之前复制了」。所以先记一份基准，之后只报**变了**的。
 * 2. **自己贴出去的不算**：贴一条历史时会把内容写回剪贴板，
 *    那一下会被当成「用户刚复制的东西」又记一遍。ignore() 就是给它开后门。
 * 3. **读不到 ≠ 剪贴板是空的**：别的程序正占着剪贴板时，读会失败。
 *    这两种情况得分开——当成「空了」就等于忘了剪贴板里是什么。
 */

/** 默认多久看一次剪贴板（毫秒）。 */
export const DEFAULT_INTERVAL_MS = 500;

/**
 * 造一个记录器。
 *
 * @param {object} options
 * @param {() => string | Promise<string>} options.readText 读一次剪贴板
 * @param {(text: string) => void} [options.onText] 看到新内容时叫它
 * @param {number} [options.intervalMs]
 */
export function createRecorder({ readText, onText, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let timer = null;
  /** 上一次看到的剪贴板内容。 */
  let lastText = '';
  /** 基准读完了吗？没读完之前不做比较。 */
  let baselineReady = false;
  /** 上一轮还在读吗？剪贴板读取可能慢（被别的进程锁住时会等）。 */
  let polling = false;
  /** 刚贴出去的那条：下一轮读到它不算「新复制的」。 */
  let ignored = '';

  /**
   * 读一次剪贴板。
   *
   * @returns {Promise<{ok: boolean, text: string}>} ok=false 是「读不到」
   */
  async function read() {
    try {
      const text = await readText();
      return { ok: true, text: typeof text === 'string' ? text : '' };
    } catch {
      return { ok: false, text: '' };
    }
  }

  /**
   * 取基准：剪贴板里原来是什么。
   *
   * 读不到就过一会儿再试——剪贴板被别人占着是常事，
   * 基准没取到之前不做比较（免得把旧内容当成新复制的报出去）。
   */
  async function prime() {
    if (!timer) return;
    const result = await read();
    if (!timer) return;
    if (!result.ok) {
      setTimeout(() => {
        void prime();
      }, intervalMs);
      return;
    }
    lastText = result.text;
    baselineReady = true;
  }

  async function poll() {
    if (polling || !baselineReady) return;
    polling = true;
    try {
      const result = await read();
      // 这一轮不算：剪贴板被别人占着，等下一轮。
      if (!result.ok) return;
      const text = result.text;
      if (text === lastText) return;
      lastText = text;
      // 复制到空（清空剪贴板）不算一条。
      if (!text.trim()) return;
      // 刚贴出去的那一条：不算新的复制。
      if (ignored && text === ignored) {
        ignored = '';
        return;
      }
      // 别的内容：后门作废（用户已经复制了别的东西）。
      ignored = '';
      onText?.(text);
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      baselineReady = false;
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
      void prime();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      baselineReady = false;
    },
    /**
     * 这条是我们自己贴出去的：下一轮别把它当成新的复制。
     *
     * **要在写回剪贴板之前叫它**：中间那一轮要是先读到了，
     * 它就会被当成用户刚复制的内容。
     */
    ignore(text) {
      ignored = String(text ?? '');
    },
    isRunning: () => Boolean(timer),
  };
}
