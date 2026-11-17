// src/main/clipboardTracker.js
import { createHash } from 'node:crypto';

/**
 * 盯着剪贴板，记「最近一次变化的时刻」。
 *
 * Electron 不告诉你内容是什么时候复制的，只能一直看着：
 * 谁变了就什么时候记一笔。内容不落盘，也不在内存里多留——
 * 只留一枚哈希和一个时间戳。
 *
 * **启动时不算「刚复制的」**：基准先记下，之后只认变化。
 */
export function createClipboardTracker({ grab, intervalMs = 1000 } = {}) {
  let timer = null;
  /** 上一次看到的签名；null = 还没取到基准。 */
  let lastSignature = null;
  /** 最近一次变化的时刻（毫秒）；0 = 还没观察到变化。 */
  let lastChangeAt = 0;
  /** 上一轮还在读吗？剪贴板读取可能慢（被别的进程锁住时会等）。 */
  let polling = false;

  async function readSignature() {
    let text;
    try {
      text = await grab();
    } catch {
      return null;
    }
    if (typeof text !== 'string') return null;
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  async function tick() {
    if (polling) return;
    polling = true;
    try {
      const sig = await readSignature();
      // 读不到（被别的进程占着）就当没变。
      if (sig === null) return;
      // 第一次读到：记基准，不算「刚复制的」。
      if (lastSignature === null) {
        lastSignature = sig;
        return;
      }
      if (sig === lastSignature) return;
      lastSignature = sig;
      lastChangeAt = Date.now();
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      lastSignature = null;
      lastChangeAt = 0;
    },
    /** 剪贴板最近一次变化的时刻（毫秒时间戳）；没观察到变化返回 0。 */
    changedAt() {
      return lastChangeAt;
    },
  };
}
