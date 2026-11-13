import { metaContractLines } from '../chat/prompt.js';
import { snapshotSection } from '../snapshot.js';
import { TASK_STATUS_TEXT } from '../agent/record.js';
import { TASK_STATUS } from '../../../shared/assistant.js';

/**
 * 交互层的系统提示词（规格 §4.3、§4.4）。
 *
 * ## 为什么自己组装，不复用 `buildSystemPrompt`
 *
 * 交互层现在是「只说话 + 派单」：外部能力一件不留，
 * 所以旧的「这活儿该你自己答，还是派后台任务」那一整段分派规则、
 * 工具清单、插件清单、`capability.list` 的用法全删了。
 * 人设与 `<<META>>` 契约仍复用 `chat/prompt.js` 的 `metaContractLines()`，
 * 格式不许两边分叉。
 *
 * ## 「你手头在做的事」
 *
 * 这是状态块的落点：用户问「某某怎么样了」时，模型看一眼这段就能答，
 * 一次工具往返都不用花。
 *
 * **里面不许出现工具名**（进了提示词，模型就会照着说给用户听），
 * 所以那一步写的是人话标签（`lastStepLabel`）。
 * **编号要留着**：`task.cancel` / `task.steer` / `task.delete` 都要它。
 */

/** 状态块里最多列几件。 */
const MAX_TASK_LINES = 5;

/**
 * 组装交互层的系统提示词。
 *
 * @param {object} options
 * @param {object} [options.persona] 人设
 * @param {string[]} [options.facts] 长期记忆
 * @param {Date} [options.now]
 * @param {string[]} [options.snapshot] 此刻正在发生的事
 * @param {Array} [options.taskStates] 手头在做的事 `{taskId, title, status, lastStepLabel, elapsedMs}`
 * @param {string[]} [options.pluginNames] 能干的活儿的名字
 * @param {boolean} [options.dispatchEnabled] 能不能派单
 * @returns {string}
 */
export function buildInteractionPrompt({
  persona = {},
  facts = [],
  now = new Date(),
  snapshot = [],
  taskStates = [],
  pluginNames = [],
  dispatchEnabled = true,
} = {}) {
  const name = String(persona.name || '小桌').trim() || '小桌';
  const style = String(persona.style || '').trim();
  const backstory = String(persona.backstory || '').trim();
  const list = Array.isArray(facts) ? facts.filter(Boolean) : [];
  const plugins = Array.isArray(pluginNames) ? pluginNames.filter(Boolean) : [];
  const when = now instanceof Date ? now : new Date(now);

  const sections = [];

  sections.push(
    [
      `你是「${name}」，一只住在用户桌面上的 Live2D 桌宠。`,
      style ? `性格：${style}` : '',
      backstory ? `关于你：${backstory}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  sections.push(
    [
      '说话规则：',
      '- 中文口语，1~3 句，不超过 80 字（报清单、报进展可以到 300 字）。',
      '- 不要复述用户的问题，不要 Markdown，不要表情符号。',
      '- 只说你自己：不要提任何工具名、函数名、插件名，' +
        '也不要说「后台任务」「派单」「派发」「工具」这类词——用户只看得见你这个人。',
      ...metaContractLines(),
    ].join('\n'),
  );

  if (list.length) {
    sections.push(['你记得的事：', ...list.map((f) => `- ${f}`)].join('\n'));
  }

  sections.push(
    `现在是 ${when.getFullYear()} 年 ${when.getMonth() + 1} 月 ${when.getDate()} 日 ` +
      `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}。`,
  );

  // **「此刻」与「手头在做的事」是两回事**：
  // 前者是机器此刻的样子，后者是桌宠自己派出去的活儿。
  sections.push(snapshotSection(snapshot));

  sections.push(['你手头在做的事：', taskLines(taskStates)].join('\n'));

  sections.push(
    [
      '你能做的：',
      '- 直接答：聊天、回答你知道的事、报上面那些事的状态。',
      dispatchEnabled
        ? '- 其它一切（查文件、跑命令、用插件、上网找东西）都交给手头去做，你只说一声「我去」。'
        : '- 现在只能聊天：答得上的直接答，答不上的老实说做不到。',
      plugins.length ? `- 你能：${plugins.join('、')}。` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  sections.push(
    [
      '规矩：',
      '- 先自己答一次：能答就别交出去。',
      dispatchEnabled
        ? '- 要交出去的时候，调用「把一件事交出去」那个工具：' +
          '结果要求写进 brief，你要说的话写进 reply。'
        : '',
      dispatchEnabled
        ? '- 交出去之后，做完了它会自己回来告诉你，你不用转述结果。'
        : '',
      '- 同一个要求别交两遍：上面写着的事、还有刚才交过的，都别重复。',
      '- 用户问「某某怎么样了」：看「你手头在做的事」那一段直接答，别去调工具。',
      '- 括号里的编号只是给你自己用的，别念给用户听。',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return sections.join('\n\n');
}

/**
 * 「你手头在做的事」那几行。
 *
 * **只列没做完的**：做完的事写进历史里了，模型自己看得见。
 */
function taskLines(states) {
  const list = (Array.isArray(states) ? states.filter(Boolean) : []).filter((t) =>
    [TASK_STATUS.RUNNING, TASK_STATUS.QUEUED, TASK_STATUS.WAITING_APPROVAL].includes(t.status),
  );
  if (!list.length) return '现在没有别的事在忙。';
  const shown = list.slice(0, MAX_TASK_LINES).map((t) => {
    const status = TASK_STATUS_TEXT[t.status] || '';
    const bits = [String(t.taskId || ''), status];
    if (t.lastStepLabel) bits.push(`刚做完 ${t.lastStepLabel}`);
    if (t.status === TASK_STATUS.RUNNING || t.status === TASK_STATUS.WAITING_APPROVAL) {
      bits.push(`用了 ${formatElapsed(t.elapsedMs)}`);
    }
    return `- ${t.title}（${bits.filter(Boolean).join('，')}）`;
  });
  const rest = list.length - shown.length;
  if (rest > 0) shown.push(`- 还有 ${rest} 件在排队`);
  return shown.join('\n');
}

/** 用时怎么说。 */
function formatElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '一会儿';
  if (n < 1000) return '不到 1 秒';
  if (n < 60_000) return `${Math.round(n / 1000)} 秒`;
  return `${Math.round(n / 60_000)} 分钟`;
}
