import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { buildTurns } from './turns.js';
import { createEntryStore } from './entries.js';
import {
  approvalLabel,
  approvalLineLabel,
  argsPreview,
  badgeLabel,
  BRIEF_LABEL,
  dispatchLabel,
  fastToolLabel,
  modelHeadLabel,
  modelRoundLabel,
  ORPHAN_LABEL,
  PET_LABEL,
  RESULT_LABEL,
  resultText,
  statusTrail,
  stepLabel,
  stepsLabel,
  TOOL_ERROR_LABEL,
  taskLineLabel,
} from './format.js';

/**
 * 聊天记录的页面。
 *
 * 页面按**三层折叠**画：
 * - 块：一次发话（什么时候开的、有没有后台任务在跑）；
 * - 段：桌宠这边 / 后台那边；
 * - 明细：模型每一轮、工具参数与结果、交底、后台步骤。
 *
 * **不用 innerHTML**：记录里全是用户与模型的原话，
 * 直接拼进 HTML 就是一个注入的口子。用 createElement + textContent。
 */

const surface = bindSurface();

// 面板里与独立窗口里，高度策略是**相反**的（见 pluginPage.js）。
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

/** 现在有哪些记录（记账的规矩在 entries.js 里）。 */
const store = createEntryStore();

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');

/** 每一项的展开状态（键见 detailKey）。 */
const openStates = new Map();

/** 用户亲手改过展开状态的项——它们不再受默认值摆布。 */
const touched = new Set();

/** 这一轮画出来的块（按 id 找徽标，用来看默认展不展开）。 */
const turnsById = new Map();

/** 一个元素。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** 时刻写成 HH:MM。 */
function timeLabel(at) {
  const date = new Date(Number(at) || 0);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 一项的状态键。
 *
 * 块用记录 id（不是序号）——序号会随着新记录进来而变，
 * 记在序号上的展开状态就认错了地方。
 * 明细在块之内还要再带一个序号：同一块里可能有两次调同一个工具。
 */
function detailKey(node, turnEl) {
  if (node.dataset.turn) return `turn::${node.dataset.turn}`;
  const turn = turnEl || node.closest('[data-turn]');
  const turnId = turn ? turn.dataset.turn : '';
  const name = node.dataset.detail || '';
  const same = turn ? [...turn.querySelectorAll('details[data-detail]')].filter((d) => d.dataset.detail === name) : [];
  const index = same.indexOf(node);
  return `detail::${turnId}::${name}::${index}`;
}

/** 把一页里的每一项都配上状态键。 */
function assignKeys(root) {
  const keys = new Map();
  for (const turn of root.querySelectorAll('details[data-turn]')) {
    keys.set(turn, detailKey(turn, turn));
    for (const node of turn.querySelectorAll('details[data-detail]')) {
      keys.set(node, detailKey(node, turn));
    }
  }
  return keys;
}

/** 默认展开：后台还在跑的块展开着，其余折起；明细一律折起。 */
function defaultOpen(node, key) {
  if (node.dataset.turn) {
    const turn = turnsById.get(node.dataset.turn);
    return Boolean(turn) && turn.badge === 'running';
  }
  void key;
  return false;
}

/**
 * 记住用户正在看的样子。
 *
 * **为什么要记**：记录是**实时**进来的——任务在跑的时候一秒一条。
 * 每来一条就重画整个列表的话，用户展开的东西会被收起来，
 * 视线也会被拽走：他刚展开想看的内容，一眨眼就没了。
 */
function captureView() {
  const keys = assignKeys(listEl);
  for (const [node, key] of keys) {
    openStates.set(key, node.open);
  }
  const scroller = document.scrollingElement || document.documentElement;
  return {
    top: scroller ? scroller.scrollTop : 0,
    height: scroller ? scroller.scrollHeight : 0,
  };
}

/** 把用户正在看的样子还回去。 */
function restoreView(view) {
  const keys = assignKeys(listEl);
  for (const [node, key] of keys) {
    if (touched.has(key)) {
      node.open = Boolean(openStates.get(key));
      continue;
    }
    node.open = defaultOpen(node, key);
  }
  const scroller = document.scrollingElement || document.documentElement;
  if (!scroller) return;
  // 新的在上面：内容长高了同样的量，滚动位置跟着往下挪同样多，
  // 他正在看的那一条就停在原地。
  requestAnimationFrame(() => {
    const delta = scroller.scrollHeight - view.height;
    scroller.scrollTop = view.top + delta;
  });
}

/** 桌宠这边的一行行。 */
function renderFront(turn) {
  const lane = el('section', 'lane lane-front');
  lane.appendChild(el('h3', 'lane-title', '桌宠这边'));

  const replies = turn.front.filter((line) => line.type === 'reply');
  const replyText = replies.length ? String(replies[replies.length - 1].text || '') : '';
  const models = turn.front.filter((line) => line.type === 'model');
  const modelName = replies.length && replies[replies.length - 1].model
    ? replies[replies.length - 1].model
    : (models.length ? models[models.length - 1].model : '');
  const rounds = replies.length
    ? replies[replies.length - 1].rounds
    : models.reduce((max, line) => Math.max(max, Number(line.index) || 0), 0);

  let modelDrawn = false;
  for (const line of turn.front) {
    if (line.type === 'model') {
      if (modelDrawn) continue;
      modelDrawn = true;
      lane.appendChild(renderModels(models, modelName, rounds, replyText));
      continue;
    }
    if (line.type === 'call') {
      lane.appendChild(renderCall(line));
      continue;
    }
    if (line.type === 'dispatch') {
      lane.appendChild(renderDispatch(line));
      continue;
    }
    if (line.type === 'reply') {
      lane.appendChild(el('p', 'reply-line', line.text));
      continue;
    }
    if (line.type === 'task') {
      lane.appendChild(el('p', 'line-task', taskLineLabel(line)));
      continue;
    }
    if (line.type === 'approval') {
      lane.appendChild(el('p', 'line-approval', approvalLineLabel(line)));
    }
  }
  return lane;
}

/** 模型每一轮：默认折起，展开看见每一轮说了什么。 */
function renderModels(models, modelName, rounds, replyText) {
  const detail = el('details', 'detail');
  detail.dataset.detail = 'model';
  detail.appendChild(el('summary', 'detail-head', modelHeadLabel(modelName, rounds)));
  const body = el('div', 'detail-body');
  for (const line of models) {
    const text = String(line.text || '');
    // 与答复正文一样的那轮不单列——否则同一句话在页面上出现两遍。
    if (replyText && text === replyText) continue;
    body.appendChild(el('p', 'model-line', modelRoundLabel(line.index, text)));
  }
  detail.appendChild(body);
  return detail;
}

/** 一次快工具调用。 */
function renderCall(line) {
  const detail = el('details', 'detail');
  detail.dataset.detail = `call:${line.tool}`;
  const label = fastToolLabel(line.tool, line.args);
  const failed = Boolean(line.error);
  detail.appendChild(el('summary', 'detail-head', failed ? `${label}：${TOOL_ERROR_LABEL}` : label));
  const body = el('div', 'detail-body');
  const pre = el('pre', 'detail-pre');
  const parts = [];
  const preview = argsPreview(line.args);
  if (preview) parts.push(preview);
  if (line.result) parts.push(String(line.result));
  if (line.error) parts.push(String(line.error));
  pre.textContent = parts.join('\n');
  body.appendChild(pre);
  detail.appendChild(body);
  return detail;
}

/** 派给后台的一个动作；交底原文折在里面。 */
function renderDispatch(line) {
  const detail = el('details', 'detail');
  detail.dataset.detail = `dispatch:${line.taskId}`;
  detail.appendChild(el('summary', 'detail-head', dispatchLabel(line)));
  const body = el('div', 'detail-body');
  if (line.brief) {
    const brief = el('details', 'detail');
    brief.dataset.detail = `brief:${line.taskId}`;
    brief.appendChild(el('summary', 'detail-head', BRIEF_LABEL));
    const briefBody = el('div', 'detail-body');
    briefBody.appendChild(el('pre', 'detail-pre', line.brief));
    brief.appendChild(briefBody);
    body.appendChild(brief);
  }
  detail.appendChild(body);
  return detail;
}

/** 后台那边的一个任务。 */
function renderTask(card) {
  const task = el('section', 'task');
  task.appendChild(el('div', 'task-title', card.title));
  const trail = statusTrail(card.statuses.map((status) => status?.meta?.status));
  if (trail) task.appendChild(el('div', 'task-status', trail));
  if (card.steps.length) {
    const detail = el('details', 'detail');
    detail.dataset.detail = `steps:${card.taskId}`;
    detail.appendChild(el('summary', 'detail-head', stepsLabel(card.steps.length)));
    const body = el('div', 'detail-body');
    const ol = el('ol', 'step-list');
    for (const step of card.steps) {
      ol.appendChild(el('li', '', stepLabel(step)));
    }
    body.appendChild(ol);
    detail.appendChild(body);
    task.appendChild(detail);
  }
  for (const approval of card.approvals) {
    task.appendChild(el('p', 'line-approval', approvalLabel(approval?.meta?.decision)));
  }
  if (card.result) {
    const detail = el('details', 'detail');
    detail.dataset.detail = 'result';
    detail.appendChild(el('summary', 'detail-head', RESULT_LABEL));
    const body = el('div', 'detail-body');
    body.appendChild(el('p', 'task-result', resultText(card.result.text)));
    detail.appendChild(body);
    task.appendChild(detail);
  }
  return task;
}

/**
 * 一块的标题。
 *
 * 孤儿块（没有对应的那句话）不能直接用记录原文当标题——
 * 原文里带着工具名与内部编号（「task.submit 派了个任务：查视频 （任务 t-1）」）。
 * 那种块的第一行是**桌宠那边**的记录，改用它的**人话**当标题：
 * 说的是那件事，不是记录的样子。
 */
function turnTitle(turn) {
  if (!turn.orphan) return turn.title;
  const line = turn.front[0];
  if (!line) return turn.title;
  switch (line.type) {
    case 'dispatch':
      return dispatchLabel(line);
    case 'call':
      return fastToolLabel(line.tool, line.args);
    case 'model':
    case 'reply':
      return String(line.text || '');
    case 'task':
      return taskLineLabel(line);
    case 'approval':
      return approvalLineLabel(line);
    default:
      return turn.title;
  }
}

/** 一块（一次发话）。 */
function renderTurn(turn) {
  const detail = el('details', 'turn');
  detail.dataset.turn = turn.id;
  const head = el('summary', 'turn-head');
  head.appendChild(el('span', 'turn-time', timeLabel(turn.at)));
  head.appendChild(el('span', 'turn-title', turnTitle(turn)));
  if (turn.orphan) {
    head.appendChild(el('span', 'turn-flag', ORPHAN_LABEL));
  } else if (turn.opener === 'pet') {
    head.appendChild(el('span', 'turn-flag', PET_LABEL));
  }
  head.appendChild(el('span', `turn-badge badge-${turn.badge}`, badgeLabel(turn.badge)));
  detail.appendChild(head);

  const body = el('div', 'turn-body');
  const front = renderFront(turn);
  if (turn.front.length) body.appendChild(front);
  if (turn.back.length) {
    const lane = el('section', 'lane lane-back');
    lane.appendChild(el('h3', 'lane-title', '后台那边'));
    for (const card of turn.back) lane.appendChild(renderTask(card));
    body.appendChild(lane);
  }
  detail.appendChild(body);
  return detail;
}

/** 一个分组（今天 / 昨天 / 更早按月）。 */
function renderGroup(group) {
  const section = el('section', 'day');
  section.dataset.day = group.key;
  const title = el('h2', 'day-title');
  title.appendChild(document.createTextNode(`${group.label} `));
  title.appendChild(el('span', 'day-count', `${group.turns.length} 块`));
  section.appendChild(title);
  for (const turn of group.turns) section.appendChild(renderTurn(turn));
  return section;
}

/** 画全部。 */
function render() {
  const view = captureView();
  const groups = buildTurns(store.list());
  turnsById.clear();
  for (const group of groups) {
    for (const turn of group.turns) turnsById.set(turn.id, turn);
  }
  listEl.textContent = '';
  let blocks = 0;
  for (const group of groups) {
    listEl.appendChild(renderGroup(group));
    blocks += group.turns.length;
  }
  restoreView(view);
  emptyEl.style.display = blocks ? 'none' : '';
  countEl.textContent = `${blocks} 块`;
  reportHeight();
}

/**
 * 报高度：面板的窗口是按内容撑开的。
 *
 * 量**内容**的高度，不是视口的——视口至少那么高，
 * 报多了窗口就再也缩不回去。
 */
function reportHeight() {
  requestAnimationFrame(() => {
    const rect = document.body.getBoundingClientRect();
    const height = Math.ceil(Math.max(rect.height, document.body.scrollHeight));
    surface.setHeight(height);
  });
}

// 用户亲手点开的：记住它，别让默认值把它收回去。
listEl.addEventListener('click', (event) => {
  const summary = event.target.closest?.('summary');
  if (!summary || !summary.parentElement) return;
  const node = summary.parentElement;
  if (node.tagName !== 'DETAILS') return;
  const keys = assignKeys(listEl);
  const key = keys.get(node);
  if (key) touched.add(key);
});

// 首份快照：打开时给一次。
// **合进去，不换掉**：快照算出来的那一刻可能已经有新记录推来了。
void surface.data().then((payload) => {
  store.apply(payload);
  render();
});

// 之后的增量：一条记录进来就推一条。
surface.onData((payload) => {
  store.apply(payload);
  render();
});

// 清空记录：清完自己重新取一份快照。
// （插件还会给**别的**界面推一条 replace 通知，那些界面各自清空。）
document.getElementById('clear').addEventListener('click', async () => {
  await surface.act('clear');
  store.reset();
  store.apply(await surface.data());
  render();
});
