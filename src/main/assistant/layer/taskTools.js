import { LAYER, TOOL_RISK } from '../../../shared/assistant.js';
import { buildHistoryMessages } from '../chat/prompt.js';
import { dispatchRecord } from '../agent/record.js';

/**
 * 交互层的四个任务管理工具（规格 §4.1）。
 *
 * ## 全部免审批
 *
 * 它们全是 `risk: 'read'`：交出去、停下、补要求都不碰用户的东西。
 * 审批是给「写文件 / 跑命令」准备的，不是给「管理自己的任务」准备的。
 *
 * ## 派单要带三样东西
 *
 * 1. **用户原话**（逐字）：执行层要能自纠——简报写歪了还能靠原话找回来；
 * 2. **交互层的理解**（title + brief）：要干什么、要什么结果、有什么约束；
 * 3. **相关历史**：执行层自己再读最近几条 user/reply。
 *
 * ## `reply`：要跟用户说的那一句话
 *
 * 模型在调工具时把话一次写完，工具跑完直接用它回复用户——
 * 派单只花一次模型往返（规格 §4.2）。没写就是没写，
 * 循环照常走第 2 轮，让模型自己组织一句话。
 */

/**
 * 派单说明最多几个字。
 *
 * **为什么限长**：交互层的 `maxTokens` 按普通对话（默认 800），
 * 而工具参数与正文**共用**同一个额度——说明被截断，
 * 参数就不是合法 JSON，循环报错，白烧掉 3 步里的 1 步。
 */
const BRIEF_MAX_CHARS = 200;

/**
 * `reply` 参数：四个工具都有同一份说明。
 *
 * **为什么不带「派单」这类词**：模型会把参数说明当成自己说话的口径，
 * 说明里的话很容易被原样说给用户听。
 */
const REPLY_PARAM = Object.freeze({
  type: 'string',
  description:
    '要跟用户说的那一句话：一两句，口语。不要报告结果，不要提任何工具名。' +
    '后面可以跟一段 <<META>>{...}（情绪与要记住的事），不写也行。',
});

/**
 * 造这一轮的任务管理工具。
 *
 * **每轮造一份**：派单要用「这一轮的用户原话与历史」，
 * 拿上一轮的东西派单，派出去的是别人家的活。
 *
 * @param {object} options
 * @param {object} options.tasks 任务中枢（提交 / 停止 / 归档 / 追加指令 / 列表）
 * @param {object} [options.turn] 这一轮的上下文 {history, userText, config}
 * @param {boolean} [options.dispatchEnabled] 能不能派单
 * @param {Function} [options.appendRecord] 写一条分类记录
 * @param {Function} [options.now] 取当前时刻
 */
export function createTaskTools({
  tasks = null,
  turn = {},
  dispatchEnabled = true,
  appendRecord = () => {},
  now = () => Date.now(),
} = {}) {
  const history = Array.isArray(turn.history) ? turn.history : [];
  const userText = String(turn.userText || '');
  const config = turn.config || {};

  /**
   * 记一条派单记录：交互层下一轮要看得见自己派过什么。
   *
   * **`brief` 只有派单才有**：那是模型写给执行层的说明，
   * 聊天历史页要把它原样显示出来，用户才知道这活儿到底是让谁去干了什么。
   * 其它三个工具不交底什么，留空串。
   *
   * **`action` 是宠物的说法**：记录要进聊天记录页，用户看得见——
   * 「派了个任务」这种内部话术不该出现在桌宠嘴里。
   */
  function record(tool, { taskId = '', title = '', action = '', brief = '' } = {}) {
    appendRecord(dispatchRecord({ tool, taskId, title, action, brief, at: now() }));
  }

  /**
   * 这件事叫什么：记录里要写给用户看。
   *
   * **为什么要在收起来之前查**：归档之后这件事就不在列表里了，
   * 那时再查只剩一个编号——编号是内部标识，用户看不懂。
   */
  function titleOf(taskId) {
    const list = tasks?.list?.() || [];
    const hit = list.find((t) => t?.taskId === taskId);
    return String(hit?.title || '').trim();
  }

  return [
    {
      name: 'task.submit',
      label: '开始做一件事',
      description:
        '把一件事交出去做——你自己干不了、或者要花时间的事都走这里。' +
        '要什么结果写在 brief 里；要跟用户说的那句话写在 reply 里。做完会另行通知你。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话说明这个任务要做什么' },
          brief: { type: 'string', description: '任务说明：要干什么、要什么结果、有什么约束（200 字以内）' },
          reply: REPLY_PARAM,
        },
        required: ['title', 'brief'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const answer = String(args?.reply || '').trim();
        if (!dispatchEnabled) throw new Error('现在不能派单（对话模式里派单关着）');
        const title = String(args?.title || '').trim() || '一件事';
        const brief = String(args?.brief || '').trim();
        if (!brief) throw new Error('任务说明还没写：要说清要干什么');
        // **限长**：交互层的 `maxTokens` 按普通对话（默认 800），
        // 而工具参数与正文共用同一个额度——说明被截断，
        // 参数就不是合法 JSON，循环报错，白烧掉 3 步里的 1 步。
        // 超了就让模型写短点：用户的完整原话本来也会一起传过去，不会丢信息。
        if (brief.length > BRIEF_MAX_CHARS) {
          throw new Error(
            `任务说明太长了（${brief.length} 字）：请写到 ${BRIEF_MAX_CHARS} 字以内`,
          );
        }
        const messages = [
          ...buildHistoryMessages({ history, layer: LAYER.EXECUTION }),
          { role: 'user', content: `${brief}\n\n用户原话：${userText}` },
        ];
        const task = tasks.submit({ prompt: brief, title, messages, config });
        if (!task?.ok) throw new Error('派不出去：运行时没有收下这个任务');
        record('task.submit', {
          taskId: task.taskId,
          title,
          action: `开始做：${title}`,
          // **交底原文**：模型写给执行层的那段说明，原样记下来。
          brief,
        });
        return {
          text: `已派出任务 ${task.taskId}（${title}）`,
          data: { taskId: task.taskId, queued: Boolean(task.queued), answer },
        };
      },
    },

    {
      name: 'task.cancel',
      label: '让一件事停下',
      description: '让一件正在做的事停下。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务号' },
          reply: REPLY_PARAM,
        },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const answer = String(args?.reply || '').trim();
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要停哪个任务？给个 taskId');
        const title = titleOf(taskId);
        const res = tasks.cancel(taskId);
        if (!res?.ok) throw new Error(res?.message || '停不下来');
        record('task.cancel', { taskId, title, action: `停掉了：${title || taskId}` });
        return { text: `已停掉任务 ${taskId}`, data: { taskId, answer } };
      },
    },

    {
      name: 'task.steer',
      label: '给一件事补要求',
      description: '给一件正在做的事补一句要求（不改它原本要做什么）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务号' },
          note: { type: 'string', description: '要追加的那句话' },
          reply: REPLY_PARAM,
        },
        required: ['taskId', 'note'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const answer = String(args?.reply || '').trim();
        const taskId = String(args?.taskId || '').trim();
        const note = String(args?.note || '').trim();
        if (!taskId) throw new Error('要给哪个任务追加要求？给个 taskId');
        if (!note) throw new Error('要追加什么？给个 note');
        const title = titleOf(taskId);
        const res = tasks.steer(taskId, note);
        if (!res?.ok) throw new Error(res?.message || '追加不了');
        // 任务刚好结束：那句追加没送出去（**不是错误**，是时序问题）。
        // 但要**如实说**——说成「已追加」的话，模型会跟着跟用户说谎。
        const dropped = Boolean(res.dropped);
        record('task.steer', {
          taskId,
          title,
          action: dropped
            ? '那件事已经结束了，这句要求没送出去'
            : '给那件事补了一句要求',
        });
        return {
          text: dropped
            ? `任务 ${taskId} 已经结束了，这句要求没送出去`
            : `已给任务 ${taskId} 追加要求`,
          data: { taskId, note, answer },
        };
      },
    },

    {
      name: 'task.delete',
      label: '把一件事收起来',
      description: '把一件已经结束的事收起来（记录仍然留着）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务号' },
          reply: REPLY_PARAM,
        },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const answer = String(args?.reply || '').trim();
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要收起来哪个任务？给个 taskId');
        // **先查名字再收起来**：收起来之后这件事就不在列表里了。
        const title = titleOf(taskId);
        const res = tasks.archive(taskId);
        if (!res?.ok) throw new Error(res?.message || '收不起来');
        record('task.delete', { taskId, title, action: `收起来了：${title || taskId}` });
        return { text: `已收起来任务 ${taskId}`, data: { taskId, answer } };
      },
    },
  ];
}
