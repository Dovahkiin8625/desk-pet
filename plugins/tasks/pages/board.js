import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import {
  activeTasks,
  countByStatus,
  currentTask,
  formatClock,
  formatDuration,
  formatElapsed,
  isActive,
  resultText,
  shortId,
  sortTasks,
  statusText,
  stepLabel,
  stepNodes,
} from './format.js';

/**
 * 后台任务板。
 *
 * 同一个页面文件当三处用：面板页、独立窗口、桌面小部件。
 * 靠 `surface.mode` 切布局（`body.dp-widget`）。
 *
 * ## 两层
 *
 * - **总览**：计数、当前任务、待你点头的审批、任务列表；
 * - **详情**：点开某一个任务——创建时刻、耗时、结果、竖向的步骤时间线。
 *
 * ## 重画的方式
 *
 * **就地更新**：按 taskId 复用行节点，只改变了的那几个字。
 * 整页重画会把用户正在输入的「追加要求」抹掉，
 * 也会把刚展开的行收起来（聊天记录页面踩过这个坑）。
 */

const surface = bindSurface();

const isWidget = surface.mode === 'widget';
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));
document.body.classList.toggle('dp-widget', isWidget);

// 小部件的头用共享的那份样式（与系统监控的小部件一个样）。
if (isWidget) document.getElementById('head').classList.add('dp-widget-head');

const wrapEl = document.getElementById('wrap');
const overviewEl = document.getElementById('overview');
const detailEl = document.getElementById('detail');
const countsEl = document.getElementById('counts');
const interruptedEl = document.getElementById('interrupted');
const emptyEl = document.getElementById('empty');
const messageEl = document.getElementById('message');
const currentSecEl = document.getElementById('current-sec');
const currentEl = document.getElementById('current');
const pendingSecEl = document.getElementById('pending-sec');
const pendingEl = document.getElementById('pending');
const tasksSecEl = document.getElementById('tasks-sec');
const tasksEl = document.getElementById('tasks');
const detailTitleEl = document.getElementById('detail-title');
const detailIdEl = document.getElementById('detail-id');
const detailMetaEl = document.getElementById('detail-meta');
const detailResultEl = document.getElementById('detail-result');
const detailCancelEl = document.getElementById('detail-cancel');
const detailArchiveEl = document.getElementById('detail-archive');
const detailSteerEl = document.getElementById('detail-steer');
const detailNoteEl = document.getElementById('detail-note');
const stepsEl = document.getElementById('detail-steps');

/** 现在看哪一层：总览还是详情。 */
let view = 'overview';
/** 详情页在看哪个任务。 */
let selectedId = '';
/** 最近一份快照。 */
let lastPayload = null;
/** taskId → 行（复用，不重画）。 */
const rows = new Map();
/** 审批 id → 卡片。 */
const cards = new Map();
/** 步骤序号 → 节点（复用，不重画）。 */
const stepViews = new Map();
/** 刚做过的本地状态：下一秒的快照会覆盖它。 */
const localStatus = new Map();

/** 一个元素。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** 任务现在的状态（本地刚改过的优先）。 */
function statusOf(task) {
  return localStatus.get(task?.taskId) || task?.status || '';
}

/** 计数那一行。 */
function countsLine(counts, compact) {
  const parts = [];
  const add = (n, label) => {
    if (n) parts.push(`${n} ${label}`);
  };
  add(counts.running, '在跑');
  add(counts.queued, '排队');
  if (compact) {
    add(counts.failed, '失败');
  } else {
    add(counts.done, '已完成');
    add(counts.failed, '失败');
    add(counts.cancelled, '已取消');
  }
  return parts.join(' · ');
}

/** 一行任务。 */
function createRow() {
  const row = el('div', 'row');
  const head = el('div', 'row-head');
  const dot = el('span', 'dot');
  const title = el('span', 'row-title');
  const id = el('span', 'row-id');
  const tag = el('span', 'tag');
  const time = el('span', 'row-time');
  head.append(dot, title, id, tag, time);

  const sub = el('div', 'row-sub');
  const step = el('span', 'row-step');
  const actions = el('div', 'row-actions');
  const cancel = el('button', 'dp-button', '停掉');
  cancel.dataset.act = 'cancel';
  actions.append(cancel);
  sub.append(step, actions);

  row.append(head, sub);
  return { row, dot, title, id, tag, time, step, cancel };
}

/** 把一行画成任务现在的样子。 */
function updateRow(view, task) {
  const status = statusOf(task);
  view.row.dataset.task = task.taskId;
  view.dot.dataset.status = status;
  view.title.textContent = task.title || task.taskId;
  view.id.textContent = `#${shortId(task.taskId)}`;
  view.id.title = task.taskId;
  view.tag.textContent = statusText(status);
  view.tag.dataset.status = status;
  view.time.textContent = formatElapsed(task.elapsedMs);
  const step = stepLabel(task);
  view.step.textContent = step;
  view.step.hidden = !step;
  // 完了的任务没什么可停的。
  view.cancel.hidden = !isActive(task);
}

/**
 * 对齐任务列表：复用已有的节点，多的删掉，顺序跟着列表走。
 *
 * **顺序会变**：跑着的任务排在前面（它可能是十分钟前派的）。
 */
function syncRows(list) {
  const seen = new Set();
  let prev = null;
  for (const task of list) {
    const id = String(task?.taskId || '');
    if (!id) continue;
    seen.add(id);
    let view = rows.get(id);
    if (!view) {
      view = createRow();
      rows.set(id, view);
    }
    updateRow(view, task);
    // 放在前一个后面：位置不对就挪过去（挪的是节点，状态都还在）。
    const target = prev ? prev.nextSibling : tasksEl.firstChild;
    if (view.row !== target) tasksEl.insertBefore(view.row, target);
    prev = view.row;
  }
  for (const [id, view] of [...rows]) {
    if (seen.has(id)) continue;
    rows.delete(id);
    view.row.remove();
  }
}

/** 当前任务：总览顶上那一栏。 */
const currentCard = { card: null, title: null, step: null };

function renderCurrent(task) {
  if (!currentCard.card) {
    const card = el('div', 'current');
    const title = el('div', 'current-title');
    const step = el('div', 'current-step');
    card.append(title, step);
    currentEl.appendChild(card);
    currentCard.card = card;
    currentCard.title = title;
    currentCard.step = step;
  }
  currentCard.card.dataset.task = task.taskId;
  currentCard.title.textContent = task.title || task.taskId;
  const step = stepLabel(task);
  currentCard.step.textContent = step;
  currentCard.step.hidden = !step;
}

/** 待答审批的一张卡片。 */
function createCard() {
  const card = el('div', 'card');
  const text = el('div', 'card-text');
  const task = el('div', 'card-task');
  const actions = el('div', 'card-actions');
  for (const item of [
    { decision: 'allow', text: '允许' },
    { decision: 'deny', text: '拒绝' },
    { decision: 'always', text: '自动' },
    { decision: 'cancel', text: '取消任务' },
  ]) {
    const button = el('button', 'dp-button', item.text);
    button.dataset.act = 'answer';
    button.dataset.decision = item.decision;
    actions.append(button);
  }
  card.append(text, task, actions);
  return { card, text, task };
}

/** 对齐审批卡片：来一张画一张，走了一张收走。 */
function syncCards(approvals, tasks) {
  const titleOf = (taskId) => {
    const task = tasks.find((t) => String(t?.taskId || '') === String(taskId || ''));
    return task?.title || '';
  };
  const seen = new Set();
  for (const approval of approvals) {
    const id = String(approval?.id || '');
    if (!id) continue;
    seen.add(id);
    let view = cards.get(id);
    if (!view) {
      view = createCard();
      cards.set(id, view);
      pendingEl.appendChild(view.card);
    }
    view.card.dataset.approval = id;
    view.text.textContent = String(approval.text || '');
    view.task.textContent = titleOf(approval.taskId);
  }
  for (const [id, view] of [...cards]) {
    if (seen.has(id)) continue;
    cards.delete(id);
    view.card.remove();
  }
}

/** 步骤时间线上的一格。 */
function createStepNode() {
  const item = el('li', 'tl-item');
  const head = el('div', 'tl-head');
  const time = el('span', 'tl-time');
  const tool = el('span', 'tl-tool');
  head.append(time, tool);
  const args = el('div', 'tl-args');
  const result = el('div', 'tl-result');
  item.append(head, args, result);
  return { item, time, tool, args, result };
}

/** 对齐步骤时间线：新长出来的一格接在后面。 */
function syncSteps(steps) {
  const nodes = stepNodes(steps);
  const seen = new Set();
  let prev = null;
  for (const node of nodes) {
    const key = String(node.index);
    seen.add(key);
    let view = stepViews.get(key);
    if (!view) {
      view = createStepNode();
      stepViews.set(key, view);
    }
    view.item.dataset.failed = node.failed ? 'true' : 'false';
    view.time.textContent = node.time;
    view.tool.textContent = node.label || node.tool;
    view.args.textContent = node.args;
    view.args.hidden = !node.args;
    const body = node.failed ? node.error : node.result;
    view.result.textContent = body;
    view.result.hidden = !body;
    const target = prev ? prev.nextSibling : stepsEl.firstChild;
    if (view.item !== target) stepsEl.insertBefore(view.item, target);
    prev = view.item;
  }
  for (const [key, view] of [...stepViews]) {
    if (seen.has(key)) continue;
    stepViews.delete(key);
    view.item.remove();
  }
}

/** 总览层。 */
function renderOverview(payload, tasks) {
  countsEl.textContent = countsLine(countByStatus(tasks), isWidget);

  const current = currentTask(tasks);
  currentSecEl.hidden = !current;
  if (current) renderCurrent(current);

  const approvals = Array.isArray(payload.approvals) ? payload.approvals : [];
  syncCards(approvals, tasks);
  pendingSecEl.hidden = !approvals.length;

  // 小部件地方小：只看在跑的。
  const list = sortTasks(isWidget ? activeTasks(tasks) : tasks);
  syncRows(list);
  tasksSecEl.hidden = !list.length;

  const interrupted = Number(payload.interrupted) || 0;
  interruptedEl.hidden = !interrupted;
  interruptedEl.textContent = interrupted ? `上次有 ${interrupted} 个任务被中断` : '';

  emptyEl.hidden = isWidget ? list.length > 0 : Boolean(tasks.length || approvals.length);
}

/** 详情层。 */
function renderDetail(tasks) {
  const task = tasks.find((t) => String(t?.taskId || '') === selectedId);
  if (!task) return;
  const status = statusOf(task);
  const active = isActive(task);

  detailTitleEl.textContent = task.title || task.taskId;
  detailIdEl.textContent = `#${shortId(task.taskId)}`;
  detailIdEl.title = task.taskId;

  const parts = [statusText(status)];
  const created = formatClock(task.createdAt);
  if (created) parts.push(`创建于 ${created}`);
  parts.push(active ? `已用 ${formatDuration(task.elapsedMs)}` : `耗时 ${formatDuration(task.elapsedMs)}`);
  detailMetaEl.textContent = parts.join(' · ');

  const result = resultText(task);
  detailResultEl.textContent = result;
  detailResultEl.hidden = !result;
  detailResultEl.classList.toggle('is-error', Boolean(task.error));

  detailCancelEl.hidden = !active;
  detailArchiveEl.hidden = active;
  detailSteerEl.hidden = !active;

  syncSteps(task.steps || []);
}

/** 一份快照画上去。 */
function render(payload) {
  if (!payload) return;
  lastPayload = payload;
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];

  // 详情页看的那个任务没了（归档了）：回总览。
  if (view === 'detail' && !tasks.some((t) => String(t?.taskId || '') === selectedId)) {
    view = 'overview';
    selectedId = '';
  }
  overviewEl.hidden = view !== 'overview';
  detailEl.hidden = view !== 'detail';

  if (view === 'detail') renderDetail(tasks);
  else renderOverview(payload, tasks);

  // 本地刚改的状态这一轮用完了：作废，下一秒听快照的。
  localStatus.clear();
  reportHeight();
}

/** 报高度：面板的窗口是按内容撑开的。 */
function reportHeight() {
  requestAnimationFrame(() => {
    const rect = document.body.getBoundingClientRect();
    surface.setHeight(Math.ceil(Math.max(rect.height, document.body.scrollHeight)));
  });
}

/** 做一件事，把结果说出来。 */
async function act(actionId, payload) {
  const res = await surface.act(actionId, payload);
  const ok = Boolean(res?.ok);
  if (ok && actionId === 'cancel') localStatus.set(payload.taskId, 'cancelled');
  if (ok && actionId === 'archive') {
    const row = rows.get(payload.taskId);
    row?.row.remove();
    rows.delete(payload.taskId);
    if (selectedId === payload.taskId) {
      view = 'overview';
      selectedId = '';
    }
  }
  if (ok && actionId === 'answer') {
    const card = cards.get(payload.id);
    card?.card.remove();
    cards.delete(payload.id);
  }
  messageEl.textContent = String(res?.message || '');
  return res;
}

/** 追加要求：把那句话送出去。 */
async function sendSteer(taskId) {
  const note = String(detailNoteEl.value || '').trim();
  if (!note || !taskId) return;
  detailNoteEl.value = '';
  await act('steer', { taskId, note });
}

/** 进详情。 */
function openDetail(taskId) {
  if (!taskId || !lastPayload) return;
  if (selectedId !== taskId) {
    selectedId = taskId;
    detailNoteEl.value = '';
  }
  view = 'detail';
  render(lastPayload);
}

/** 回总览。 */
function backToOverview() {
  view = 'overview';
  selectedId = '';
  if (lastPayload) render(lastPayload);
}

document.getElementById('detail-back').addEventListener('click', () => {
  backToOverview();
});

wrapEl.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-act]');
  if (button) {
    const actionId = button.dataset.act;
    if (actionId === 'answer') {
      const card = button.closest('[data-approval]');
      void act('answer', { id: card?.dataset.approval || '', decision: button.dataset.decision || '' });
      return;
    }
    if (actionId === 'steer-send') {
      void sendSteer(selectedId);
      return;
    }
    // 停掉与归档：总览的行上有点，详情层里也有。
    const row = button.closest('[data-task]');
    const taskId = row?.dataset.task || selectedId;
    if (actionId === 'cancel') {
      void act('cancel', { taskId });
      return;
    }
    if (actionId === 'archive') {
      void act('archive', { taskId });
    }
    return;
  }
  // 点一行：进详情（小部件太小，只看总览）。
  const row = event.target.closest?.('[data-task]');
  if (!row || isWidget) return;
  openDetail(row.dataset.task || '');
});

wrapEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (event.target !== detailNoteEl) return;
  event.preventDefault();
  void sendSteer(selectedId);
});

// 小部件的两个按钮：变回独立窗口、收起来。
// （面板与独立窗口里这两个按钮不显示，壳已经有一份了。）
document.getElementById('widget-expand').addEventListener('click', () => {
  window.plugin?.window?.setMode?.('window');
});
document.getElementById('widget-close').addEventListener('click', () => {
  window.plugin?.window?.close?.();
});

// 小部件里没有任务列表可点：空的时候说的是另一句话。
if (isWidget) emptyEl.textContent = '现在没有在跑的任务';

// 首份快照：打开时给一次。
void surface.data().then((payload) => render(payload));

// 之后的快照：每秒一份。
surface.onData((payload) => render(payload));
surface.onTick((payload) => render(payload));
