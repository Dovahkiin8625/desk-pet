/**
 * 后台任务板的纯逻辑。
 *
 * 页面（board.js）与插件（main.js）都用这里的东西：
 * 状态的中文说法、耗时的说法、快照怎么分组。
 *
 * **不碰 DOM**：这样能单测（见 test/unit/tasks-format.test.js）。
 */

/** 任务状态的中文说法（人看的那份）。 */
export const STATUS_TEXT = Object.freeze({
  queued: '排队中',
  running: '进行中',
  waiting_approval: '等你点头',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '被中断',
});

/** 还没结束的状态（等着点头的也算：它还占着任务的位置）。 */
const ACTIVE = new Set(['queued', 'running', 'waiting_approval']);

/** 状态的中文说法。 */
export function statusText(status) {
  return STATUS_TEXT[status] || String(status || '');
}

/** 把毫秒说成「不到 1 秒」「12 秒」「3 分钟」。 */
export function formatElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '一会儿';
  if (n < 1000) return '不到 1 秒';
  if (n < 60_000) return `${Math.round(n / 1000)} 秒`;
  return `${Math.round(n / 60_000)} 分钟`;
}

/** 「第 3 步 · fs.list」（没走到那一步就只说工具名）。 */
export function stepLabel(task) {
  const index = Number(task?.stepIndex) || 0;
  const step = String(task?.lastStep || '');
  if (!index) return step;
  if (!step) return `第 ${index} 步`;
  return `第 ${index} 步 · ${step}`;
}

/**
 * 快照分组：待答 / 在跑 / 已结束。
 *
 * @param {object} snapshot { tasks, approvals }
 */
export function groupSnapshot(snapshot) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const approvals = Array.isArray(snapshot?.approvals) ? snapshot.approvals : [];
  return {
    pending: approvals,
    running: tasks.filter((task) => ACTIVE.has(task?.status)),
    finished: tasks.filter((task) => !ACTIVE.has(task?.status)),
  };
}

/**
 * 在跑几个（含等着点头的）、排队几个。
 *
 * 归档的不算——它压根不在列表里。
 */
export function countTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  let running = 0;
  let queued = 0;
  for (const task of list) {
    if (task?.status === 'queued') queued += 1;
    else if (ACTIVE.has(task?.status)) running += 1;
  }
  return { running, queued };
}

/** 上次退出时中断了几个任务（从聊天记录里数）。 */
export function countInterrupted(records) {
  const list = Array.isArray(records) ? records : [];
  return list.filter((r) => r?.kind === 'task' && r?.meta?.status === 'interrupted').length;
}
