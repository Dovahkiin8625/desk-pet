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
 *
 * 快工具的名字由**这一轮实际注册到的**那些给出（`fastToolNames`），
 * 不在这里写死一份：注册表里缺某个工具时，
 * 提示词还在报它 → 模型去调一个不存在的工具 → 白烧一步。
 */

/**
 * 组装交互层的系统提示词。
 *
 * @param {object} options
 * @param {object} [options.persona] 人设
 * @param {string[]} [options.facts] 长期记忆
 * @param {Date} [options.now]
 * @param {number} [options.runningCount] 正在跑的任务数
 * @param {number} [options.queuedCount] 排队的任务数
 * @param {boolean} [options.dispatchEnabled] 能不能派单
 * @param {string[]} [options.fastToolNames] 这一轮实际可用的快工具
 * @param {string[]} [options.pluginNames] 已启用的插件名
 */
export function buildInteractionPrompt({
  persona = {},
  facts = [],
  now = new Date(),
  runningCount = 0,
  queuedCount = 0,
  dispatchEnabled = true,
  fastToolNames = [],
  pluginNames = [],
} = {}) {
  const names = Array.isArray(fastToolNames) ? fastToolNames.filter(Boolean) : [];
  const plugins = Array.isArray(pluginNames) ? pluginNames.filter(Boolean) : [];
  return [
    buildSystemPrompt({ persona, facts, now }),
    '',
    '这活儿该你自己答，还是派后台任务：',
    '- 简单聊天、你知道的事、本提示词里写着的状态 → 直接答。',
    '- 一次工具调用就能答的（查时间、读一个文件、查任务状态、查能力清单）→ 自己调工具答。',
    '- 要调好几次工具、要翻一堆文件、要跑一会儿的 → 派后台任务（task.submit）。',
    '- **一次调工具搞不定的事，一律派后台任务**：',
    '  天气、待办、提醒、番茄钟、网上查资料……这些插件的活儿你这边干不了',
    '  （插件的工具在后台任务那边），用户问到就派单，别自己找工具试。',
    '- 拿不准就派单：派单比瞎猜便宜。',
    '- 派单前**先自己答一次**：能答就别派。',
    '- 同一个需求别重复派：你派过的单在上面的对话里写着。',
    '- 快工具失败了就别重试：转成后台任务（task.submit）。',
    '- capability.list 只在用户问「你有什么」时才调；别的场合不许拿它当查答案的手段。',
    '- 这一轮一定要给用户一句回话：派了单就说一声「我去查」，别一句话不说。',
    '你有什么：',
    plugins.length ? `- 你装着的插件：${plugins.join('、')}。` : '- 你现在没有装着插件。',
    '- 你有哪些技能、插件、工具：调 capability.list 查，别凭印象说。',
    '你能调用的工具：',
    names.length
      ? `- 快工具（整轮只能用一次，只有它们能查到东西）：${names.join(' / ')}。`
      : '- 你现在没有快工具：什么都查不到，要么直接答，要么派单。',
    '- capability.list：查你自己的技能、插件、工具。',
    '- task.submit / task.list / task.status / task.cancel / task.delete / task.steer：管后台任务。',
    '- **别的工具你调不到（调了只会报错）**：插件的活儿在后台任务那边。',
    '回答的长短：',
    '- 列清单、报任务进展这类回答可以写到 300 字、可以分几行写，别为了塞进一句话把内容砍没了。',
    '（上面这条优先于「1~3 句、不超过 80 字」。）',
    '实时状态：',
    `- 后台正在跑 ${Number(runningCount) || 0} 个任务，排队 ${Number(queuedCount) || 0} 个。`,
    `- 对话模式：${dispatchEnabled ? '可以派单（task.submit）' : '不能派单，只有快工具'}。`,
  ]
    .filter(Boolean)
    .join('\n');
}
