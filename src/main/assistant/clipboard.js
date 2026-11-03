import { clipboard } from 'electron';

/**
 * 剪贴板助手。
 *
 * **剪贴板内容只留在内存里，绝不落盘。**
 * 剪贴板里可能有密码管理器复制出来的密码、验证码、
 * 或者一段私人的聊天记录——写进 assistant.json 等于把它存到磁盘上，
 * 用户不会知道，也不会同意。
 *
 * 默认关闭（见 state.js）：读剪贴板是要用户点头的事。
 *
 * 注意：Electron 45 的 `clipboard.readText()` 是**异步**的
 * （返回 Promise<string>，与 W3C 的 navigator.clipboard 一致），
 * 不是老版本的同步返回。把它当同步用会拿到 undefined——
 * 于是「读到的永远是 undefined」，助手永远不会报告任何内容。
 */
export function createClipboardWatcher({ intervalMs = 2000, onText } = {}) {
  let timer = null;
  // 上一次看到的剪贴板内容。
  //
  // 启动时先记下**当前**内容：否则应用一启动就会把用户之前复制的东西
  // 报一遍——那不是「你复制了」，那是「你之前复制了」。
  let lastText = '';
  // 基准读完了吗？没读完之前不做比较——
  // 否则第一轮轮询会拿「还没初始化」的空基准去比，把启动时的剪贴板内容报出去。
  let baselineReady = false;
  // 上一轮轮询还在读吗？剪贴板读取可能慢（被别的进程锁住时会等），
  // 不能让两轮叠在一起。
  let polling = false;

  /** 读一次剪贴板；读不到（被锁、被清空）就当空字符串。 */
  async function readClipboard() {
    try {
      const text = await clipboard.readText();
      return typeof text === 'string' ? text : '';
    } catch {
      return '';
    }
  }

  async function poll() {
    if (polling || !baselineReady) return;
    polling = true;
    try {
      const text = await readClipboard();
      if (text === lastText) return;
      lastText = text;
      // 复制到空（清空剪贴板）不算一条提示。
      if (!text.trim()) return;
      onText?.(text);
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      baselineReady = false;
      void readClipboard().then((text) => {
        lastText = text;
        baselineReady = true;
      });
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      baselineReady = false;
    },
    /** 手动读一次当前剪贴板（「播报最近一次复制」）。 */
    async readNow() {
      return readClipboard();
    },
    isRunning: () => Boolean(timer),
  };
}

/**
 * 复制内容太长时的截断。
 *
 * 一整篇文章贴到气泡里会把气泡撑到屏幕外；而且用户真正想知道的
 * 通常只是「我复制了什么」，不是全文。
 */
export function truncateClipboard(text, max = 40) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…`;
}
