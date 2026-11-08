import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { groupEntries } from './groups.js';
import { stepLabel } from './format.js';
import { createEntryStore } from './entries.js';

/**
 * 聊天记录的页面。
 *
 * 页面只做三件事：
 * - 画记录（按分类分块，见 groups.js）；
 * - 接住宿主推来的新记录，追加到下面；
 * - 报自己的高度（面板的窗口是按内容撑开的）。
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

/** 一个元素。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** 画一句对话。 */
function renderChat(entry) {
  return el('div', `chat ${entry.kind === 'user' ? 'user' : 'reply'}`, entry.text);
}

/** 画一次派单。 */
function renderDispatch(entry) {
  return el('div', 'dispatch', entry.text);
}

/** 画一个任务：状态一行一条，步骤可折叠，审批单列。 */
function renderTask(block) {
  const card = el('section', 'task');
  card.appendChild(el('div', 'title', block.title || `任务 ${block.taskId}`));
  for (const status of block.statuses) {
    card.appendChild(el('div', 'status', status.text));
  }
  if (block.steps.length) {
    const details = el('details');
    // 记下是哪个任务的：重画之后要把它恢复成「展开着」。
    details.dataset.taskId = block.taskId;
    details.appendChild(el('summary', '', `步骤（${block.steps.length}）`));
    const ol = el('ol');
    for (const step of block.steps) {
      ol.appendChild(el('li', '', stepLabel(step)));
    }
    details.appendChild(ol);
    card.appendChild(details);
  }
  for (const approval of block.approvals) {
    card.appendChild(el('div', 'approval', approval.text));
  }
  return card;
}

/**
 * 记住用户正在看的样子。
 *
 * **为什么要记**：记录是**实时**进来的——任务在跑的时候一秒一条。
 * 每来一条就重画整个列表的话，用户展开的「步骤」会被收起来，
 * 视线也会被拽回顶部：他刚展开想看的内容，一眨眼就没了。
 */
function captureView() {
  const openTaskIds = new Set();
  for (const node of listEl.querySelectorAll('details[open]')) {
    if (node.dataset.taskId) openTaskIds.add(node.dataset.taskId);
  }
  const scroller = document.scrollingElement || document.documentElement;
  const top = scroller ? scroller.scrollTop : 0;
  const height = scroller ? scroller.scrollHeight : 0;
  const viewport = scroller ? scroller.clientHeight : 0;
  // 贴着底部（差几像素就算）：新记录来了要**跟着**往下走。
  const atBottom = height - top - viewport < 24;
  return { openTaskIds, top, atBottom };
}

/** 把用户正在看的样子还回去。 */
function restoreView(view) {
  for (const node of listEl.querySelectorAll('details[data-task-id]')) {
    node.open = view.openTaskIds.has(node.dataset.taskId);
  }
  const scroller = document.scrollingElement || document.documentElement;
  if (!scroller) return;
  scroller.scrollTop = view.atBottom ? scroller.scrollHeight : view.top;
}

/** 画全部。 */
function render() {
  const view = captureView();
  const entries = store.list();
  listEl.textContent = '';
  const blocks = groupEntries(entries);
  for (const block of blocks) {
    if (block.type === 'task') {
      listEl.appendChild(renderTask(block));
    } else if (block.type === 'chat') {
      listEl.appendChild(renderChat(block.entry));
    } else {
      listEl.appendChild(renderDispatch(block.entry));
    }
  }
  restoreView(view);
  emptyEl.style.display = blocks.length ? 'none' : '';
  countEl.textContent = `${entries.length} 条`;
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
