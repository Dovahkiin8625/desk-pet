/**
 * 语音排队：一次只播一段。
 *
 * 为什么要排：不排的话，两段语音会同时响。
 * 最常见的是「前台那段回复还没念完，后台那件事做完了又报一句」——
 * 两句话叠在一起，谁也听不清。
 *
 * 排队的规矩很简单：**后来的一段，等前面那段播完再开始**。
 * 顺序不变（先来的先说），也不丢话。
 *
 * 这个模块是**纯逻辑**：不碰音频，也不碰 DOM，
 * 这样「排队」这件事能脱离 Electron 单测。
 */

/**
 * 造一个语音队列。
 *
 * @returns {{run: <T>(task: () => Promise<T> | T) => Promise<T>}}
 */
export function createSpeechQueue() {
  /** 上一段结束（或失败）时兑现的 promise。 */
  let tail = Promise.resolve();

  return {
    /**
     * 排一段语音。
     *
     * 返回的 promise 在**这一段真的播完**时兑现——
     * 主进程在等这个信号（「先应一声」要等应答念完才放答案）。
     *
     * 前一段失败不挡这一段：语音播不出来是它自己的事，
     * 不能让后面的话都跟着哑掉。
     *
     * @param {() => Promise<any>|any} task 播一段语音
     */
    run(task) {
      const played = tail.then(task, task);
      // 队列自己不能被一次失败带崩：吞掉，只留给调用方的那个 promise。
      tail = played.then(
        () => {},
        () => {}
      );
      return played;
    },
  };
}
