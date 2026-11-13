import { searchPlugins, searchItems } from '../../shared/fuzzy.js';
import { PANEL_VIEW, SEARCH_VIEW_HEIGHT } from '../../shared/panel.js';
import { renderPage } from '../ui/blocks.js';
import { createDrawer } from '../ui/drawer.js';

/**
 * 插件面板的页面。
 *
 * 这里**没有任何业务逻辑**：插件清单、本机程序清单与系统设置页是主进程下发的，
 * 模糊搜索在本地做（每敲一个字不必过一次 IPC——那是这个交互手感的关键），
 * 插件界面是主进程给的「页面描述」，这里只负责照着画。
 *
 * 两种视图：
 * - 搜索视图：输入框 + 模糊匹配出来的插件与程序（↑↓ 选，Enter 打开/启动，Esc 关闭）；
 * - 插件视图：某个插件的界面（Esc 回搜索视图）。
 *
 * 唯一的例外是**文件**：本机的文件可能成千上万个，
 * 清单搬不进渲染层，只能让主进程去查 Windows 搜索索引（Win+S 用的就是它），
 * 查回来的结果再在本地打分排序。
 */

/** 真实图标还没抽出来时的替身符号。 */
const APP_ICON = '🖥';
const FILE_ICON = '📄';
const SETTINGS_ICON = '⚙️';
const WEB_ICON = '🌐';

/**
 * 「内容里命中」的文件的分数。
 *
 * 文件名里有这个词是最好的结果（~1000），内容里有这个词次之，
 * 顺序吻合的名字最差（几十）。所以这个数夹在中间。
 */
const CONTENT_SCORE = 600;

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
const detachEl = document.getElementById('detach');
const widgetEl = document.getElementById('widget');
const pluginFrameEl = document.getElementById('plugin-frame');

/**
 * 设置抽屉：插件的配置项都在这里，不占正文。
 *
 * 与插件的独立窗口共用同一份（src/renderer/ui/drawer.js）。
 * 让开标题栏那一行：抽屉开着的时候，面板的「关闭」「分离」照样点得着。
 */
const drawer = createDrawer({
  button: document.getElementById('settings'),
  // 插件那一栏还没打开时标题栏是藏着的（量出来是 0）——所以每次打开时才量。
  top: () => document.getElementById('plugin-head').offsetHeight,
});

/** 插件清单（主进程一次性下发）。 */
let plugins = [];
/** 本机程序清单（主进程扫好一次性下发）。 */
let apps = [];
/** 系统设置页清单（主进程一次性下发）。 */
let settings = [];
/** 命中的本机文件（主进程查 Windows 搜索索引得来的）。 */
let files = [];
/**
 * 当前搜索出来的结果。
 *
 * 每项要么是插件（`kind: 'plugin'`），要么是本机程序（`kind: 'app'`），
 * 要么是系统设置页（`kind: 'setting'`），要么是本机文件（`kind: 'file'`），
 * 要么是常驻在末尾的「和桌宠聊天」（`kind: 'chat'`）与「上网搜」（`kind: 'web'`）
 * ——后两者不是真的东西，是合成项。
 */
let results = [];
/** 选中的那条（搜索视图里高亮的那一行）。 */
let activeIndex = 0;
/** 当前打开的插件（空串 = 搜索视图）。 */
let currentPluginId = '';
/** 路径 → 图标（data URL）。抽过的图标留在这儿，免得每次重画都去要一遍。 */
const iconCache = new Map();
/** 已经问过主进程的路径：抽不出图标的别反复问。 */
const iconAsked = new Set();

// 诊断面：自动化要能断言「搜索框里打了什么、结果里有哪些插件与程序」。
window.__panel = {
  query: '',
  resultIds: [],
  appIds: [],
  appCount: 0,
  fileIds: [],
  settingIds: [],
  hasChat: false,
  hasWeb: false,
  /** 最近一次右键的那条结果（自动化要能断言右键交出去的是什么）。 */
  contextTarget: null,
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
 * 插件自带页面报来的**内容高度**（像素）。
 *
 * 是页面自己量的（它知道自己有多高），不是这里量的。
 * 0 = 还没收到（页面刚装上，还没来得及量）。
 */
let pluginContentHeight = 0;

/**
 * 面板自己占掉的高度：标题栏、副标题、状态栏、边框。
 *
 * 拿「卡片高度 − iframe 高度」来算：卡片的其余部分都是面板自己的，
 * iframe 是插件页面的，两者的差就是面板自己要的。
 */
function measureChrome() {
  const card = panelEl.getBoundingClientRect().height;
  const frame = pluginFrameEl.hidden ? 0 : pluginFrameEl.getBoundingClientRect().height;
  return Math.max(0, card - frame);
}

/**
 * body 上下那圈留白（阴影用的）。
 *
 * 数值从样式里读，别写死——改了 CSS 忘了改这里，底部就会被切。
 */
function measureBodyPadding() {
  const style = getComputedStyle(document.body);
  return {
    top: parseFloat(style.paddingTop) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
  };
}

/**
 * 把高度报给主进程，拿回**实际**的窗口高度。
 *
 * 一定接住拒绝：invoke 在窗口被拆掉时会拒绝，
 * 而渲染层没有全局 unhandledrejection 兜底——拒绝会变成未处理错误。
 *
 * @param {number} height 想要多高的窗口
 * @returns {Promise<number>} 主进程定的窗口高度（拿不到就是 0）
 */
function reportSize(height) {
  try {
    return Promise.resolve(window.panel?.reportSize?.(height)).catch(() => 0);
  } catch {
    return Promise.resolve(0);
  }
}

/**
 * 把 iframe 收到窗口**装得下**的高度。
 *
 * 装不下的部分在 iframe 内部滚动——**不能让它溢出窗口**：
 * 窗口外的部分既看不见也点不到（底部的按钮就在那儿）。
 *
 * @param {number} windowHeight 窗口实际有多高（主进程回给我们的那个数）
 */
function fitPluginFrame(windowHeight) {
  if (pluginFrameEl.hidden) return;
  const padding = measureBodyPadding();
  const budget = Math.max(
    0,
    Number(windowHeight) - padding.top - padding.bottom - measureChrome()
  );
  pluginFrameEl.style.height = `${Math.min(pluginContentHeight, budget)}px`;
}

/**
 * 摆好插件自带页面，并把窗口要开多高报给主进程。
 *
 * 三步的顺序不能乱：
 * 1. 先按**内容高度**摆 iframe——只有这样量出来的卡片高度才等于内容的高度；
 * 2. 报高度，主进程按屏幕装不装得下夹一下，回一个**实际窗口高度**；
 * 3. 再按实际窗口高度收一收 iframe（见 fitPluginFrame）。
 *
 * 第 3 步是「显示不全」的解药：以前 iframe 一直按内容摆，
 * 窗口却有上限，超出的那一截直接被窗口裁掉——
 * 录屏的工作台就是这样：底部（状态栏、录制按钮）被切掉一截。
 */
async function layoutPluginFrame(contentHeight) {
  pluginContentHeight = Math.max(0, Number(contentHeight) || 0);
  // 先按内容摆：量出来的卡片高度才是「内容有多高」。
  pluginFrameEl.style.height = `${pluginContentHeight}px`;
  const padding = measureBodyPadding();
  const needed = Math.ceil(
    measureChrome() + pluginContentHeight + padding.top + padding.bottom
  );
  const granted = await reportSize(needed);
  fitPluginFrame(Number(granted) || window.innerHeight);
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
      void reportSize(SEARCH_VIEW_HEIGHT);
      return;
    }
    // 插件自带页面：高度由**页面报来的内容高度**决定。
    //
    // 不在这里量 iframe：它是被窗口裁过的，拿它当内容高度，
    // 窗口就会越缩越小（缩 → iframe 更矮 → 再缩……）。
    if (!pluginFrameEl.hidden) {
      // 页面还没报过高度：先别动窗口（它多半正在加载）。
      // 一报告就把窗口压扁，接着又撑回去，看着闪。
      if (pluginContentHeight > 0) void layoutPluginFrame(pluginContentHeight).catch(() => {});
      return;
    }
    // 积木界面：卡片按内容收缩，窗口跟着变矮。
    //
    // 卡片的高度（border-box，含边框）。
    // 往上取整：窗口要装得下卡片，少一像素就会把底部切掉。
    const needed = panelEl.getBoundingClientRect().height;
    if (needed <= 0) return;
    // 加上 body 的内边距：卡片四周留的那一圈是给阴影用的，
    // 窗口得把它们也算进去，否则卡片会被窗口切掉一截。
    const padding = measureBodyPadding();
    void reportSize(Math.ceil(needed) + padding.top + padding.bottom);
  });
}

/**
 * 把一条命中变成结果行。
 *
 * 四种来源的条目形状不一样（插件有图标符号，程序与文件有路径，
 * 设置页有地址），这里统一成同一种行，后面的画法就只有一个。
 */
function toRow(kind, hit) {
  const item = hit.item || {};
  const row = {
    kind,
    id: String(item.id || ''),
    name: String(item.name || ''),
    desc: String(item.hint || ''),
    score: hit.score,
    field: hit.field,
    positions: hit.positions || [],
  };
  if (kind === 'plugin') {
    const plugin = hit.plugin || {};
    row.id = String(plugin.id || '');
    row.name = String(plugin.name || '');
    row.desc = String(plugin.description || '');
    row.icon = plugin.icon || '•';
    return row;
  }
  if (kind === 'app') {
    row.path = String(item.target || '');
    row.icon = APP_ICON;
    return row;
  }
  if (kind === 'file') {
    row.path = String(item.target || '');
    row.icon = FILE_ICON;
    return row;
  }
  if (kind === 'setting') {
    row.target = String(item.target || '');
    row.icon = SETTINGS_ICON;
    return row;
  }
  return row;
}

/**
 * 文件的命中。
 *
 * 分两种：**文件名**里有这个词（正常打分），与文件**内容**里有这个词
 * （索引告诉我们的，名字里没有——分数低一档，排在名字命中的后面）。
 */
function fileHits(query, list) {
  const byName = searchItems(
    query,
    list.filter((file) => file.match !== 'content')
  ).map((hit) => toRow('file', hit));
  const byContent = list
    .filter((file) => file.match === 'content')
    .map((file, index) => {
      const row = toRow('file', {
        item: file,
        score: CONTENT_SCORE - index,
        field: 'name',
        positions: [],
      });
      row.desc = `内容匹配 · ${row.desc}`;
      return row;
    });
  return [...byName, ...byContent];
}

/** 重新搜索并重画结果列表。 */
function renderResults() {
  const query = queryEl.value;
  const trimmed = query.trim();
  // 程序、设置页与插件放在**同一个**列表里，按分数从高到低排。
  // 几边的分数是同一个尺子（名字命中权重都是 1），混排才公平：
  // 用户打「chrome」，出来的就该是 Chrome 而不是某个叫「图片」的插件。
  const hits = [
    ...searchPlugins(query, plugins).map((hit) => toRow('plugin', hit)),
    ...searchItems(query, apps).map((hit) => toRow('app', hit)),
    ...searchItems(query, settings).map((hit) => toRow('setting', hit)),
    ...fileHits(query, files),
  ];
  // 稳定排序：分数相同的不换位（sort 在 V8 里是稳定的）。
  //
  // 插件排在前面：**分数相同就是插件赢**。中文系统上装的东西常常同名
  // （Windows 自带的「待办」就是一个），那种时候用户想要的是桌宠自己的待办，
  // 而不是把另一个程序打开。
  results = hits.sort((a, b) => b.score - a.score);
  // 聊天入口**常驻**在列表末尾：搜不到插件时它就是唯一的一项，
  // 回车自然落到它身上；搜到了插件时可以用 ↓ 选中它，或者 Ctrl+Enter 直接发。
  if (trimmed) {
    results.push({
      kind: 'chat',
      id: 'chat',
      name: '和桌宠聊天',
      desc: '直接对桌宠说话',
      icon: '💬',
      score: 0,
      field: '',
      positions: [],
    });
    // 上网搜：Win+S 也会给网页结果，这里给一个兜底的入口。
    results.push({
      kind: 'web',
      id: 'web',
      name: `上网搜「${trimmed}」`,
      desc: '用浏览器搜',
      icon: WEB_ICON,
      query: trimmed,
      score: 0,
      field: '',
      positions: [],
    });
  }
  if (activeIndex >= results.length) activeIndex = Math.max(0, results.length - 1);
  if (activeIndex < 0) activeIndex = 0;

  resultsEl.textContent = '';
  results.forEach((row, index) => {
    const li = document.createElement('li');
    if (index === activeIndex) li.classList.add('active');
    if (row.kind === 'plugin') li.dataset.pluginId = row.id;
    else if (row.kind === 'app') li.dataset.appId = row.id;
    else li.dataset.itemId = row.id;

    const iconBox = document.createElement('span');
    iconBox.className = 'icon-box';
    const fallback = document.createElement('span');
    fallback.className = 'icon';
    fallback.textContent = row.icon || '•';
    iconBox.append(fallback);
    // 有路径的条目（程序、文件）能抽出真正的图标：先摆占位，图标到了再换。
    if (row.path) {
      const img = document.createElement('img');
      img.className = 'icon-img';
      img.dataset.path = row.path;
      img.alt = '';
      img.hidden = true;
      const cached = iconCache.get(row.path);
      if (cached) {
        img.src = cached;
        img.hidden = false;
        fallback.hidden = true;
      }
      iconBox.append(img);
    }

    const name = document.createElement('span');
    name.className = 'name';
    appendHighlighted(name, row.name, row.positions, row.field);

    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = row.desc || '';

    li.append(iconBox, name, desc);
    li.addEventListener('click', () => openResult(row));
    // 右键：打开 / 打开所在目录（原生菜单，由主进程弹）。
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (row.kind === 'plugin' || row.kind === 'chat') return;
      const target = {
        kind: row.kind,
        id: row.id,
        name: row.name,
        path: row.path || '',
        target: row.target || '',
      };
      window.__panel.contextTarget = target;
      window.panel?.contextMenu?.(target);
    });
    resultsEl.append(li);
  });

  emptyEl.hidden = results.length > 0;
  window.__panel.query = queryEl.value;
  // resultIds 只放**插件**的 id（聊天项与程序项都不是插件）。
  window.__panel.resultIds = results.filter((h) => h.kind === 'plugin').map((h) => h.id);
  // appIds 放命中的**程序** id（自动化要能断言搜到了哪些程序）。
  window.__panel.appIds = results.filter((h) => h.kind === 'app').map((h) => h.id);
  // fileIds 与 settingIds 同理：文件与设置页也进了搜索范围。
  window.__panel.fileIds = results.filter((h) => h.kind === 'file').map((h) => h.id);
  window.__panel.settingIds = results.filter((h) => h.kind === 'setting').map((h) => h.id);
  window.__panel.hasChat = results.some((h) => h.kind === 'chat');
  window.__panel.hasWeb = results.some((h) => h.kind === 'web');
  reportHeight();
  void refreshIcons();
}

/**
 * 给屏幕上的结果补图标。
 *
 * 一次只问**看得见的那几行**的图标：整份清单的图标全抽一遍要好几秒，
 * 而用户只看得到最上面几行。抽过的图标缓存在主进程与这里，不会重复抽。
 */
async function refreshIcons() {
  const wanted = [];
  for (const row of results.slice(0, 16)) {
    if (!row.path || iconCache.has(row.path) || iconAsked.has(row.path)) continue;
    if (!wanted.includes(row.path)) wanted.push(row.path);
  }
  if (!wanted.length) return;
  for (const path of wanted) iconAsked.add(path);
  let map = null;
  try {
    map = await window.panel?.icons?.(wanted);
  } catch (err) {
    console.warn('[desk-pet] 取图标失败：', err?.message || err);
    return;
  }
  if (!map) return;
  let changed = false;
  for (const [path, url] of Object.entries(map)) {
    if (!url || iconCache.get(path) === url) continue;
    iconCache.set(path, url);
    changed = true;
  }
  if (!changed) return;
  // 图标到了：把占位换成真图标（不用重画整个列表，免得选中项跳掉）。
  for (const img of resultsEl.querySelectorAll('img.icon-img')) {
    const url = iconCache.get(img.dataset.path || '');
    if (!url || img.getAttribute('src') === url) continue;
    img.src = url;
    img.hidden = false;
    const fallback = img.parentElement?.querySelector('span.icon');
    if (fallback) fallback.hidden = true;
  }
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

/**
 * 打开一条结果。
 *
 * 插件、程序各有各的通道；文件、设置页、上网搜都交给主进程
 * （它们要调系统的打开动作，渲染层做不了）。
 */
function openResult(row) {
  if (!row) return;
  if (row.kind === 'chat') {
    sendChat();
    return;
  }
  if (row.kind === 'plugin') {
    openPlugin(row.id);
    return;
  }
  if (row.kind === 'app') {
    launchApp(row.id);
    return;
  }
  void window.panel?.openItem?.(row);
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

/** 画插件界面。 */
function renderPlugin(page) {
  currentPluginId = page?.pluginId || '';
  pluginTitleEl.textContent = page?.title || '';
  pluginSubtitleEl.textContent = page?.subtitle || '';
  pluginStatusEl.textContent = page?.status || '';

  // 插件清单里带着这个插件的页面信息（有没有自带页面、页面的地址）。
  const meta = plugins.find((p) => p.id === currentPluginId);

  if (meta?.hasPage && meta.pageUrl) {
    // 插件自带页面：装进 iframe，宿主不再画积木。
    // 独立窗口那边也是「壳 + iframe」——两处结构一样，界面才是一套。
    pluginBodyEl.hidden = true;
    pluginFrameEl.hidden = false;
    // 自己的页面有自己的抽屉（剪贴板、录屏就是这样）：宿主这个收起来。
    drawer.setAvailable(false);
    if (pluginFrameEl.getAttribute('src') !== meta.pageUrl) {
      pluginFrameEl.setAttribute('src', meta.pageUrl);
    }
    // 面板的 surface 请求要带着插件 id（宿主才知道该把数据送给谁）。
    window.panel?.setCurrentPlugin?.(currentPluginId);
  } else {
    pluginFrameEl.hidden = true;
    pluginFrameEl.removeAttribute('src');
    pluginBodyEl.hidden = false;
    // 换成了积木界面：插件页面的高度不再作数。
    pluginContentHeight = 0;
    window.panel?.setCurrentPlugin?.('');

    // 块怎么画是共用的一份（src/renderer/ui/blocks.js）：
    // 面板与插件的独立窗口必须长得一模一样。
    renderPage(page, {
      body: pluginBodyEl,
      // 设置项画在右边的抽屉里（清单里声明的那些 + 插件自己放的）。
      drawer: drawer.body,
      onAction: (actionId, value) => {
        window.panel?.action?.(currentPluginId, actionId, value);
      },
    });
    drawer.setAvailable((page?.drawer || []).length > 0);

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

  // 「分离出去」的两个按钮：能不能分离取决于插件自己
  // （清单里有没有 window / widget 段）。不支持的形态整个藏掉。
  detachEl.hidden = !meta?.canDetach;
  widgetEl.hidden = !meta?.hasWidget;

  searchEl.hidden = true;
  pluginEl.hidden = false;
  panelEl.dataset.view = PANEL_VIEW.PLUGIN;
  window.__panel.view = PANEL_VIEW.PLUGIN;
  window.__panel.pluginId = currentPluginId;
  reportHeight();
}

/** 回到搜索视图。 */
function renderSearch() {
  currentPluginId = '';
  queryEl.value = '';
  activeIndex = 0;
  // 回到搜索视图：插件的页面也不该留在那儿。
  pluginFrameEl.hidden = true;
  pluginFrameEl.removeAttribute('src');
  pluginBodyEl.hidden = false;
  pluginContentHeight = 0;
  // 抽屉也收起来：下一个插件的设置不该从上一个插件的抽屉里冒出来。
  drawer.setAvailable(false);
  window.panel?.setCurrentPlugin?.('');
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
    // 抽屉开着的时候，Esc 先关抽屉（它先处理，标记了 defaultPrevented）。
    if (e.defaultPrevented) return;
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
    openResult(hit);
  }
});

// ---------------------------------------------------------------------------
// 与主进程之间
// ---------------------------------------------------------------------------

/**
 * 去主进程查文件。
 *
 * 文件清单太大，搬不进渲染层，只能让主进程去查 Windows 搜索索引。
 * **防抖**：每敲一个字都查一次索引是白费力气——
 * 用户打「记事本」时，中间的「记」「记事」都没意义。
 */
let fileSearchTimer = null;
/** 查询序号：晚回来的旧结果要扔掉（不然结果会跳）。 */
let fileSearchSeq = 0;

function scheduleFileSearch(query) {
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  const q = String(query || '').trim();
  if (!q) {
    files = [];
    return;
  }
  fileSearchTimer = setTimeout(async () => {
    const seq = ++fileSearchSeq;
    let list = null;
    try {
      list = await window.panel?.files?.(q);
    } catch (err) {
      console.warn('[desk-pet] 查文件失败：', err?.message || err);
      return;
    }
    // 期间用户又改了查询：这一份已经过时了。
    if (seq !== fileSearchSeq) return;
    files = Array.isArray(list) ? list : [];
    renderResults();
  }, 120);
}

queryEl.addEventListener('input', () => {
  activeIndex = 0;
  // 上一次的启动结果已经过时了：换了个查询，那行字就该清掉。
  setSearchStatus('');
  // 旧的文件结果也是过时的：先清掉，等新的回来。
  files = [];
  renderResults();
  scheduleFileSearch(queryEl.value);
});

backEl.addEventListener('click', () => window.panel?.back?.());
closeEl.addEventListener('click', () => window.panel?.close?.());
// 分离出去：开一个独立窗口，或者变成挂在桌面上的小部件。
detachEl.addEventListener('click', () => {
  window.panel?.detach?.(currentPluginId, 'window');
});
widgetEl.addEventListener('click', () => {
  window.panel?.detach?.(currentPluginId, 'widget');
});

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

/** 收到系统设置页清单：换掉旧的，重画结果。 */
function applySettings(list) {
  settings = Array.isArray(list) ? list : [];
  renderResults();
}

// 设置页清单是一次性的：主进程启动时下发一份。
window.panel?.onSettings?.(applySettings);

// 主进程那边做的事（右键菜单里的「打开」「打开所在目录」）的结果，
// 显示在搜索视图底部那行——用户得看得见自己点了什么。
window.panel?.onStatus?.((text) => setSearchStatus(String(text || '')));

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

// 插件自带页面（在 iframe 里）发来的消息：底部那行字与内容高度。
//
// 用 `event.source` 认人：别的窗口也能往这里 postMessage，
// 只有自己那个 iframe 说的才算数。
window.addEventListener('message', (event) => {
  if (!pluginFrameEl.contentWindow || event.source !== pluginFrameEl.contentWindow) return;
  const data = event.data || {};
  if (data.type === 'desk-pet:surface:status') {
    pluginStatusEl.textContent = String(data.text || '');
    return;
  }
  if (data.type === 'desk-pet:surface:height') {
    // 插件页面自己报高度：窗口要按内容撑开。
    //
    // 这里**不夹上限**：窗口能开多高由主进程说了算（它按屏幕算），
    // 主进程回一个实际高度，页面再按它把 iframe 摆好——
    // 装不下的部分在 iframe 里滚，不会被窗口裁掉。
    const h = Math.max(0, Number(data.height) || 0);
    if (h > 0) void layoutPluginFrame(h).catch(() => {});
  }
});

// 先注册监听器再报到：反过来主进程发来的东西会被丢弃。
window.panel?.reportReady?.();
