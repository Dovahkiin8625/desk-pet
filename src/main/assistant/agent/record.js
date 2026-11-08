import {
  APPROVAL_DECISION,
  CHAT_KIND,
  TASK_FINAL_STATUS,
  TASK_STATUS,
} from '../../../shared/assistant.js';

/**
 * agent 的分类记录（规格 §4.2）。
 *
 * 聊天记录现在有六种分类：user / reply / task / step / approval / dispatch。
 * user 与 reply 是**给模型看的**；task / step / approval 是**给人看的**——
 * 它们绝不能进模型上下文（见 chat/prompt.js 的过滤）。
 * dispatch 两头不一样：交互层看得见、执行层看不见（见 shared 的 `CHAT_KIND_FOR_LAYER`）。
 *
 * 这里只造条目，不落盘：落盘走 chat/memory.js 的 `appendMessage`，
 * 那边的分路截断才对（一条新步骤不该把最老的用户输入挤掉）。
 */

/** 任务状态的中文短句（给记录与气泡用）。 */
export const TASK_STATUS_TEXT = Object.freeze({
  [TASK_STATUS.QUEUED]: '排队中',
  [TASK_STATUS.RUNNING]: '进行中',
  [TASK_STATUS.WAITING_APPROVAL]: '等你点头',
  [TASK_STATUS.DONE]: '完成',
  [TASK_STATUS.FAILED]: '失败',
  [TASK_STATUS.CANCELLED]: '已取消',
  [TASK_STATUS.INTERRUPTED]: '已中断',
});

/** 任务状态变化的一条记录。 */
export function taskRecord({ taskId = '', status = '', title = '', at = Date.now() } = {}) {
  const label = TASK_STATUS_TEXT[status] || String(status || '');
  return {
    kind: CHAT_KIND.TASK,
    role: 'assistant',
    text: title ? `${label} · ${title}` : label,
    at,
    meta: { taskId, status, title },
  };
}

/** 任务中的一次工具调用。 */
export function stepRecord({
  taskId = '',
  index = 0,
  tool = '',
  args = null,
  result = '',
  error = '',
  at = Date.now(),
} = {}) {
  const name = String(tool || '工具');
  return {
    kind: CHAT_KIND.STEP,
    role: 'assistant',
    text: error ? `${name} 出错：${error}` : name,
    at,
    meta: { taskId, index, tool: name, args, result, error },
  };
}

/**
 * 审批决议的中文短句（给记录看）。
 *
 * 「没等到确认」与「已拒绝」必须分开：
 * 用户没点过按钮的事，不能记成他拒绝了。
 */
const APPROVAL_LABEL = Object.freeze({
  [APPROVAL_DECISION.PENDING]: '等你点头',
  [APPROVAL_DECISION.ALLOW]: '已允许',
  [APPROVAL_DECISION.ALWAYS]: '本任务内自动放行',
  [APPROVAL_DECISION.DENY]: '已拒绝',
  [APPROVAL_DECISION.CANCEL]: '用户取消了任务',
  [APPROVAL_DECISION.SUPERSEDE]: '未确认',
});

/** 一次审批请求与它的决议。 */
export function approvalRecord({
  taskId = '',
  tool = '',
  args = null,
  risk = '',
  decision = '',
  at = Date.now(),
} = {}) {
  const name = String(tool || '工具');
  const label = APPROVAL_LABEL[decision] || '未确认';
  return {
    kind: CHAT_KIND.APPROVAL,
    role: 'assistant',
    text: `${name}：${label}`,
    at,
    meta: { taskId, tool: name, args, risk, decision },
  };
}

/** 到终态的状态：这些任务不用再管了。 */
const FINAL_STATUS = new Set(TASK_FINAL_STATUS);

/**
 * 找出**上次退出时还在跑**的任务（规格 §7.4）。
 *
 * 任务本体不持久化：跑着的 shell 子进程在应用退出时已经死了，
 * 假装能恢复是自欺欺人。所以在记录里标一句「已中断」就够了。
 *
 * 判据：每个任务号**最后一条**状态记录不是终态 → 它当时还在跑。
 */
export function interruptedTasks(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const latest = new Map();
  for (const item of list) {
    if (item?.kind !== CHAT_KIND.TASK) continue;
    const taskId = String(item?.meta?.taskId || '');
    if (!taskId) continue;
    latest.set(taskId, {
      taskId,
      title: String(item?.meta?.title || ''),
      status: String(item?.meta?.status || ''),
    });
  }
  return [...latest.values()].filter((t) => !FINAL_STATUS.has(t.status));
}

/**
 * 交互层的一次任务管理调用（派单 / 查看 / 停止 / 归档 / 追加指令）。
 *
 * **正文里必须带任务号**：交互层下一轮要靠它说「停掉刚才那个」——
 * 没有任务号，它只能瞎猜一个。
 */
export function dispatchRecord({
  tool = '',
  taskId = '',
  title = '',
  action = '',
  at = Date.now(),
} = {}) {
  const name = String(tool || '任务');
  const id = String(taskId || '');
  const parts = [name, action];
  if (id) parts.push(`（任务 ${id}）`);
  return {
    kind: CHAT_KIND.DISPATCH,
    role: 'assistant',
    text: parts.filter(Boolean).join(' '),
    at,
    meta: { tool: name, taskId: id, title: String(title || ''), action: String(action || '') },
  };
}
