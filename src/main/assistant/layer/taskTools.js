import { LAYER, TASK_STATUS, TOOL_RISK } from '../../../shared/assistant.js';
import { buildHistoryMessages } from '../chat/prompt.js';
import { dispatchRecord } from '../agent/record.js';

/**
 * 交互层的六个任务管理工具（规格 §4.1）。
 *
 * ## 全部免审批
 *
 * 它们全是 `risk: 'read'`：查状态、派单、停任务都不碰用户的东西。
 * 审批是给「写文件 / 跑命令」准备的，不是给「管理自己的任务」准备的。
 *
 * ## 派单要带三样东西
 *
 * 1. **用户原话**（逐字）：执行层要能自纠——简报写歪了还能靠原话找回来；
 * 2. **交互层的理解**（title + brief）：要干什么、要什么结果、有什么约束；
 * 3. **相关历史**：执行层自己再读最近几条 user/reply。
 */

/** 任务状态的中文说法（人看的那份）。 */
const STATUS_LABEL = Object.freeze({
  [TASK_STATUS.QUEUED]: '排队中',
  [TASK_STATUS.RUNNING]: '进行中',
  [TASK_STATUS.WAITING_APPROVAL]: '等你点头',
  [TASK_STATUS.DONE]: '已完成',
  [TASK_STATUS.FAILED]: '失败',
  [TASK_STATUS.CANCELLED]: '已取消',
  [TASK_STATUS.INTERRUPTED]: '被中断',
});

/**
 * 派单说明最多几个字。
 *
 * **为什么限长**：交互层的 `maxTokens` 按普通对话（默认 800），
 * 而工具参数与正文**共用**同一个额度——说明被截断，
 * 参数就不是合法 JSON，循环报错，白烧掉 3 步里的 1 步。
 */
const BRIEF_MAX_CHARS = 200;

/**
 * 造这一轮的任务管理工具。
 *
 * **每轮造一份**：派单要用「这一轮的用户原话与历史」，
 * 拿上一轮的东西派单，派出去的是别人家的活。
 *
 * @param {object} options
 * @param {object} options.tasks 任务中枢（提交 / 查看 / 停止 / 归档 / 追加指令）
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
   * 其它四个工具不交底什么，留空串。
   */
  function record(tool, { taskId = '', title = '', action = '', brief = '' } = {}) {
    appendRecord(dispatchRecord({ tool, taskId, title, action, brief, at: now() }));
  }

  return [
    {
      name: 'task.submit',
      label: '派个后台任务',
      description:
        '派一个后台任务去做耗时的活（查本机、翻文件、跑命令）。做完会另行通知你。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话说明这个任务要做什么' },
          brief: { type: 'string', description: '任务说明：要干什么、要什么结果、有什么约束（200 字以内）' },
        },
        required: ['title', 'brief'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
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
          action: `派了个任务：${title}`,
          // **交底原文**：模型写给执行层的那段说明，原样记下来。
          brief,
        });
        return {
          text: `已派出任务 ${task.taskId}（${title}）`,
          data: { taskId: task.taskId, queued: Boolean(task.queued) },
        };
      },
    },

    {
      name: 'task.list',
      label: '看后台任务',
      description: '列出后台任务：每个任务在做什么、到哪一步了。',
      parameters: { type: 'object', properties: {}, required: [] },
      risk: TOOL_RISK.READ,
      async run() {
        const list = tasks.list();
        const text = list.length
          ? list
              .map((t) => `${t.taskId}｜${t.title}｜${t.status}｜${t.lastStep || ''}`)
              .join('\n')
          : '（现在没有后台任务）';
        record('task.list', { action: `看了看后台任务：${list.length} 个` });
        return { text, data: { list } };
      },
    },

    {
      name: 'task.status',
      label: '看任务进展',
      description:
        '查后台任务的状态与进展：跑到哪一步了、做完没有、结果是什么。' +
        '用户问「任务到哪了」「你在干什么」「进展怎么样」时用它。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '可选：只看这一个任务' } },
        required: [],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const taskId = String(args?.taskId || '').trim();
        const all = tasks.list();
        const list = taskId ? all.filter((t) => t.taskId === taskId) : all;
        record('task.status', {
          taskId,
          action: list.length ? `看了看任务进展：${list.length} 个` : '看了看任务：没有',
        });
        if (!list.length) {
          return {
            text: taskId ? `没有这个任务：${taskId}` : '现在没有后台任务',
            data: { tasks: [] },
          };
        }
        return {
          text: list.map(describeTask).join('\n'),
          data: { tasks: list },
        };
      },
    },

    {
      name: 'task.cancel',
      label: '停掉后台任务',
      description: '停掉一个正在跑的后台任务。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务号' } },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要停哪个任务？给个 taskId');
        const res = tasks.cancel(taskId);
        if (!res?.ok) throw new Error(res?.message || '停不下来');
        record('task.cancel', { taskId, action: `停掉了个任务：${taskId}` });
        return { text: `已停掉任务 ${taskId}`, data: { taskId } };
      },
    },

    {
      name: 'task.delete',
      label: '归档后台任务',
      description: '把一个已经结束的任务从列表里归档（记录仍然留着）。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务号' } },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要归档哪个任务？给个 taskId');
        const res = tasks.archive(taskId);
        if (!res?.ok) throw new Error(res?.message || '归档不了');
        record('task.delete', { taskId, action: `归档了个任务：${taskId}` });
        return { text: `已归档任务 ${taskId}`, data: { taskId } };
      },
    },

    {
      name: 'task.steer',
      label: '给后台任务追加要求',
      description: '给一个正在跑的任务追加一句要求（不改它原本要做什么）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务号' },
          note: { type: 'string', description: '要追加的那句话' },
        },
        required: ['taskId', 'note'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const taskId = String(args?.taskId || '').trim();
        const note = String(args?.note || '').trim();
        if (!taskId) throw new Error('要给哪个任务追加要求？给个 taskId');
        if (!note) throw new Error('要追加什么？给个 note');
        const res = tasks.steer(taskId, note);
        if (!res?.ok) throw new Error(res?.message || '追加不了');
        // 任务刚好结束：那句追加没送出去（**不是错误**，是时序问题）。
        // 但要**如实说**——说成「已追加」的话，模型会跟着跟用户说谎。
        const dropped = Boolean(res.dropped);
        record('task.steer', {
          taskId,
          action: dropped
            ? '任务已经结束，追加的要求没送出去'
            : `给任务追加了一句要求：${note}`,
        });
        return {
          text: dropped
            ? `任务 ${taskId} 已经结束了，这句要求没送出去`
            : `已给任务 ${taskId} 追加要求`,
          data: { taskId, note },
        };
      },
    },
  ];
}

/** 把一个任务说成一行人话：谁、在干嘛、到哪一步了、结果是什么。 */
function describeTask(task) {
  const parts = [String(task?.taskId || ''), String(task?.title || '')];
  parts.push(STATUS_LABEL[task?.status] || String(task?.status || ''));
  if (task?.lastStep) parts.push(`刚做完 ${task.lastStep}`);
  if (task?.result) parts.push(`结果：${task.result}`);
  parts.push(`用了 ${formatElapsed(task?.elapsedMs)}`);
  return parts.filter(Boolean).join('｜');
}

/** 把毫秒说成「不到 1 秒」「12 秒」「3 分钟」。 */
function formatElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '一会儿';
  if (n < 1000) return '不到 1 秒';
  if (n < 60_000) return `${Math.round(n / 1000)} 秒`;
  return `${Math.round(n / 60_000)} 分钟`;
}
