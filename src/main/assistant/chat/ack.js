/**
 * 「先应一声」——模型还在忙的时候，桌宠先给用户一个回应。
 *
 * ## 为什么要有它
 *
 * 用户问「F 盘 video 下有什么」，agent 要调工具、要再问一次模型，
 * 整个过程好几秒。这几秒里桌宠一声不吭，用户只看到一只空 bubble，
 * 心里想的是「这程序是不是坏了」。
 *
 * 所以：**超过一段时间还没吐出可见正文，就先应一句**。
 *
 * ## 为什么是固定短句而不是让模型说
 *
 * 让模型先说一句要**多等一轮请求**——那一轮正是我们想省掉的时间。
 * 固定短句是零延迟、零花费的，而且短句念出来也快。
 *
 * 随机挑一句是为了别每次都同一句：同一个桌宠老说「我看一下哦～」，
 * 用两天就腻了。
 */

import { DEFAULT_ACK_DELAY_MS } from '../../../shared/assistant.js';

/** 应答的短句池。 */
export const ACK_LINES = Object.freeze([
  '我看一下哦～',
  '等我查查',
  '稍等，我翻翻',
  '马上就好～',
  '让我瞧瞧',
  '在找了在找了',
]);

/**
 * 多久没人说话就应答（毫秒）。
 *
 * **默认值在共享契约里**（DEFAULT_ACK_DELAY_MS）：设置页能让用户改它，
 * 两边各写一份 1200 的话，改了一边另一边就悄悄对不上了。
 */
export const ACK_DELAY_MS = DEFAULT_ACK_DELAY_MS;

/**
 * 应答朗读的最长等待（毫秒）。
 *
 * **这是兜底**：渲染层要是没回报「播完了」（窗口被关、解码失败……），
 * 答案气泡不能就这么一直等着——那比没有应答还糟。
 */
export const ACK_MAX_WAIT_MS = 8000;

/** 没开语音时，应答气泡显示多久才把位置让给答案（毫秒）。 */
export const ACK_HOLD_MS = 1200;

/** 随机挑一句。`random` 是可注入的——测试要能挑到确定的那句。 */
export function pickAckLine(random = Math.random) {
  const r = Number.isFinite(random()) ? random() : 0;
  const index = Math.min(ACK_LINES.length - 1, Math.max(0, Math.floor(r * ACK_LINES.length)));
  return ACK_LINES[index];
}

/** 等一会儿。 */
function delay(ms) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  // 提前结束时把计时器收掉：不然它会白挂 maxWaitMs 毫秒。
  promise.clear = () => clearTimeout(timer);
  return promise;
}

/**
 * 造一个「应答控制器」。
 *
 * 用法：
 *
 * ```js
 * const ack = createAck({ speak: (line) => sayWithVoice(line) });
 * ack.arm();                       // 开始计时
 * ack.noteText();                  // 模型吐字了 → 不用再应
 * await ack.whenReady();           // 可以显示答案气泡了
 * ```
 *
 * `speak` 负责弹气泡与朗读，**它返回的时候就是这一声读完的时候**。
 */
export function createAck({
  delayMs = ACK_DELAY_MS,
  maxWaitMs = ACK_MAX_WAIT_MS,
  pickLine = pickAckLine,
  speak = async () => {},
  logger = null,
} = {}) {
  let timer = null;
  // 应答是不是已经发出去了（发出去了就不能反悔，只能等它念完）。
  let fired = false;
  let ready = false;
  let resolveReady = null;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  /** 放行：答案气泡可以出现了。 */
  function markReady() {
    if (ready) return;
    ready = true;
    resolveReady();
  }

  /** 开始计时。到点还没人说话就应一声。 */
  function arm() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      const line = pickLine();
      // 朗读可能永远不结束（渲染层没回报）：兜底超时，绝不把答案卡住。
      const timeout = delay(maxWaitMs);
      Promise.race([Promise.resolve().then(() => speak(line)), timeout])
        .catch((err) => {
          logger?.warn?.(`[助手] 应答失败：${err?.message || err}`);
        })
        .finally(() => {
          timeout.clear();
          markReady();
        });
    }, delayMs);
  }

  /**
   * 放行答案气泡。
   *
   * **已经应答了就不放行**：那一声得念完，答案才能顶上。
   *
   * 计时器有没有在跑都不影响：主动搭话那一轮压根不上计时器，
   * 但答案照样得放出来（不然那一轮会永远卡住）。
   */
  function release() {
    if (fired) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    markReady();
  }

  return {
    arm,

    /**
     * 模型吐了可见正文。
     *
     * **还没应答就吐字**：不必再应一声，直接放行答案气泡。
     * 已经应答了：什么都不做——这一声得念完，答案才能顶上。
     */
    noteText() {
      release();
    },

    /**
     * 答案好了，但应答还没发出去：放行，不必再等。
     *
     * 已经应答了就不放行（那一声还在念）。
     */
    release,

    /** 这一轮被新对话取代了（或出错了）：立刻放行，别再等。 */
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      markReady();
    },

    /** 拆掉计时器（测试与收尾用）。 */
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    /** 可以显示答案气泡了吗。 */
    whenReady: () => readyPromise,

    /** 应答已经发出去了吗。 */
    get fired() {
      return fired;
    },
  };
}
