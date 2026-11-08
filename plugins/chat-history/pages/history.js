import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { groupEntries } from './groups.js';

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

/** 全部记录（按时间先后）。 */
let entries = [];
/** 已经显示过的条目 id：同一条不显示两遍。 */
const seen = new Set();

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');

/** 把一份记录并进来（重复的跳过）。 */
function merge(payload) {
  const list = Array.isArray(payload?.entries) ? payload.entries : [];
  for (const entry of list) {
    const id = String(entry?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
}

/** 清空重来。 */
function reset(payload) {
  entries = [];
  seen.clear();
  merge(payload);
}

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
    details.appendChild(el('summary', '', `步骤（${block.steps.length}）`));
    const ol = el('ol');
    for (const step of block.steps) {
      ol.appendChild(el('li', '', step.text));
    }
    details.appendChild(ol);
    card.appendChild(details);
  }
  for (const approval of block.approvals) {
    card.appendChild(el('div', 'approval', approval.text));
  }
  return card;
}

/** 画全部。 */
function render() {
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
void surface.data().then((payload) => {
  reset(payload);
  render();
});

// 之后的增量：一条记录进来就推一条。
surface.onData((payload) => {
  merge(payload);
  render();
});

// 清空记录：清完自己重新取一份快照。
document.getElementById('clear').addEventListener('click', async () => {
  await surface.act('clear');
  reset(await surface.data());
  render();
});
