/**
 * 聊天记录页面上的**纯逻辑**：把一条记录变成一行字。
 *
 * ## 为什么单独一个文件
 *
 * 页面脚本（history.js）一上来就绑界面（`bindSurface()`），
 * 在普通 node 里跑不起来（没有 `window`、没有 DOM）。
 * 而「一行字长什么样」是能测的——所以它搬到这里：
 * 不碰 DOM，规矩直接被测。
 */

/** 一行最多留多少字（参数预览太长就没法看了）。 */
const MAX_PREVIEW = 60;

/** 快工具的参数最多留多少字。 */
const MAX_ARG = 40;

/** 快工具的人话。 */
const FAST_TOOL_TEXT = {
  'clipboard.read': '调了一次剪贴板',
  'fs.read': '读了一个文件',
  'fs.list': '看了目录',
  'clock.now': '问了时间',
};

/** 任务状态的中文短句。 */
const STATUS_TEXT = {
  queued: '排队中',
  running: '进行中',
  waiting_approval: '等你点头',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** 块右上角的四种徽标。 */
const BADGE_TEXT = {
  answered: '已答',
  running: '后台运行中',
  done: '已完成',
  failed: '失败',
};

/** 审批的几种结果。 */
const DECISION_TEXT = {
  allow: '已允许',
  always: '已允许',
  deny: '已拒绝',
  cancel: '已取消',
  supersede: '没等到确认',
  pending: '还在等',
};

/**
 * 步骤的一行字。
 *
 * 规格 §10.4 画的是「`fs.list  src/`」——**工具名 + 它拿到的东西**。
 * 只画工具名的话，用户看到的是一串名字，看不出这个步骤到底做了什么。
 */
export function stepLabel(step) {
  const name = String(step?.text || step?.meta?.tool || '步骤');
  const preview = argsPreview(step?.meta?.args);
  return preview ? `${name}  ${preview}` : name;
}

/**
 * 参数的一行预览。
 *
 * 只看前两个参数、每个最多 60 字：一眼能看出「它动的是哪个文件」，
 * 又不会被一整屏的 JSON 淹掉。
 */
export function argsPreview(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) continue;
    parts.push(`${key}: ${text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text}`);
    if (parts.length >= 2) break;
  }
  return parts.join('  ');
}

/** 交底那一条明细的标题。 */
export const BRIEF_LABEL = '交底';

/** 工具没调成时的那句话。 */
export const TOOL_ERROR_LABEL = '这个工具这次没调成';

/** 孤儿块（没有对应的那句话）。 */
export const ORPHAN_LABEL = '没有对应的那句话';

/** 桌宠自己起的头。 */
export const PET_LABEL = '桌宠自己起的头';

/**
 * 快工具的人话。
 *
 * 工具名是给程序看的，页面上要说人话。
 * 参数只取第一个、截到 40 字——一眼看出它动了什么就够了。
 * 不认识的工具也**不把工具名印出来**——那串名字对用户没有意义。
 */
export function fastToolLabel(tool, args) {
  const name = String(tool || '');
  const base = FAST_TOOL_TEXT[name] || '做了个操作';
  const arg = firstArg(args);
  return arg ? `${base} ${arg}` : base;
}

/** 参数里的第一个值（截到 40 字）。 */
export function firstArg(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  for (const value of Object.values(args)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (!text) continue;
    return text.length > MAX_ARG ? `${text.slice(0, MAX_ARG)}…` : text;
  }
  return '';
}

/**
 * 派单的人话。
 *
 * 五个任务管理工具各有一句；不认识的工具显示它自己的动作原文。
 * **不显示任务号**——那是内部标识，用户看不懂。
 */
export function dispatchLabel(line) {
  const title = String(line?.title || '');
  switch (String(line?.tool || '')) {
    case 'task.submit':
      return title ? `派了个后台任务：${title}` : '派了个后台任务';
    case 'task.list':
      return '看了看后台任务';
    case 'task.cancel':
      return title ? `停掉了任务：${title}` : '停掉了那个后台任务';
    case 'task.delete':
      return title ? `归档了任务：${title}` : '归档了那个后台任务';
    case 'task.steer':
      return '给任务追加了一句要求';
    default:
      return String(line?.action || '') || '做了个后台操作';
  }
}

/** 任务状态的中文短句。 */
export function statusLabel(status) {
  return STATUS_TEXT[String(status || '')] || String(status || '');
}

/** 一个任务的状态流水（排队中 → 进行中）。 */
export function statusTrail(statuses) {
  const list = Array.isArray(statuses) ? statuses : [];
  const words = [];
  for (const status of list) {
    const word = statusLabel(status);
    if (!word) continue;
    if (words[words.length - 1] === word) continue;
    words.push(word);
  }
  return words.join(' → ');
}

/** 块右上角的徽标。 */
export function badgeLabel(badge) {
  return BADGE_TEXT[String(badge || '')] || '';
}

/** 「问模型 MiniMax-M2 · 3 轮」。 */
export function modelHeadLabel(model, rounds) {
  const name = String(model || '');
  const count = Number(rounds) || 0;
  return name ? `问模型 ${name} · ${count} 轮` : `问模型 · ${count} 轮`;
}

/** 「第 1 轮：我先看看剪贴板」。 */
export function modelRoundLabel(index, text) {
  const round = Number(index) || 0;
  const body = String(text || '');
  return round > 0 ? `第 ${round} 轮：${body}` : body;
}

/** 「步骤（3）」。 */
export function stepsLabel(count) {
  return `步骤（${Number(count) || 0}）`;
}

/** 执行层答复那一条明细的标题。 */
export const RESULT_LABEL = '结果';

/** 执行层答复的正文。 */
export function resultText(text) {
  return String(text || '');
}

/** 「查 F 盘 video · 进行中」。 */
export function taskLabel(title, status) {
  const name = String(title || '');
  const state = statusLabel(status);
  if (name && state) return `${name} · ${state}`;
  return name || state;
}

/** 审批的那句话。 */
export function approvalLabel(decision) {
  const text = DECISION_TEXT[String(decision || '')] || '';
  return text ? `有个操作${text}` : '有个操作等你点头';
}
