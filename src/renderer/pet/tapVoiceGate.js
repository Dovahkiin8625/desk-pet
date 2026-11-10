/**
 * 「点桌宠时说话」的闸门。
 *
 * 双击桌宠是「我要搜索」，不该顺带念一句台词——但**第一下落下时，
 * 谁也不知道后面还有没有第二下**。双击要等第二下才认出来，
 * 而台词是点击那一刻就该说的。
 *
 * 折中：台词**押后一个双击窗口**。窗口内没有第二下，才真的念；
 * 窗口内来了第二下（双击），这一句就作废。
 *
 * 押后的是**报告**（让主进程去念），不是「这一下算不算点击」——
 * 摸头的表情、动作、心情照旧立刻发生，手感不变。
 */

import { DOUBLE_TAP_INTERVAL_MS } from './doubleTap.js';

/**
 * 闸门多等这么久。
 *
 * 双击判定到 500ms 那一刻才截止：正好卡在边上的那一下，
 * 定时器可能比它先跑。余量就是给这一下留的——
 * 「双击」必须赢过「念台词」。
 */
const GATE_MARGIN_MS = 50;

/**
 * 闸门。
 *
 * @param {object} [options]
 * @param {number} [options.delayMs] 押后多久（默认一个双击窗口加余量）
 * @param {() => number} [options.now] 此刻的时刻
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 */
export function createTapVoiceGate({
  delayMs = DOUBLE_TAP_INTERVAL_MS + GATE_MARGIN_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** 押着的定时器（null = 没有押着的）。 */
  let pending = null;
  /** 押着的那句是哪一刻点的（null = 没有押着的）。 */
  let pendingAt = null;

  /** 撤掉押着的那句。 */
  function cancel() {
    if (pending === null) return;
    clearTimer(pending);
    pending = null;
    pendingAt = null;
  }

  /**
   * 押后一句台词。
   *
   * 押着的时候又来一下，就把之前那句撤掉——
   * 一次点击只念一句，两句叠在一起听不清。
   *
   * @param {() => void} speak 到了就念
   */
  function schedule(speak) {
    cancel();
    pendingAt = now();
    pending = setTimer(() => {
      pending = null;
      pendingAt = null;
      speak();
    }, delayMs);
  }

  /**
   * 押着的那句是哪一刻点的（null = 没有押着的）。
   *
   * 冷却要看它：押着的那句**马上**就要念出来了，
   * 这时候再点一下不该又排一句。
   */
  function pendingSince() {
    return pendingAt;
  }

  return { schedule, cancel, pendingSince };
}
