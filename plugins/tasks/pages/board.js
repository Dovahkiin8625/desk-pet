import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { formatElapsed, groupSnapshot, statusText, stepLabel } from './format.js';

/**
 * 后台任务板。
 *
 * 同一个页面文件当三处用：面板页、独立窗口、桌面小部件。
 * 靠 `surface.mode` 切布局（`body.dp-widget`）。
 *
 * ## 重画的方式
 *
 * **就地更新**：按 taskId 复用行节点，只改变了的那几个字。
 * 整页重画会把用户正在输入的「追加要求」抹掉，
 * 也会把刚展开的行收起来（聊天记录页面踩过这个坑）。
 */

const surface = bindSurface();

document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));
document.body.classList.toggle('dp-widget', surface.mode === 'widget');

const wrapEl = document.getElementById('wrap');
const pendingEl = document.getElementById('pending');
const runningEl = document.getElementById('running');
const finishedEl = document.getElementById('finished');
const pendingSec = document.getElementById('pending-sec');
const runningSec = document.getElementById('running-sec');
const finishedSec = document.getElementById('finished-sec');
const countsEl = document.getElementById('counts');
const interruptedEl = document.getElementById('interrupted');
const emptyEl = document.getElementById('empty');
const messageEl = document.getElementById('message');

/** taskId → 行（复用，不重画）。 */
const activeRows = new Map();
const finishedRows = new Map();
/** 审批 id → 卡片。 */
const cards = new Map();
/** 展开着的是哪些任务（键是 taskId）。 */
const expanded = new Set();
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

/** 在跑与排队的一行。 */
function createActiveRow() {
  const row = el('div', 'row');
  const head = el('div', 'row-head');
  const dot = el('span', 'dot');
  const title = el('span', 'row-title');
  const status = el('span', 'row-status');
  const time = el('span', 'row-time');
  head.append(dot, title, status, time);

  const step = el('div', 'row-step');
  const actions = el('div', 'row-actions');
  const cancel = el('button', 'dp-button', '停掉');
  cancel.dataset.act = 'cancel';
  const steer = el('button', 'dp-button', '追加要求');
  steer.dataset.act = 'steer';
  actions.append(cancel, steer);

  const steerBox = el('div', 'steer-box');
  steerBox.hidden = true;
  const input = el('input', 'dp-input');
  input.type = 'text';
  input.dataset.role = 'steer';
  input.placeholder = '要追加的一句话';
  const send = el('button', 'dp-button', '发送');
  send.dataset.act = 'steer-send';
  steerBox.append(input, send);

  row.append(head, step, actions, steerBox);
  return { row, dot, title, status, time, step, steerBox, input };
}

/** 已结束的一行（可展开）。 */
function createFinishedRow(taskId) {
  const row = el('div', 'row');
  row.dataset.task = taskId;
  const detail = el('details', 'row-detail');
  const head = el('summary', 'row-head');
  const dot = el('span', 'dot');
  const title = el('span', 'row-title');
  const status = el('span', 'row-status');
  const time = el('span', 'row-time');
  head.append(dot, title, status, time);

  const body = el('div', 'row-body');
  detail.append(head, body);

  const actions = el('div', 'row-actions');
  const archive = el('button', 'dp-button', '归档');
  archive.dataset.act = 'archive';
  actions.append(archive);

  row.append(detail, actions);
  detail.open = expanded.has(taskId);
  detail.addEventListener('toggle', () => {
    const id = row.dataset.task;
    if (!id) return;
    if (detail.open) expanded.add(id);
    else expanded.delete(id);
  });
  return { row, detail, dot, title, status, time, body, actions, archive };
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

/**
 * 对齐一栏的行：复用已有的节点，多的删掉。
 *
 * **顺序不动**：新行接在后面。整栏重排会把用户正在输入的输入框挪走，
 * 焦点就没了。
 */
function syncRows(container, map, list, create, update) {
  const seen = new Set();
  for (const task of list) {
    const id = String(task?.taskId || '');
    if (!id) continue;
    seen.add(id);
    let view = map.get(id);
    if (!view) {
      view = create(id);
      map.set(id, view);
      container.appendChild(view.row);
    }
    update(view, task);
  }
  for (const [id, view] of [...map]) {
    if (seen.has(id)) continue;
    map.delete(id);
    view.row.remove();
  }
}

/** 一份快照画上去。 */
function render(payload) {
  if (!payload) return;
  // 快照是真相：本地刚改的状态到这儿就作废了。
  localStatus.clear();

  const { pending, running, finished } = groupSnapshot(payload);
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const titleOf = (taskId) => {
    const task = tasks.find((t) => t?.taskId === taskId);
    return task?.title || taskId || '';
  };

  syncRows(
    runningEl,
    activeRows,
    running,
    () => createActiveRow(),
    (view, task) => {
      const status = statusOf(task);
      view.row.dataset.task = task.taskId;
      view.dot.dataset.status = status;
      view.title.textContent = task.title || task.taskId;
      view.status.textContent = statusText(status);
      view.time.textContent = formatElapsed(task.elapsedMs);
      const step = stepLabel(task);
      view.step.textContent = step;
      view.step.hidden = !step;
    }
  );

  syncRows(
    finishedEl,
    finishedRows,
    finished,
    (id) => createFinishedRow(id),
    (view, task) => {
      const status = statusOf(task);
      view.row.dataset.task = task.taskId;
      view.dot.dataset.status = status;
      view.title.textContent = task.title || task.taskId;
      view.status.textContent = statusText(status);
      view.time.textContent = formatElapsed(task.elapsedMs);
      const body = task.error ? `失败：${task.error}` : String(task.result || '');
      view.body.textContent = body;
      view.body.classList.toggle('row-error', Boolean(task.error));
      view.body.hidden = !body;
    }
  );

  // 待答的审批：一张卡片一张。
  const seenCards = new Set();
  for (const approval of pending) {
    const id = String(approval?.id || '');
    if (!id) continue;
    seenCards.add(id);
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
    if (seenCards.has(id)) continue;
    cards.delete(id);
    view.card.remove();
  }

  const counts = payload.counts || {};
  countsEl.textContent = `${counts.running || 0} 在跑 · ${counts.queued || 0} 排队`;
  const interrupted = Number(payload.interrupted) || 0;
  interruptedEl.hidden = !interrupted;
  interruptedEl.textContent = interrupted ? `上次有 ${interrupted} 个任务被中断` : '';

  pendingSec.hidden = !pending.length;
  runningSec.hidden = !running.length;
  finishedSec.hidden = !finished.length;
  emptyEl.hidden = Boolean(tasks.length || pending.length);

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
    const view = activeRows.get(payload.taskId) || finishedRows.get(payload.taskId);
    view?.row.remove();
    activeRows.delete(payload.taskId);
    finishedRows.delete(payload.taskId);
  }
  if (ok && actionId === 'answer') {
    const view = cards.get(payload.id);
    view?.card.remove();
    cards.delete(payload.id);
  }
  messageEl.textContent = String(res?.message || '');
  return res;
}

/** 追加要求：把那句话送出去。 */
async function sendSteer(row, taskId) {
  const input = row.querySelector('input[data-role="steer"]');
  const note = String(input?.value || '').trim();
  if (!note) return;
  input.value = '';
  await act('steer', { taskId, note });
}

wrapEl.addEventListener('click', (event) => {
  const button = event.target.closest?.('button[data-act]');
  if (!button) return;
  const row = button.closest('[data-task]');
  const taskId = row?.dataset.task || '';
  const actionId = button.dataset.act;
  if (actionId === 'cancel') {
    void act('cancel', { taskId });
    return;
  }
  if (actionId === 'archive') {
    void act('archive', { taskId });
    return;
  }
  if (actionId === 'steer') {
    const view = activeRows.get(taskId);
    if (view) view.steerBox.hidden = !view.steerBox.hidden;
    return;
  }
  if (actionId === 'steer-send') {
    void sendSteer(row, taskId);
    return;
  }
  if (actionId === 'answer') {
    const card = button.closest('[data-approval]');
    void act('answer', { id: card?.dataset.approval || '', decision: button.dataset.decision || '' });
  }
});

wrapEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const input = event.target.closest?.('input[data-role="steer"]');
  if (!input) return;
  event.preventDefault();
  const row = input.closest('[data-task]');
  void sendSteer(row, row?.dataset.task || '');
});

// 首份快照：打开时给一次。
void surface.data().then((payload) => render(payload));

// 之后的快照：每秒一份。
surface.onData((payload) => render(payload));
surface.onTick((payload) => render(payload));
