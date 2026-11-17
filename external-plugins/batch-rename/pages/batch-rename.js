// external-plugins/batch-rename/pages/batch-rename.js
/**
 * 批量重命名的界面。
 *
 * 预览在**页面上现算**（lib/plan.js 是纯函数）；真正动手由主进程
 * 用同一份规则再算一遍——页面传的规则只是一份「表单」，不是裁决。
 *
 * 两种形态：
 * - 独立窗口（与面板分离后）：规则 + 预览列表 + 拖拽框；
 * - 面板工作台里：只留一个拖拽框——拖进/选中文件后自动脱离成独立窗口。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { hydrateIcons, iconSvg } from '/src/renderer/ui/icons.js';

import { buildPlan, normalizeRules } from '../lib/plan.js';

const surface = bindSurface();
hydrateIcons();
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));
document.body.classList.toggle('panel-mode', Boolean(surface.inPanel));
if (surface.inPanel) surface.setHeight(280);

const $ = (id) => document.getElementById(id);

const el = {
  clear: $('clear'),
  undo: $('undo'),
  apply: $('apply'),
  stats: $('stats'),
  listWrap: $('list-wrap'),
  list: $('list'),
  drop: $('drop'),
  dropIcon: $('drop-icon'),
  tabRename: $('tabRename'),
  tabReplace: $('tabReplace'),
  panelRename: $('panelRename'),
  panelReplace: $('panelReplace'),
  renameTo: $('renameTo'),
  find: $('find'),
  replace: $('replace'),
  regex: $('regex'),
  ignoreCase: $('ignoreCase'),
  prefix: $('prefix'),
  suffix: $('suffix'),
  caseMode: $('caseMode'),
  extFind: $('extFind'),
  extReplace: $('extReplace'),
  numOn: $('numOn'),
  numStart: $('numStart'),
  numWidth: $('numWidth'),
  numPosition: $('numPosition'),
  numSep: $('numSep'),
};

el.dropIcon.append(iconSvg('file'));

/** 文件清单（绝对路径，添加顺序）——以主进程给的数据为准。 */
let files = [];
let undoCount = 0;
/** 'rename'（重新命名为）| 'replace'（查找 / 替换）——界面上是两个 tab，互斥。 */
let activeMode = 'replace';

// ---------------------------------------------------------------- 模式 tab

/**
 * 「重新命名为」+ 多个文件 → 默认勾上「启用编号」。
 * 只在两种时机跑：切进 rename tab、或已经待在 rename tab 时文件落进来。
 * 用户手动取消勾选，在下次这两种时机之前都管用。
 */
function maybeAutoNumbering() {
  if (activeMode === 'rename' && files.length > 1) {
    el.numOn.checked = true;
  }
}

function setMode(mode) {
  activeMode = mode === 'rename' ? 'rename' : 'replace';
  const rename = activeMode === 'rename';
  el.tabRename.setAttribute('aria-selected', String(rename));
  el.tabReplace.setAttribute('aria-selected', String(!rename));
  el.panelRename.hidden = !rename;
  el.panelReplace.hidden = rename;
  maybeAutoNumbering();
  renderPreview();
}

el.tabRename.addEventListener('click', () => setMode('rename'));
el.tabReplace.addEventListener('click', () => setMode('replace'));

// ---------------------------------------------------------------- 规则表单

function readRules() {
  return normalizeRules({
    mode: activeMode,
    find: el.find.value,
    replace: el.replace.value,
    regex: el.regex.checked,
    ignoreCase: el.ignoreCase.checked,
    renameTo: el.renameTo.value,
    prefix: el.prefix.value,
    suffix: el.suffix.value,
    caseMode: el.caseMode.value,
    extFind: el.extFind.value,
    extReplace: el.extReplace.value,
    numbering: {
      enabled: el.numOn.checked,
      start: el.numStart.value,
      width: el.numWidth.value,
      position: el.numPosition.value,
      separator: el.numSep.value,
    },
  });
}

const ruleInputs = [
  el.renameTo, el.find, el.replace, el.prefix, el.suffix, el.extFind, el.extReplace, el.numStart, el.numWidth, el.numSep,
];
const ruleToggles = [el.regex, el.ignoreCase, el.numOn];
const ruleSelects = [el.caseMode, el.numPosition];
for (const input of ruleInputs) input.addEventListener('input', renderPreview);
for (const toggle of ruleToggles) toggle.addEventListener('change', renderPreview);
for (const select of ruleSelects) select.addEventListener('change', renderPreview);

// ---------------------------------------------------------------- 渲染

function fileDir(path) {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i > 0 ? path.slice(0, i) : path;
}

function renderRows(rows) {
  el.list.replaceChildren();
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'row';
    if (row.status === 'unchanged') div.classList.add('unchanged');
    if (row.status === 'invalid' || row.status === 'collision') div.classList.add('bad');

    const oldCell = document.createElement('div');
    oldCell.className = 'cell col-name';
    oldCell.title = row.path;
    oldCell.textContent = row.oldName;
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = fileDir(row.path);
    oldCell.append(dir);

    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';

    const newCell = document.createElement('div');
    newCell.className = 'cell col-new new';
    newCell.textContent = row.newName ?? '';
    if (row.message) {
      const msg = document.createElement('span');
      msg.className = 'msg';
      msg.textContent = row.message;
      newCell.append(msg);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = '从列表里拿掉';
    del.setAttribute('aria-label', `把 ${row.oldName} 从列表里拿掉`);
    del.append(iconSvg('close'));
    del.addEventListener('click', () => {
      actAndApply('remove-file', { path: row.path });
    });

    div.append(oldCell, arrow, newCell, del);
    el.list.append(div);
  }
}

function renderPreview() {
  const hasFiles = files.length > 0;
  document.body.classList.toggle('has-files', hasFiles);
  el.clear.disabled = !hasFiles;

  if (!hasFiles) {
    el.listWrap.hidden = true;
    el.apply.disabled = true;
    el.stats.textContent = '';
    return;
  }
  el.listWrap.hidden = false;

  const rules = readRules();
  const preview = buildPlan(files.map((path) => ({ path })), rules);

  if (preview.error) {
    el.list.replaceChildren();
    el.stats.textContent = preview.error;
    el.stats.style.color = 'var(--dp-danger)';
    el.apply.disabled = true;
    return;
  }
  el.stats.style.color = '';
  renderRows(preview.rows);

  const { counts } = preview;
  const bad = counts.invalid + counts.collision;
  el.stats.textContent = bad > 0
    ? `${counts.total} 个文件 · ${bad} 个有问题`
    : counts.changed > 0
      ? `${counts.total} 个文件 · 将改名 ${counts.changed} 个`
      : `${counts.total} 个文件 · 没有需要改的`;
  el.apply.disabled = bad > 0 || counts.changed === 0;
}

function renderUndo() {
  el.undo.disabled = undoCount === 0;
  el.undo.textContent = undoCount > 0 ? `撤销上次（${undoCount}）` : '撤销上次';
}

/** 主进程给的一份完整状态：文件清单 + 撤销记录 +（可选）动作结果。 */
function applyState(state) {
  if (!state || typeof state !== 'object') {
    // 通道没回话：页面留着当前样子，别把界面擦白了。
    renderPreview();
    return;
  }
  files = Array.isArray(state.files) ? state.files.map((f) => f.path).filter(Boolean) : files;
  undoCount = Number(state.undoCount) || 0;
  // 已经在「重新命名为」tab 里，拖进来的又是一批：顺手把编号勾上。
  maybeAutoNumbering();
  renderUndo();
  renderPreview();
  if (state.report?.message) setStatus(state.report.message);
  else if (state.status) setStatus(state.status);
}

/** 动作没成功：至少让状态行说一句，别无声失败。 */
function actAndApply(actionId, payload) {
  return surface.act(actionId, payload)
    .then(applyState)
    .catch((err) => setStatus(`出错了：${err?.message ?? err}`));
}

function setStatus(text) {
  surface.setStatus(text ?? '');
}

/** 面板里的形态：选完/拖完自动脱离成独立窗口。 */
const detachAfter = () => (surface.inPanel ? { detach: true } : {});

function pickFiles() {
  actAndApply('pick-files', detachAfter());
}

// ---------------------------------------------------------------- 动作

el.clear.addEventListener('click', () => actAndApply('clear-files'));
el.undo.addEventListener('click', () => actAndApply('undo'));
el.apply.addEventListener('click', () => {
  if (el.apply.disabled) return;
  el.apply.disabled = true;
  actAndApply('apply', { rules: readRules() });
});

// 拖拽框本身：点它 = 选文件（面板里选完自动脱离成独立窗口）。
el.drop.addEventListener('click', pickFiles);
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pickFiles();
  }
});

// ---------------------------------------------------------------- 拖拽

/**
 * 从壳转发过来的文件消息：壳（面板 / 独立窗口的壳）收下拖到
 * iframe 上的文件，换成路径发过来（iframe 自己接不住 OS 的文件拖拽）。
 * 小部件形态下没有壳、window.plugin 就在页面自己身上，走的是原生 drop。
 */
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const d = e?.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'desk-pet:file-dragenter') {
    document.body.classList.add('dragging');
    return;
  }
  if (d.type === 'desk-pet:file-dragleave') {
    document.body.classList.remove('dragging');
    return;
  }
  if (d.type === 'desk-pet:file-drop') {
    document.body.classList.remove('dragging');
    if (!Array.isArray(d.paths) || d.paths.length === 0) return;
    actAndApply('add-files', { paths: d.paths, ...detachAfter() });
  }
});

/**
 * 拖进来的 File 要拿到完整路径——Electron 32 起 File.path 被移除了，
 * 路径只能由 preload 用 webUtils 取。三种形态分别认三处：
 * 小部件（页面自己身上）、独立窗口（壳上）、面板（面板上）。
 * 都拿不到就不加，并说一句。
 */
function resolvePathForFile() {
  try {
    if (typeof window.plugin?.pathForFile === 'function') return window.plugin.pathForFile;
    const parent = window.parent;
    if (parent && parent !== window) {
      if (typeof parent.plugin?.pathForFile === 'function') return (f) => parent.plugin.pathForFile(f);
      if (typeof parent.panel?.pathForFile === 'function') return (f) => parent.panel.pathForFile(f);
    }
  } catch {
    // 跨域读父页面会炸：当成「拖拽不可用」，点拖拽框选文件照样能用。
  }
  return null;
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const list = [...(e.dataTransfer?.files ?? [])];
  if (list.length === 0) return;
  const pathForFile = resolvePathForFile();
  if (!pathForFile) {
    setStatus('拖进来的文件拿不到路径（页面没有预加载脚本）——点拖拽框选文件吧');
    return;
  }
  const paths = list.map((f) => pathForFile(f)).filter(Boolean);
  if (paths.length === 0) {
    setStatus('拖进来的都拿不到路径');
    return;
  }
  actAndApply('add-files', { paths, ...detachAfter() });
});

// 别处加了文件（比如面板拖进来的那一份）：两边都要跟上。
surface.onData(applyState);

// ---------------------------------------------------------------- 首份数据

surface.data().then(applyState);
