// plugins/clipboard/lib/recorder.js
/**
 * 盯着剪贴板，把新复制的内容记下来。
 *
 * **不碰 electron**：怎么读剪贴板、读出来算什么格式，全由外面给进来
 * （main.js 传的是 readSnapshot 的结果），于是这段逻辑能直接用 node --test 验。
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
 * @param {() => Promise<{ok: boolean, signature?: string}> | {ok: boolean, signature?: string}} options.grab
 *   读一次剪贴板。签名一样就是同一条内容；空串签名 = 「剪贴板里没有值得记的东西」。
 *   整个结果会原样传给 onEntry（含格式、图片字节什么的）。
 * @param {(result: object) => void} [options.onEntry] 看到新内容时叫它
 * @param {number} [options.intervalMs]
 */
export function createRecorder({ grab, onEntry, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let timer = null;
  /** 上一次看到的东西的签名。 */
  let lastSignature = '';
  /** 基准读完了吗？没读完之前不做比较。 */
  let baselineReady = false;
  /** 上一轮还在读吗？剪贴板读取可能慢（被别的进程锁住时会等）。 */
  let polling = false;
  /** 刚贴出去的那条的签名：下一轮读到它不算「新复制的」。 */
  let ignored = '';
  /**
   * 贴出去之后的保护期（毫秒时间戳）：这段时间里
   * 读到的**任何**签名都当「回声」——贴出去那次写回剪贴板
   * 是由我们发起的，不是用户刚复制的东西（哪怕系统把格式改写得
   * 和原样签名对不上，也照样得吞掉，免得贴完历史里多一条）。
   */
  let muzzleUntil = 0;

  /**
   * 读一次剪贴板。
   *
   * @returns {Promise<{ok: boolean, signature: string}>} ok=false 是「读不到」
   */
  async function read() {
    try {
      const result = await grab();
      if (!result || result.ok !== true) return { ok: false, signature: '' };
      const signature = typeof result.signature === 'string' ? result.signature : '';
      return { ...result, ok: true, signature };
    } catch {
      return { ok: false, signature: '' };
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
    lastSignature = result.signature;
    baselineReady = true;
  }

  async function poll() {
    if (polling || !baselineReady) return;
    polling = true;
    try {
      const result = await read();
      // 这一轮不算：剪贴板被别人占着，等下一轮。
      if (!result.ok) return;
      const signature = result.signature;
      if (signature === lastSignature) return;
      lastSignature = signature;
      // 复制到空（清空剪贴板）不算一条。
      if (!signature) return;
      // 贴完后的保护期：这段时间里读到的都当回声——
      // 贴出去那次的写回就发生在这之前，不是用户刚复制的东西。
      // 注意 lastSignature 已经更新过上面，
      // 保护期一过，同一条内容再也不会被当成「新的」。
      if (Date.now() < muzzleUntil) return;
      // 刚贴出去的那一条：不算新的复制。
      if (ignored && signature === ignored) {
        ignored = '';
        return;
      }
      // 别的内容：后门作废（用户已经复制了别的东西）。
      ignored = '';
      onEntry?.(result);
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
     *
     * @param {string} signature 被贴出去那条的签名（= 历史条目的 key）
     */
    ignore(signature) {
      ignored = String(signature ?? '');
    },
    /**
     * 贴出去后开一个保护期：这段时间里读到的任何签名都当回声。
     *
     * ignore() 是「见到哪一条签名就吞掉」，muzzle() 是
     * 「任何签名都吞掉」——系统改写格式（如 CF_HTML 加头尾）之后
     * 签名变了，ignore 就认不出来，muzzle 是它的兜底。
     *
     * @param {number} [ms] 保护期长度（毫秒）
     */
    muzzle(ms) {
      muzzleUntil = Date.now() + Math.max(0, Number(ms) || 0);
    },
    isRunning: () => Boolean(timer),
  };
}
