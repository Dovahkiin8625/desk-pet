import { buildSystemPrompt } from '../chat/prompt.js';

/**
 * 交互层的系统提示词（规格 §4.3、§4.5）。
 *
 * 每轮重建，尾部拼一段**实时状态**：
 *
 * ```
 * 后台正在跑 2 个任务，排队 0 个。
 * 对话模式：可以派单（task.submit）。
 * ```
 *
 * 所以「现在几点」「还有几个任务在跑」**不需要任何工具调用**。
 */
export function buildInteractionPrompt({
  persona = {},
  facts = [],
  now = new Date(),
  runningCount = 0,
  queuedCount = 0,
  dispatchEnabled = true,
  hasFastTools = true,
} = {}) {
  return [
    buildSystemPrompt({ persona, facts, now }),
    '',
    '你这轮的职责：先试着直接回答用户，别动不动就派单。',
    '- 能自己答的（聊天、你知道的事、本提示词里写着的状态）就直接答。',
    '- 要查本机、要动手、要跑一会儿的，才派后台任务（task.submit）。',
    '- 派单前**先自己答一次**：能答就别派。',
    '- 同一个需求别重复派：你派过的单在上面的对话里写着。',
    '- 快工具失败了就别重试：转成后台任务（task.submit）。',
    '实时状态：',
    `- 后台正在跑 ${Number(runningCount) || 0} 个任务，排队 ${Number(queuedCount) || 0} 个。`,
    `- 对话模式：${dispatchEnabled ? '可以派单（task.submit）' : '不能派单，只有快工具'}。`,
    hasFastTools
      ? '- 快工具（整轮只能用一次）：clock.now / clipboard.read / fs.read / fs.list。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
