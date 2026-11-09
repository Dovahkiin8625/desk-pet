import { isToolsUnsupportedError } from '../chat/agent.js';

/**
 * 跑一轮前台对话（规格 §10.4）。
 *
 * 前台恒定走交互层：交互层要调工具（查状态、派单、停任务），
 * 而模型不认 `tools` 字段时会直接 400。
 * 这时候这一轮**退回普通对话**，并告诉用户「这个模型不支持工具调用，
 * 先按普通对话来」——否则用户只看到一句报错，不知道该怎么办。
 *
 * **只有这一种错才退**：上下文超长、key 不对、限流……退了也只是换个姿势再错一次。
 *
 * ## 为什么单独一个文件
 *
 * 「什么时候该退、退了之后说什么」是**前台这一轮的规矩**，
 * 不是某个后端的规矩。放在这里，后端就只管自己那一层的事，
 * 两边各写一份的话，退路迟早会写歪（一边退一边不告诉用户）。
 */
export async function runForeground({ interaction, plain, ctx, onFallback = null }) {
  try {
    return await interaction.chat(ctx);
  } catch (err) {
    if (!isToolsUnsupportedError(err)) throw err;
    onFallback?.(err);
    return plain.chat(ctx);
  }
}
