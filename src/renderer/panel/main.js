import { searchPlugins, searchApps } from '../../shared/fuzzy.js';
import { PANEL_VIEW, BLOCK_KIND, SEARCH_VIEW_HEIGHT } from '../../shared/panel.js';

/**
 * 插件面板的页面。
 *
 * 这里**没有任何业务逻辑**：插件清单与本机程序清单是主进程下发的，
 * 模糊搜索在本地做（每敲一个字不必过一次 IPC——那是这个交互手感的关键），
 * 插件界面是主进程给的「页面描述」，这里只负责照着画。
 *
 * 两种视图：
 * - 搜索视图：输入框 + 模糊匹配出来的插件与程序（↑↓ 选，Enter 打开/启动，Esc 关闭）；
 * - 插件视图：某个插件的界面（Esc 回搜索视图）。
 */

/** 程序条目的图标：程序没有图标资源，用一个固定的符号代表。 */
const APP_ICON = '🖥';

const searchEl = document.getElementById('search');
const panelEl = document.getElementById('panel');
const queryEl = document.getElementById('query');
const resultsEl = document.getElementById('results');
const emptyEl = document.getElementById('empty');
const searchStatusEl = document.getElementById('search-status');
const pluginEl = document.getElementById('plugin');
const pluginTitleEl = document.getElementById('plugin-title');
const pluginSubtitleEl = document.getElementById('plugin-subtitle');
const pluginBodyEl = document.getElementById('plugin-body');
const pluginStatusEl = document.getElementById('plugin-status');
const backEl = document.getElementById('back');
const closeEl = document.getElementById('close');

/** 插件清单（主进程一次性下发）。 */
let plugins = [];
/** 本机程序清单（主进程扫好一次性下发）。 */
let apps = [];
/**
 * 当前搜索出来的结果。
 *
 * 每项要么是插件（`kind: 'plugin'`），要么是本机程序（`kind: 'app'`），
 * 要么是常驻在末尾的「和桌宠聊天」（`kind: 'chat'`）——后者不是插件，是个合成项。
 */
let results = [];
/** 选中的那条（搜索视图里高亮的那一行）。 */
let activeIndex = 0;
/** 当前打开的插件（空串 = 搜索视图）。 */
let currentPluginId = '';

// 诊断面：自动化要能断言「搜索框里打了什么、结果里有哪些插件与程序」。
window.__panel = {
  query: '',
  resultIds: [],
  appIds: [],
  appCount: 0,
  hasChat: false,
  view: PANEL_VIEW.SEARCH,
  pluginId: '',
};

/**
 * 把命中的字标出来。
 *
 * `positions` 是命中位置（在命中的那个字段里）。
 * 只有命中的是**名字**时才标——标在描述上没什么意义。
 */
function appendHighlighted(el, text, positions, field) {
  if (field !== 'name' || !positions || positions.length === 0) {
    el.textContent = text;
    return;
  }
  let last = 0;
  for (const p of positions) {
    if (p > last) el.append(text.slice(last, p));
    const mark = document.createElement('mark');
    mark.textContent = text[p] ?? '';
    el.append(mark);
    last = p + 1;
  }
  if (last < text.length) el.append(text.slice(last));
}

/**
 * 把内容高度报给主进程：窗口要按内容撑开。
 *
 * 插件视图里卡片按内容收缩，窗口跟着变矮——
 * 否则窗口下半截是**透明**的，而透明的那部分仍会吃掉桌面的点击
 * （Windows 没有逐像素命中测试，整个窗口矩形都是热区）。
 *
 * 搜索视图**固定**高度：结果条数一变窗口就一高一低，看着晃。
 *
 * 必须等一帧再量：改完 DOM 立刻量，浏览器可能还没算完布局。
 */
function reportHeight() {
  requestAnimationFrame(() => {
    if (panelEl.dataset.view !== PANEL_VIEW.PLUGIN) {
      window.panel?.reportSize?.(SEARCH_VIEW_HEIGHT);
      return;
    }
    // 卡片的高度（border-box，含边框）。
    // 往上取整：窗口要装得下卡片，少一像素就会把底部切掉。
    const needed = panelEl.getBoundingClientRect().height;
    if (needed <= 0) return;
    // 加上 body 的内边距（卡片四周各 6px）。
    window.panel?.reportSize?.(Math.ceil(needed) + 12);
  });
}

/** 重新搜索并重画结果列表。 */
function renderResults() {
  const query = queryEl.value;
  // 程序与插件放在**同一个**列表里，按分数从高到低排。
  // 两边的分数是同一个尺子（名字命中权重都是 1），混排才公平：
  // 用户打「chrome」，出来的就该是 Chrome 而不是某个叫「图片」的插件。
  const hits = [
    ...searchPlugins(query, plugins).map((hit) => ({ kind: 'plugin', ...hit })),
    ...searchApps(query, apps).map((hit) => ({ kind: 'app', ...hit })),
  ];
  // 稳定排序：分数相同的不换位（sort 在 V8 里是稳定的）。
  //
  // 插件排在前面：**分数相同就是插件赢**。中文系统上装的东西常常同名
  // （Windows 自带的「待办」就是一个），那种时候用户想要的是桌宠自己的待办，
  // 而不是把另一个程序打开。
  results = hits.sort((a, b) => b.score - a.score);
  // 聊天入口**常驻**在列表末尾：搜不到插件时它就是唯一的一项，
  // 回车自然落到它身上；搜到了插件时可以用 ↓ 选中它，或者 Ctrl+Enter 直接发。
  if (query.trim()) {
    results.push({
      kind: 'chat',
      score: 0,
      plugin: {
        id: 'chat',
        name: '和桌宠聊天',
        icon: '💬',
        description: '直接对桌宠说话',
      },
    });
  }
  if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  if (activeIndex < 0) activeIndex = 0;

  resultsEl.textContent = '';
  results.forEach((hit, index) => {
    const li = document.createElement('li');
    if (index === activeIndex) li.classList.add('active');
    const isApp = hit.kind === 'app';
    if (!isApp) li.dataset.pluginId = hit.plugin.id;
    else li.dataset.appId = hit.app.id;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = isApp ? APP_ICON : hit.plugin.icon || '•';

    const name = document.createElement('span');
    name.className = 'name';
    if (hit.kind === 'chat') name.textContent = hit.plugin.name;
    else if (isApp) {
      // 命中的是路径时不标：那些位置号指的是路径，标在名字上是错的。
      appendHighlighted(name, hit.app.name || '', hit.positions, 'name');
    } else appendHighlighted(name, hit.plugin.name || '', hit.positions, hit.field);

    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = isApp ? hit.app.hint || '' : hit.plugin.description || '';

    li.append(icon, name, desc);
    li.addEventListener('click', () => {
      if (hit.kind === 'chat') sendChat();
      else if (isApp) launchApp(hit.app.id);
      else openPlugin(hit.plugin.id);
    });
    resultsEl.append(li);
  });

  emptyEl.hidden = results.length > 0;
  window.__panel.query = queryEl.value;
  // resultIds 只放**插件**的 id（聊天项与程序项都不是插件）。
  window.__panel.resultIds = results.filter((h) => h.kind === 'plugin').map((h) => h.plugin.id);
  // appIds 放命中的**程序** id（自动化要能断言搜到了哪些程序）。
  window.__panel.appIds = results.filter((h) => h.kind === 'app').map((h) => h.app.id);
  window.__panel.hasChat = results.some((h) => h.kind === 'chat');
  reportHeight();
}

/** 把输入框里的话发给桌宠。 */
function sendChat() {
  const value = queryEl.value.trim();
  if (!value) return;
  window.panel?.chat?.(value);
  queryEl.value = '';
  activeIndex = 0;
  // 框里的字清掉了，列表也要跟着重画（诊断面上更不能留着旧查询）。
  renderResults();
}

/** 打开一个插件。 */
function openPlugin(pluginId) {
  window.panel?.open?.(pluginId);
}

/**
 * 启动一个本机程序。
 *
 * 结果写在搜索视图底部那一行：程序启动成功与否，
 * 用户得在界面上看得见——静悄悄地失败等于没做。
 */
async function launchApp(appId) {
  setSearchStatus('正在启动…');
  let result = null;
  try {
    result = await window.panel?.launch?.(appId);
  } catch (err) {
    console.warn('[desk-pet] 启动程序失败：', err?.message || err);
  }
  setSearchStatus(result?.message || '启动失败');
}

/** 在搜索视图底部显示一行提示。 */
function setSearchStatus(text) {
  searchStatusEl.textContent = text || '';
  searchStatusEl.hidden = !text;
}

/** 时间戳说成人话（几点几分）。 */
function formatTime(at) {
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

/** 画插件界面。 */
function renderPlugin(page) {
  currentPluginId = page?.pluginId || '';
  pluginTitleEl.textContent = page?.title || '';
  pluginSubtitleEl.textContent = page?.subtitle || '';
  pluginStatusEl.textContent = page?.status || '';

  pluginBodyEl.textContent = '';
  for (const block of page?.blocks || []) {
    const node = renderBlock(block, currentPluginId);
    if (node) pluginBodyEl.append(node);
  }

  searchEl.hidden = true;
  pluginEl.hidden = false;
  panelEl.dataset.view = PANEL_VIEW.PLUGIN;
  window.__panel.view = PANEL_VIEW.PLUGIN;
  window.__panel.pluginId = currentPluginId;
  reportHeight();

  // 第一个输入框直接聚焦：用户刚打开「待办」，多半就是想往上写字。
  const firstInput = pluginBodyEl.querySelector('input[type="text"]');
  if (firstInput) {
    try {
      firstInput.focus();
    } catch {
      /* 窗口还没拿到焦点时会抛，忽略即可 */
    }
  }
}

/** 画一个块。 */
function renderBlock(block, pluginId) {
  switch (block?.kind) {
    case BLOCK_KIND.TEXT: {
      const div = document.createElement('div');
      div.className = 'block-text';
      div.textContent = block.text || '';
      return div;
    }
    case BLOCK_KIND.EMPTY: {
      const div = document.createElement('div');
      div.className = 'block-empty';
      div.textContent = block.text || '';
      return div;
    }
    case BLOCK_KIND.LIST: {
      const ul = document.createElement('ul');
      ul.className = 'block-list';
      for (const item of block.items || []) {
        const li = document.createElement('li');
        if (item.done) li.classList.add('done');
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = item.label || '';
        li.append(label);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'hint';
          hint.textContent = item.hint;
          li.append(hint);
        }
        if (item.removeId) {
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.type = 'button';
          remove.textContent = '✕';
          remove.title = '删除';
          remove.addEventListener('click', (e) => {
            e.stopPropagation();
            window.panel?.action?.(pluginId, item.removeId, item.id);
          });
          li.append(remove);
        }
        li.addEventListener('click', () => {
          window.panel?.action?.(pluginId, item.actionId || item.id, item.id);
        });
        ul.append(li);
      }
      return ul;
    }
    case BLOCK_KIND.INPUT: {
      const row = document.createElement('div');
      row.className = 'block-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = block.placeholder || '';
      input.value = block.value || '';
      const submit = () => {
        const value = input.value;
        window.panel?.action?.(pluginId, block.id || '', value);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = block.submitLabel || '确定';
      btn.addEventListener('click', submit);
      row.append(input, btn);
      return row;
    }
    case BLOCK_KIND.BUTTONS: {
      const row = document.createElement('div');
      row.className = 'block-buttons';
      for (const item of block.items || []) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = item.label || '确定';
        if (item.primary) btn.classList.add('primary');
        btn.addEventListener('click', () => {
          window.panel?.action?.(pluginId, item.id || '', '');
        });
        row.append(btn);
      }
      return row;
    }
    case BLOCK_KIND.MESSAGES: {
      const ul = document.createElement('ul');
      ul.className = 'block-messages';
      for (const item of block.items || []) {
        const li = document.createElement('li');
        li.className = item.role === 'user' ? 'user' : 'assistant';
        const role = document.createElement('span');
        role.className = 'role';
        role.textContent =
          item.role === 'user' ? '你' : item.proactive ? '桌宠（主动）' : '桌宠';
        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = item.text || '';
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = formatTime(item.at);
        li.append(role, text, time);
        ul.append(li);
      }
      return ul;
    }
    case BLOCK_KIND.TOGGLE: {
      const label = document.createElement('label');
      label.className = 'block-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(block.checked);
      input.addEventListener('change', () => {
        window.panel?.action?.(pluginId, block.id || '', String(input.checked));
      });
      const text = document.createElement('span');
      text.textContent = block.label || '';
      label.append(input, text);
      return label;
    }
    default:
      return null;
  }
}

/** 回到搜索视图。 */
function renderSearch() {
  currentPluginId = '';
  queryEl.value = '';
  activeIndex = 0;
  searchEl.hidden = false;
  pluginEl.hidden = true;
  panelEl.dataset.view = PANEL_VIEW.SEARCH;
  // 回到搜索视图 = 重新开始找东西：上一条启动结果留着只会碍眼。
  setSearchStatus('');
  renderResults();
  window.__panel.view = PANEL_VIEW.SEARCH;
  window.__panel.pluginId = '';
  try {
    queryEl.focus();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

/** 上下移动选中项。 */
function moveSelection(delta) {
  if (results.length === 0) return;
  activeIndex = (activeIndex + delta + results.length) % results.length;
  renderResults();
  const active = resultsEl.querySelector('li.active');
  active?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    // 插件视图里 Esc 是「回到搜索」，搜索视图里是「关掉面板」。
    if (currentPluginId) window.panel?.back?.();
    else window.panel?.close?.();
    return;
  }
  if (currentPluginId) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Ctrl+Enter：**永远**发给桌宠（哪怕这句话也能匹配到插件）。
    if (e.ctrlKey) {
      sendChat();
      return;
    }
    const hit = results[activeIndex];
    if (!hit) return;
    if (hit.kind === 'chat') sendChat();
    else if (hit.kind === 'app') launchApp(hit.app.id);
    else openPlugin(hit.plugin.id);
  }
});

// ---------------------------------------------------------------------------
// 与主进程之间
// ---------------------------------------------------------------------------

queryEl.addEventListener('input', () => {
  activeIndex = 0;
  // 上一次的启动结果已经过时了：换了个查询，那行字就该清掉。
  setSearchStatus('');
  renderResults();
});

backEl.addEventListener('click', () => window.panel?.back?.());
closeEl.addEventListener('click', () => window.panel?.close?.());

// 主进程下发插件清单：搜索在本地做，从这一刻起不再需要主进程。
window.panel?.onPlugins?.((list) => {
  plugins = Array.isArray(list) ? list : [];
  renderResults();
});

/** 收到程序清单：换掉旧的，重画结果。 */
function applyApps(list) {
  apps = Array.isArray(list) ? list : [];
  window.__panel.appCount = apps.length;
  renderResults();
}

// 索引重建完了：主进程把新清单推过来。
window.panel?.onApps?.(applyApps);

// 页面刚加载时清单可能还没建好：主动要一份（主进程会等索引建完再回）。
Promise.resolve(window.panel?.apps?.())
  .then(applyApps)
  .catch((err) => {
    console.warn('[desk-pet] 取本机程序清单失败：', err?.message || err);
  });

// 主进程下发视图：搜索视图 or 插件界面。
window.panel?.onView?.((view) => {
  if (view?.view === PANEL_VIEW.PLUGIN) {
    renderPlugin(view.page);
  } else {
    renderSearch();
  }
});

// 先注册监听器再报到：反过来主进程发来的东西会被丢弃。
window.panel?.reportReady?.();
