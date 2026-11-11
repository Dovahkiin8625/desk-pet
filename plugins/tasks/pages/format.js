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
 * 各状态有几个任务。
 *
 * **等着点头的算在跑里**：它还占着任务的位置。
 */
export function countByStatus(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const counts = { running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 };
  for (const task of list) {
    const status = task?.status;
    if (status === 'queued') counts.queued += 1;
    else if (status === 'done') counts.done += 1;
    else if (status === 'failed') counts.failed += 1;
    else if (status === 'cancelled') counts.cancelled += 1;
    else if (ACTIVE.has(status)) counts.running += 1;
  }
  return counts;
}

/** 还没结束吗（排队与等着点头也算）。 */
export function isActive(task) {
  return ACTIVE.has(task?.status);
}

/** 还没结束的任务（排队与等着点头也算）。 */
export function activeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list.filter((task) => isActive(task));
}

/**
 * 列表的顺序：在跑的排前面（新的在前），完了的排后面（新的在前）。
 *
 * 在跑的排前面是有道理的：跑着的任务可能是十分钟前派的，
 * 压在下面就看不见了。
 */
export function sortTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return [...list].sort((a, b) => {
    const rank = (t) => (isActive(t) ? 0 : 1);
    return rank(a) - rank(b) || Number(b?.createdAt || 0) - Number(a?.createdAt || 0);
  });
}

/**
 * 当前任务：最近起跑的那个还没结束的。
 *
 * 没有在跑的就空着——总览上那一栏就不画。
 */
export function currentTask(tasks) {
  const list = activeTasks(tasks);
  if (!list.length) return null;
  // 起跑时刻晚的在前；都还没起跑就按原来的顺序（新的在前）。
  return [...list].sort((a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0))[0];
}

/** 「14:23:05」（详情页上那一刻是什么时候）。 */
export function formatClock(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 「12 秒」「3 分 5 秒」「1 小时 2 分」——详情页的耗时。 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '一会儿';
  const s = Math.floor(n / 1000);
  if (s < 1) return '不到 1 秒';
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 任务号的前几位（完整号放悬停提示里）。 */
export function shortId(taskId) {
  const s = String(taskId || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * 参数的一行预览。
 *
 * 只看前两个键、每个最多 60 字：一眼能看出「它动的是哪个文件」，
 * 又不会被一整屏的 JSON 淹掉。
 */
export function argsPreview(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : safeJson(value);
    if (!text) continue;
    parts.push(`${key}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
    if (parts.length >= 2) break;
  }
  return parts.join('  ');
}

/**
 * 步骤节点：详情页那条竖向时间线上的一格。
 *
 * 一格说的是「这一刻做了什么」：什么工具、动了什么参数、结果是什么。
 */
export function stepNodes(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list.map((step) => ({
    index: Number(step?.index) || 0,
    tool: String(step?.tool || ''),
    // 有人话就用它（外部 harness 的步骤说「claude code 调了 Read」）。
    label: String(step?.label || ''),
    time: formatClock(step?.at),
    args: argsPreview(step?.args),
    result: String(step?.result || ''),
    error: String(step?.error || ''),
    failed: Boolean(step?.error),
  }));
}

/** 结果或失败的那句话。 */
export function resultText(task) {
  const error = String(task?.error || '');
  if (error) return `失败：${error}`;
  return String(task?.result || '');
}

/** 上次退出时中断了几个任务（从聊天记录里数）。 */
export function countInterrupted(records) {
  const list = Array.isArray(records) ? records : [];
  return list.filter((r) => r?.kind === 'task' && r?.meta?.status === 'interrupted').length;
}

/** JSON.stringify 不炸的那一版。 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
