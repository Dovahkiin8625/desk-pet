import { metaContractLines, META_MARKER } from '../chat/prompt.js';

/**
 * agent 的系统提示词与上下文管理。
 *
 * ## 为什么 agent 要另有一份提示词
 *
 * 普通对话的提示词（chat/prompt.js）是「陪用户聊天」：
 * 1~3 句、80 字以内、别提工具。
 *
 * agent 的提示词要多三样东西：
 * - **工具表**：模型看不见没列出来的工具，就不会去调它；
 * - **工作区**：相对路径都相对它；
 * - **审批策略**：模型得知道「写文件可能要用户点头」，才不会以为调了就是成了。
 *
 * ## 上下文压缩为什么在这儿
 *
 * 一次任务可能有十几步，每步的工具结果都进上下文——
 * `fs.read` 能读 2MB，不压的话几步就把上下文撑爆，
 * 而症状是「模型突然变笨」而不是报错，极难排查。
 *
 * **压缩的单位是「轮」**：一轮 = assistant(带 tool_calls) + 后面连续的若干条 tool 消息。
 * 只丢 tool 消息而留着 assistant 那条，接口会因为「tool_calls 没有对应的结果」直接报错。
 */

/** 上下文里最多留几轮工具调用。 */
export const MAX_AGENT_CONTEXT_STEPS = 8;

/** 上下文里最多留多少字（工具结果 + 助手的话 + 工具参数）。 */
export const MAX_AGENT_CONTEXT_CHARS = 24000;

/** 一条工具结果最多进上下文多少字。 */
export const MAX_AGENT_TOOL_RESULT_CHARS = 1500;

/**
 * 审批策略的说明。
 *
 * 给模型看的措辞要**说清楚后果**：模型知道「可能被拒绝」，
 * 才会准备好「被拒绝了怎么办」的下一条路，而不是反复重试同一个调用。
 */
const POLICY_TEXT = {
  auto: 'auto（全部放行，不需要用户确认）',
  graded: 'graded（只读操作直接放行；写入与执行需要用户确认，用户可能拒绝）',
  manual: 'manual（每一步都需要用户确认，用户可能拒绝）',
};

/**
 * 组装 agent 的系统提示词。
 *
 * @param {object} options
 * @param {object} [options.persona] 人设 {name, style, backstory}
 * @param {string[]} [options.facts] 长期记忆
 * @param {object[]} [options.tools] 工具描述符
 * @param {string} [options.workspace] 工作目录（空 = 用户主目录）
 * @param {object} [options.approval] {policy, allowAlways}
 * @param {Date} [options.now]
 */
export function buildAgentSystemPrompt({
  persona = {},
  facts = [],
  tools = [],
  workspace = '',
  approval = {},
  now = new Date(),
} = {}) {
  const name = String(persona?.name || '小桌').trim() || '小桌';
  const style = String(persona?.style || '').trim();
  const backstory = String(persona?.backstory || '').trim();
  const list = Array.isArray(facts) ? facts.filter(Boolean) : [];
  const when = now instanceof Date ? now : new Date(now);
  const toolList = Array.isArray(tools) ? tools.filter((t) => t && t.name) : [];
  const policy = String(approval?.policy || 'graded');
  const allowAlways = Array.isArray(approval?.allowAlways) ? approval.allowAlways : [];
  const workDir = String(workspace || '').trim();

  const lines = [
    `你是「${name}」，一只住在用户桌面上的 Live2D 桌宠。`,
    style ? `你的性格：${style}` : '',
    backstory ? `关于你：${backstory}` : '',
    '',
    '这次你可以动手做事：你有一批工具，需要的话就去用它们查、改、执行，',
    '而不是凭想象编造结果。没把握的宁可不答。',
    '',
    `工作目录：${workDir || '（用户主目录）'}`,
    '相对路径都相对这个目录；上面没写具体路径时就是用户主目录。',
    '',
  ];

  if (toolList.length) {
    lines.push('你有的工具：');
    for (const tool of toolList) {
      const desc = String(tool.description || '').trim();
      const params = describeParameters(tool.parameters);
      lines.push(`- ${tool.name}：${desc}${params ? `（参数：${params}）` : ''}`);
    }
    lines.push('');
  } else {
    lines.push('你现在没有可用的工具，只能用聊天回答。', '');
  }

  lines.push(
    `审批策略：${POLICY_TEXT[policy] || POLICY_TEXT.graded}`,
    allowAlways.length ? `永久放行的工具：${allowAlways.join('、')}` : '',
    '被拒绝不是错误：换个参数或换条路再试，别死磕同一个调用。',
    '',
    '做事的规矩：',
    '- 需要工具才能回答的，就去调工具；不要编造工具的结果。',
    '- 一轮里可以调多个工具，它们各自会给你结果。',
    '- 工具报错时读懂错误，换个参数或换条路再试；同一个错连着出三次就别试了。',
    '- 工具的结果里可能有噪声，自己挑出有用的部分。',
    '',
    '回答规则：',
    '- 用中文口语回答，1~3 句，不超过 120 字：做了什么事、结果如何，一句带过。',
    '- 不要复述用户的问题，不要 Markdown，不要表情符号。',
    ...metaContractLines(),
    list.length ? `\n你记住的事：\n${list.map((f) => `- ${f}`).join('\n')}` : '',
    `现在是 ${when.getFullYear()} 年 ${when.getMonth() + 1} 月 ${when.getDate()} 日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}。`,
  );

  return lines.filter((line) => line !== '').join('\n');
}

/**
 * 把模型输出里那段 `<<META>>` 的 JSON 切掉。
 *
 * **只对「回到上下文里」的那份正文用**：模型的中间轮前言（"好的，我来查一下"）
 * 后面很可能也带一段 META——那是它给最终答案准备的情绪与记忆，
 * 这一轮并不打算交卷。那段 JSON 进了历史，模型会看见自己上一轮吐过 META，
 * 于是以为「这一轮已经结束」，或者干脆复读一遍。
 *
 * 最终答复不走这里：它由 parseReply 处理，META 要留着。
 */
export function stripMeta(text) {
  const s = String(text ?? '');
  const at = s.indexOf(META_MARKER);
  return at < 0 ? s : s.slice(0, at).trim();
}

/**
 * 把参数的 JSON Schema 说成一句话。
 *
 * 只说「有哪些参数、分别是什么类型、哪些必填」——
 * 把整个 schema 塞进提示词既占地方，模型也用不上那么多细节。
 */
function describeParameters(parameters) {
  const props = parameters?.properties;
  if (!props || typeof props !== 'object') return '';
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  const parts = Object.entries(props).map(([key, value]) => {
    const type = value?.type || 'string';
    return required.includes(key) ? `${key}(${type},必填)` : `${key}(${type})`;
  });
  return parts.join('、');
}

/**
 * 工具结果进上下文前的截断。
 *
 * **截断必须留痕**：模型看到半句话会以为文件就这么多，
 * 于是做出错误判断（比如以为文件读完了）。
 */
export function truncateToolResult(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_AGENT_TOOL_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_AGENT_TOOL_RESULT_CHARS)}…（已截断）`;
}

/**
 * 压缩上下文。
 *
 * 规则（按顺序）：
 * 1. 轮数超上限 → 丢最老的轮；
 * 2. 字数还超 → 继续丢轮（至少留一轮：最后一轮通常正是推进中的那轮）；
 * 3. 还是超 → 把剩下的工具结果再截短（单轮就特别大时才轮得到这一步）。
 *
 * @returns {{messages: object[], dropped: number}} dropped 是丢掉的轮数
 */
export function compactAgentMessages(
  messages,
  { maxSteps = MAX_AGENT_CONTEXT_STEPS, maxChars = MAX_AGENT_CONTEXT_CHARS } = {}
) {
  let list = Array.isArray(messages) ? messages.slice() : [];
  let dropped = 0;

  while (countRounds(list) > maxSteps) {
    list = dropOldestRound(list);
    dropped += 1;
  }
  while (charsOf(list) > maxChars && countRounds(list) > 1) {
    list = dropOldestRound(list);
    dropped += 1;
  }
  if (charsOf(list) > maxChars) {
    list = list.map((m) =>
      m.role === 'tool' ? { ...m, content: truncateText(m.content, 400) } : m
    );
  }
  return { messages: list, dropped };
}

/**
 * 压缩之后要在系统提示词里补的一句说明。
 *
 * 没有它，模型会以为自己没做过那些事，于是把同样的活儿再做一遍。
 */
export function compactionNote(dropped) {
  const n = Number(dropped) || 0;
  if (n <= 0) return '';
  return `（前面 ${n} 轮工具调用已从上下文里省略，它们的结果你看不到；别重复做已经做过的事）`;
}

/** 一轮 = assistant(带 tool_calls) + 后面连续的若干条 tool 消息。 */
function countRounds(messages) {
  return messages.filter(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  ).length;
}

/** 丢掉最老的一轮（assistant 与它的 tool 结果必须一起丢）。 */
function dropOldestRound(messages) {
  const at = messages.findIndex(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  );
  if (at < 0) return messages;
  let end = at + 1;
  while (end < messages.length && messages[end].role === 'tool') end += 1;
  return [...messages.slice(0, at), ...messages.slice(end)];
}

/** 上下文的字数：正文 + 工具参数。 */
function charsOf(messages) {
  let n = 0;
  for (const m of messages) {
    n += String(m?.content || '').length;
    for (const c of m?.tool_calls || []) {
      n += String(c?.function?.arguments || '').length;
    }
  }
  return n;
}

/** 截到上限（不带留痕——这里已经知道发生过截断了）。 */
function truncateText(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}
