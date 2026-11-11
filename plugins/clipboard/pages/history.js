// plugins/clipboard/pages/history.js
/**
 * 剪贴板历史列表。
 *
 * 页面只管三件事：
 *
 * - **画**：主进程给什么就画什么（`data()` 的首份、推来的新状态、动作的回包）；
 * - **送动作**：双击一条就贴出去、点图钉就固定、点 ✕ 就删掉；
 * - **报高度**：面板的窗口是按内容撑开的，页面要报自己的高度。
 *
 * 搜索在**本地**做：历史全都在手上，筛选不必过一次 IPC——
 * 每敲一个字就往返一次，键盘会跟手得像在等网络。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { accelFromEvent, describeAccel } from '../lib/accelerator.js';

const surface = bindSurface();

/**
 * 面板里与独立窗口里，高度策略是**相反**的：
 *
 * - 面板的窗口按内容撑开：页面报多高，面板就开多高；
 * - 独立窗口的高度是用户拖出来的：按视口铺满才对。
 *
 * CSS 靠 body 上的这个类分档（见 history.css）。
 */
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const $ = (id) => document.getElementById(id);

const el = {
  search: $('search'),
  record: $('record'),
  clearBtn: $('clearBtn'),
  list: $('list'),
  empty: $('empty'),
  statusText: $('statusText'),
  gear: $('gearBtn'),
  drawer: $('drawer'),
  scrim: $('scrim'),
  drawerClose: $('drawerClose'),
  maxEntries: $('maxEntries'),
  assistant: $('assistant'),
  showKey: $('showKey'),
  pasteKey: $('pasteKey'),
  showKeyBtn: $('showKeyBtn'),
  pasteKeyBtn: $('pasteKeyBtn'),
  hotkeyError: $('hotkeyError'),
};

/** 主进程给的状态。 */
let state = null;
/** 搜索词。 */
let query = '';
/** 正在录快捷键的是哪一个：'show' / 'paste' / ''。 */
let capturing = '';
/** 当前选中的那条（键盘操作靠它）。 */
let selectedId = '';
/** 「清空」的二次确认：定时器的句柄（0 = 没在等确认）。 */
let clearArmed = 0;

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/**
 * 送一个动作给主进程，顺手把回来的状态画上去。
 *
 * 主进程回的是**完整的一份状态**：动作之后界面不用自己猜该变成什么样。
 */
async function act(actionId, payload) {
  try {
    const next = await surface.act(actionId, payload);
    if (next && typeof next === 'object') applyState(next);
  } catch (err) {
    setStatus(`做不了：${err?.message || err}`);
  }
}

function applyState(next) {
  state = { ...(state || {}), ...next };
  render();
}

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------

function setStatus(text) {
  el.statusText.textContent = text || '';
}

function render() {
  if (!state) return;

  el.record.checked = Boolean(state.settings?.record);
  el.assistant.checked = Boolean(state.assistantEnabled);
  if (document.activeElement !== el.maxEntries) {
    el.maxEntries.value = String(state.settings?.maxEntries ?? 200);
  }

  // 正在录键的那一个不画：它自己显示「按下新的组合键…」。
  if (!capturing) {
    setHotkey(el.showKey, state.settings?.showHotkey);
    setHotkey(el.pasteKey, state.settings?.pasteHotkey);
  }

  el.hotkeyError.hidden = !state.hotkeyError;
  el.hotkeyError.textContent = state.hotkeyError || '';

  renderList();

  const total = state.total ?? (state.entries || []).length;
  const pinned = state.pinnedCount ?? 0;
  setStatus(
    state.status ||
      `共 ${total} 条${pinned ? `，${pinned} 条固定` : ''} · 双击一条就贴出去`
  );
}

/** 列表：固定的在前，其余按时间倒序（主进程已经排好了）。 */
function renderList() {
  const all = state?.entries || [];
  const keyword = query.trim().toLowerCase();
  const list = keyword
    ? all.filter((item) => String(item.text || '').toLowerCase().includes(keyword))
    : all;

  el.list.textContent = '';
  if (!list.length) {
    el.empty.hidden = false;
    el.empty.textContent = keyword ? '没有匹配的' : '还没有复制过东西';
    return;
  }
  el.empty.hidden = true;

  const pinned = list.filter((item) => item.pinned);
  const rest = list.filter((item) => !item.pinned);
  if (pinned.length) {
    el.list.append(groupTitle('固定'));
    for (const item of pinned) el.list.append(row(item));
  }
  if (rest.length) {
    el.list.append(groupTitle('最近复制'));
    for (const item of rest) el.list.append(row(item));
  }

  // 选中的那条没了（被删了、被搜掉了）：清掉。
  if (selectedId && !list.some((item) => item.id === selectedId)) selectedId = '';
}

/** 一行小标题（「固定」「最近复制」）。 */
function groupTitle(text) {
  const li = document.createElement('li');
  li.className = 'group';
  li.textContent = text;
  return li;
}

/** 一条历史。 */
function row(item) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.id = item.id;
  if (item.id === selectedId) li.classList.add('selected');

  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = item.pinned ? 'pin on' : 'pin';
  pin.title = item.pinned ? '取消固定' : '固定（不会被淘汰）';
  pin.textContent = '📌';
  pin.addEventListener('click', (event) => {
    event.stopPropagation();
    void act('pin', { id: item.id });
  });

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = item.text || '';
  if (Number(item.len) > String(item.text || '').length) {
    text.title = `共 ${item.len} 个字（这里只显示前面一部分）`;
  }

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(item.at);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'del';
  del.title = '删掉';
  del.textContent = '✕';
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    void act('remove', { id: item.id });
  });

  li.append(pin, text, time, del);

  // **双击才贴出去**：单击是选中（不然想选中一条就得贴一次）。
  li.addEventListener('dblclick', (event) => {
    if (event.target.closest?.('.pin, .del')) return;
    void act('paste', { id: item.id });
  });
  li.addEventListener('click', (event) => {
    if (event.target.closest?.('.pin, .del')) return;
    select(item.id);
  });
  return li;
}

/** 选中某一条（并把界面上别的选中态清掉）。 */
function select(id) {
  selectedId = String(id || '');
  for (const node of el.list.querySelectorAll('li.row')) {
    node.classList.toggle('selected', node.dataset.id === selectedId);
  }
}

/** 把一个快捷键画到键帽上。 */
function setHotkey(node, accel) {
  const text = describeAccel(accel);
  node.textContent = text || '没设置';
  node.title = accel || '';
}

/** 时间戳显示成「14:32」（今天）或「11-08 14:32」（别的日子）。 */
function formatTime(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${md} ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

// —— 搜索：本地筛，不问主进程 ——
el.search.addEventListener('input', () => {
  query = el.search.value;
  renderList();
});

// —— 记录开关 ——
el.record.addEventListener('change', () => {
  void act('setting', { key: 'record', value: el.record.checked });
});

// —— 助手：复制时提示一句 ——
el.assistant.addEventListener('change', () => {
  void act('assistant', { on: el.assistant.checked });
});

// —— 最多留几条 ——
el.maxEntries.addEventListener('change', () => {
  const n = Number(el.maxEntries.value);
  const max = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  void act('setting', { key: 'maxEntries', value: max });
});

// —— 清空：点一下变「确定清空？」，再点一下才真清 ——
el.clearBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = setTimeout(() => {
      clearArmed = 0;
      el.clearBtn.textContent = '清空';
      el.clearBtn.classList.remove('danger');
    }, 3000);
    el.clearBtn.textContent = '确定清空？';
    el.clearBtn.classList.add('danger');
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = 0;
  el.clearBtn.textContent = '清空';
  el.clearBtn.classList.remove('danger');
  void act('clear');
});

// —— 设置抽屉 ——
el.gear.addEventListener('click', openDrawer);
el.drawerClose.addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);

function openDrawer() {
  el.drawer.hidden = false;
  el.scrim.hidden = false;
  // 下一帧再挂 .open：少了这一下就没有滑进来的动画。
  requestAnimationFrame(() => el.drawer.classList.add('open'));
}

function closeDrawer() {
  el.drawer.classList.remove('open');
  el.scrim.hidden = true;
  setTimeout(() => {
    if (!el.drawer.classList.contains('open')) el.drawer.hidden = true;
  }, 180);
}

// —— 快捷键：在页面里捕获按键 ——
el.showKeyBtn.addEventListener('click', () => startCapture('show', el.showKey));
el.pasteKeyBtn.addEventListener('click', () => startCapture('paste', el.pasteKey));

function startCapture(which, node) {
  capturing = which;
  node.textContent = '按下新的组合键…';
  node.classList.add('capturing');
}

/** 不再等按键了。键帽上那个「正在录」的样式也要摘掉。 */
function stopCapture() {
  capturing = '';
  el.showKey.classList.remove('capturing');
  el.pasteKey.classList.remove('capturing');
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  // —— 正在录快捷键：这一段按键是给它的 ——
  if (capturing) {
    event.preventDefault();
    if (event.key === 'Escape') {
      stopCapture();
      render();
      return;
    }
    const accel = accelFromEvent(event);
    // 裸键不要：它会劫持用户所有的字母键。
    if (!accel) return;
    const which = capturing;
    stopCapture();
    void act('setting', {
      key: which === 'show' ? 'showHotkey' : 'pasteHotkey',
      value: accel,
    });
    return;
  }

  if (event.key === 'Escape' && !el.drawer.hidden) {
    closeDrawer();
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (event.key === 'Enter' && event.target === el.search) {
    event.preventDefault();
    const id = selectedId || firstRowId();
    if (id) void act('paste', { id });
    return;
  }

  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId && event.target !== el.search) {
    event.preventDefault();
    void act('remove', { id: selectedId });
  }
});

/** 当前看得见的那些行。 */
function visibleRows() {
  return [...el.list.querySelectorAll('li.row')];
}

function firstRowId() {
  return visibleRows()[0]?.dataset.id || '';
}

/** 上下移动选中项。 */
function moveSelection(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  const index = rows.findIndex((row) => row.dataset.id === selectedId);
  const next =
    index < 0
      ? delta > 0
        ? 0
        : rows.length - 1
      : (index + delta + rows.length) % rows.length;
  select(rows[next].dataset.id);
  rows[next].scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// 首份数据与周期刷新
// ---------------------------------------------------------------------------

surface.onData((data) => {
  if (data) applyState(data);
});

surface.onTick((data) => {
  if (data) applyState(data);
});

// ---------------------------------------------------------------------------
// 报高度：面板的窗口是按内容撑开的
// ---------------------------------------------------------------------------

function reportHeight() {
  requestAnimationFrame(() => {
    // 量**内容**的高度，不是视口的。
    //
    // documentElement.scrollHeight 至少是视口那么高：
    // iframe 比内容高的时候它会多报，主进程按多报的高度开窗，
    // 窗口就再也缩不回去了（底下留一块空白）。
    const rect = document.body.getBoundingClientRect();
    const height = Math.ceil(Math.max(rect.height, document.body.scrollHeight));
    surface.setHeight(height);
  });
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => reportHeight()).observe(document.body);
}
window.addEventListener('resize', reportHeight);
reportHeight();

// 给自动化测试留个抓手。
window.__clipboard = {
  get state() {
    return state;
  },
  get selectedId() {
    return selectedId;
  },
};
