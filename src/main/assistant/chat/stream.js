/**
 * 聊天回复的气泡。
 *
 * ## 为什么单独一个模块
 *
 * **答案气泡不一定能立刻开**：「先应一声」的时候，
 * 要等应答那一声念完，才轮到答案冒出来。
 *
 * 所以正文不能直接往气泡里倒——得先在这儿攒着，
 * 等条件满足了（应答让位了）再开流、定稿。
 *
 * 这段时序很容易写坏（写了就丢、或者攒着攒着不倒出去），
 * 所以它自己是一个单元，能单测。
 */

import { MESSAGE_KIND } from '../../../shared/assistant.js';

/**
 * 造一个回复气泡。
 *
 * @param {object} options
 * @param {object} options.bubble 气泡控制器（见 src/main/bubble.js）
 * @param {string} [options.kind] 气泡的分类
 */
export function createReplyBubble({ bubble, kind = MESSAGE_KIND.CHAT }) {
  // 流 id：0 表示还没开流。
  let streamId = 0;
  // 还没开流时攒着的正文。
  let buffered = '';

  return {
    /**
     * 来了正文。
     *
     * 气泡还没开就先攒着——攒着的东西在 `open()` 的时候一次性倒出去，
     * 用户看到的是完整的回复，不会先看到半句再看到另一半。
     */
    push(delta) {
      const text = String(delta ?? '');
      if (!text) return;
      if (streamId) bubble.appendStream(streamId, text);
      else buffered += text;
    },

    /** 开气泡，把攒着的正文倒出去。已经开过就什么都不做。 */
    open() {
      if (streamId) return streamId;
      streamId = bubble.openStream({ kind });
      if (buffered) {
        bubble.appendStream(streamId, buffered);
        buffered = '';
      }
      return streamId;
    },

    /** 定稿：从此刻开始计时自动消失。 */
    finish({ text = '', emotion = '' } = {}) {
      if (!streamId) return;
      bubble.endStream(streamId, { text, emotion });
    },

    /** 作废：出错或被取代时收掉。 */
    cancel() {
      buffered = '';
      if (!streamId) return;
      bubble.cancelStream();
      streamId = 0;
    },

    /** 气泡开了吗。 */
    get isOpen() {
      return Boolean(streamId);
    },
  };
}
