// plugins/screen-recorder/pages/studio.js
/**
 * 录屏的主界面。
 *
 * 三个 tab（全屏 / 选取 / 窗口）**在本地切换**：切 tab 不问主进程，
 * 所以没有等待、没有卡顿（用户最在意的那一点）。
 * 主进程只负责真正干活的事（列目标、取流、写文件）。
 *
 * 页面自己管三件事：
 * - 状态：主进程给什么就画什么（`data()` / `act()` 的回包 / `tick()`）；
 * - 动作：用户动了什么，送给主进程（`act()`）；
 * - 高度：面板的窗口是按内容撑开的，页面要报自己的高度。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';

const surface = bindSurface();

/**
 * 面板里与独立窗口里，高度策略是**相反**的：
 *
 * - 面板的窗口按内容撑开：页面报多高，面板就开多高。
 *   所以面板里不能按视口高度铺满（铺满了就与面板互相卡住）。
 * - 独立窗口的高度是用户拖出来的：按视口铺满才对。
 *
 * CSS 靠 body 上的这个类分档（见 studio.css）。
 */
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const $ = (id) => document.getElementById(id);

const el = {
  tabs: [...document.querySelectorAll('.tab')],
  panes: [...document.querySelectorAll('.pane')],
  gear: $('gearBtn'),
  refresh: $('refreshBtn'),
  drawer: $('drawer'),
  scrim: $('scrim'),
  drawerClose: $('drawerClose'),
  screenPicker: $('screenPicker'),
  screenGrid: $('screenGrid'),
  screenEmpty: $('screenEmpty'),
  regionSize: $('regionSize'),
  windowList: $('windowList'),
  windowEmpty: $('windowEmpty'),
  micSelect: $('micSelect'),
  speakerSelect: $('speakerSelect'),
  formatGroup: $('formatGroup'),
  gifNote: $('gifNote'),
  recordBtn: $('recordBtn'),
  hotkeyError: $('hotkeyError'),
  statusText: $('statusText'),
  elapsed: $('elapsed'),
  outputDir: $('outputDir'),
  outputDirHint: $('outputDirHint'),
  hotkeyStart: $('hotkeyStart'),
  hotkeyStop: $('hotkeyStop'),
  recordStartKey: $('recordStartKey'),
  recordStopKey: $('recordStopKey'),
  pickDir: $('pickDir'),
  openDir: $('openDir'),
  fps: $('fps'),
  gifWidth: $('gifWidth'),
  gifFps: $('gifFps'),
  qVideo: $('qVideo'),
  qGif: $('qGif'),
  qVideoTag: $('qVideoTag'),
  qGifTag: $('qGifTag'),
};

/** 主进程给的状态。 */
let state = null;
/** 当前 tab。切 tab 不等主进程，所以它先住在本地。 */
let mode = 'screen';
/**
 * 切 tab 的序号。
 *
 * 每次切一下加一，回包带着自己那次的序号回来——
 * 连着点好几个 tab 时，回包不一定按点的顺序到，
 * 序号对不上的回包不碰 tab（不然界面会跳回中间那个）。
 */
let modeSeq = 0;
/** 正在录快捷键的是哪一个：'start' / 'stop' / ''。 */
let capturing = '';
/** 麦克风设备列表（页面自己 enumerate 出来的）。 */
let micDevices = [];
/** 设备名要权限才有；没要到就显示「麦克风 1、2、3」。 */
let micLabelsKnown = false;

const MODE_LABELS = { screen: '全屏', region: '选取', window: '窗口' };

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/**
 * 送一个动作给主进程，顺手把回来的状态画上去。
 *
 * 主进程回的是**完整的一份状态**：动作之后界面不用自己猜该变成什么样。
 *
 * @param {string} actionId
 * @param {object} [payload]
 * @param {number} [seq] 这一次动作的序号（切 tab 时用来认「回包是不是过期了」）
 * @param {{keepScreen?: boolean}} [opts] keepScreen：回包**不改**选中的屏幕
 */
async function act(actionId, payload, seq, opts = {}) {
  try {
    const next = await surface.act(actionId, payload);
    if (next && typeof next === 'object') {
      applyState(next, seq, opts);
    }
  } catch (err) {
    setStatus(`做不了：${err?.message || err}`);
  }
}

/**
 * 把一份状态合进来（tick 只带变化的那几个字段）。
 *
 * @param {object} next
 * @param {number} [seq] 切 tab 的序号：**过期的回包不改 tab**。
 *   连着点三个 tab，三份回包不一定按点的顺序回来——
 *   不认序号的话，界面会跳回中间那个 tab。
 * @param {{keepScreen?: boolean}} [opts] keepScreen：回包**不改**选中的屏幕
 */
function applyState(next, seq, opts = {}) {
  const merged = { ...(state || {}), ...next };
  // tab 以本地的为准：用户刚点的那个就是当前这个。
  if (next.mode && (seq === undefined || seq === modeSeq)) mode = next.mode;
  // 屏幕也一样：点一下就本地选定了，回包不再改它——
  // 连着点两个屏时，先发出去的那个回包会把界面拉回上一个屏。
  if (opts.keepScreen) {
    merged.selectedScreenId = state?.selectedScreenId ?? next.selectedScreenId;
  }
  state = merged;
  render();
}

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------

function setStatus(text) {
  el.statusText.textContent = text || '';
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function render() {
  if (!state) return;

  // —— tab ——
  for (const tab of el.tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  }
  for (const pane of el.panes) {
    pane.hidden = pane.dataset.pane !== mode;
  }
  // 屏幕的选择器：全屏与选取都用它（选取时框在哪块屏上），
  // 窗口模式用不上——那里录的是窗口，不是屏。
  el.screenPicker.hidden = mode === 'window';

  // —— 屏幕：预览图 + 点选 ——
  renderScreenGrid();

  // —— 选取 ——
  el.regionSize.textContent = state.regionSize ? `上一次框的是 ${state.regionSize}` : '';

  // —— 窗口：列表（图标 + 名字）——
  renderWindowList();

  // —— 右边：声音与格式 ——
  renderMicOptions();
  el.speakerSelect.value = state.speaker ? 'on' : 'off';
  for (const btn of el.formatGroup.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.format === state.format));
  }
  el.gifNote.hidden = state.format !== 'gif';

  // —— 录制按钮 ——
  const recording = Boolean(state.recording);
  el.recordBtn.textContent = recording ? '停止录制' : mode === 'region' ? '框选并录制' : '开始录制';
  el.recordBtn.classList.toggle('danger', recording);

  // —— 底部 ——
  setStatus(state.status || '');
  el.elapsed.textContent = recording ? formatElapsed(state.elapsedMs) : '';

  // —— 错误提示 ——
  el.hotkeyError.hidden = !state.hotkeyError;
  el.hotkeyError.textContent = state.hotkeyError || '';

  renderDrawer();
}

/**
 * 屏幕列表：每块屏一张预览图，点一下就选中。
 *
 * **变了才重画**：预览图每块几十 KB，
 * 每半秒推一次状态就重画一次 = 每半秒把图重新解码一遍。
 */
function renderScreenGrid() {
  const screens = state.screens || [];
  const previews = state.previews || [];
  // 签名带上预览图的长度：图换了（刷新）长度多半会变；
  // 长度没变就当没变——真变了重画一次也就多几十毫秒。
  const sig = [
    screens.map((s) => `${s.id}|${s.label}|${s.meta || ''}`).join('\n'),
    state.selectedScreenId,
    previews.map((p) => `${p.id}:${(p.preview || '').length}`).join(','),
  ].join('||');
  if (sig === lastSig.screens) return;
  lastSig.screens = sig;

  el.screenEmpty.hidden = screens.length > 0;
  el.screenGrid.textContent = '';
  const previewById = new Map(previews.map((p) => [p.id, p.preview || '']));
  for (const item of screens) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'screen-card';
    card.dataset.id = item.id;
    const active = item.id === state.selectedScreenId;
    card.classList.toggle('active', active);
    card.setAttribute('aria-pressed', String(active));

    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    const src = previewById.get(item.id);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      thumb.append(img);
    } else {
      // 预览图还没到：先占个位，别让卡片忽高忽低。
      thumb.classList.add('pending');
      thumb.textContent = '…';
    }

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label || item.id;

    card.append(thumb, label);
    if (item.meta) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.meta;
      card.append(meta);
    }
    el.screenGrid.append(card);
  }
}

/** 填一个下拉框。 */
function fillSelect(select, options, value) {
  const current = value ?? select.value;
  select.textContent = '';
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
  if (current && options.some((o) => String(o.value) === String(current))) {
    select.value = String(current);
  }
}

/**
 * 上一次画成什么样。
 *
 * **每半秒会重画一次**（tick 推一次状态就画一次），
 * 所以列表与下拉框只在**真的变了**时才重建 DOM：
 * 重建会把打开着的下拉框关掉、把列表的滚动位置弄丢，
 * 图标还得重新加载一遍（闪一下）。
 */
const lastSig = { screens: '', windows: '', mics: '' };

/** 一组条目的签名：变了才值得重画。 */
function signatureOf(items) {
  return items.map((item) => `${item.id}|${item.label}|${item.icon ? 'i' : ''}`).join('\n');
}

/** 窗口列表：图标 + 名字。 */
function renderWindowList() {
  const windows = state.windows || [];
  const sig = `${signatureOf(windows)}|${state.selectedWindowId}`;
  if (sig === lastSig.windows) return;
  lastSig.windows = sig;

  el.windowList.textContent = '';
  el.windowEmpty.hidden = windows.length > 0;
  for (const item of windows) {
    const li = document.createElement('li');
    li.classList.toggle('active', item.id === state.selectedWindowId);
    const icon = document.createElement('img');
    icon.className = 'win-icon';
    icon.alt = '';
    if (item.icon) {
      icon.src = item.icon;
    } else {
      // 没有图标就用一个占位的小方块：总比空着强。
      icon.classList.add('fallback');
      icon.removeAttribute('src');
      icon.textContent = '▣';
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label || item.id;
    li.append(icon, label);
    li.addEventListener('click', () => {
      act('select-window', { id: item.id });
    });
    el.windowList.append(li);
  }
}

/** 麦克风下拉框。 */
function renderMicOptions() {
  const options = [{ value: 'off', label: '不录麦克风' }];
  micDevices.forEach((device, index) => {
    options.push({
      value: String(index),
      label: device.label || `麦克风 ${index + 1}`,
    });
  });
  if (!micDevices.length) {
    options.push({ value: '0', label: '默认麦克风' });
  }
  const want = state.mic ? String(state.micDeviceIndex ?? 0) : 'off';
  const sig = `${options.map((o) => `${o.value}|${o.label}`).join('\n')}|${want}`;
  if (sig === lastSig.mics) return;
  lastSig.mics = sig;
  fillSelect(el.micSelect, options, want);
}

/**
 * 抽屉里的设置。
 *
 * 抽屉分三块：存放位置、快捷键、录制质量。
 * 每块画的都是**当前状态**，不回显用户正在输的那一下——
 * 输入框正被 focused 的时候不碰它的值，不然打字打到一半被抹掉。
 */
function renderDrawer() {
  // —— 存放位置 ——
  if (document.activeElement !== el.outputDir) el.outputDir.value = state.outputDir || '';
  el.outputDirHint.textContent = state.outputDir
    ? '录制文件直接存进这个文件夹，名字带日期时间。'
    : `没设就存到系统的视频文件夹：${state.outputDirResolved || ''}`;

  // —— 快捷键 ——
  // 正在录键的那一个不画：它自己显示「按下新的组合键…」。
  if (!capturing) {
    setHotkey(el.hotkeyStart, state.hotkey);
    setHotkey(el.hotkeyStop, state.stopHotkey);
  }

  // —— 录制质量 ——
  if (document.activeElement !== el.fps) el.fps.value = String(state.fps ?? 30);
  if (document.activeElement !== el.gifWidth) el.gifWidth.value = String(state.gifWidth ?? 480);
  if (document.activeElement !== el.gifFps) el.gifFps.value = String(state.gifFps ?? 12);

  // 视频与 GIF 的档位各管各的：当前格式的那块标「当前」，
  // 另一块标「当前不用」——别让人以为录视频时 GIF 的数字也起作用。
  const gif = state.format === 'gif';
  setQualityBlock(el.qVideo, el.qVideoTag, !gif);
  setQualityBlock(el.qGif, el.qGifTag, gif);
}

/** 把一个快捷键画到键帽上。 */
function setHotkey(node, accel) {
  const text = prettyAccel(accel);
  node.textContent = text || '没设置';
  node.title = accel || '';
}

/**
 * 把「Control+Shift+R」显示成「Ctrl + Shift + R」。
 *
 * 只是**显示**用的：存进配置的仍然是 Electron 的写法，
 * 免得改了显示又改了存法（两套写法迟早对不上）。
 */
function prettyAccel(accel) {
  const names = { Control: 'Ctrl', Super: 'Win', Return: 'Enter', Escape: 'Esc' };
  return String(accel || '')
    .split('+')
    .map((part) => names[part] || part)
    .filter(Boolean)
    .join(' + ');
}

/** 一块录制质量：标出它是当前格式还是当前不用。 */
function setQualityBlock(block, tag, active) {
  block.dataset.active = String(active);
  tag.textContent = active ? '当前' : '当前不用';
}

// ---------------------------------------------------------------------------
// 抽屉
// ---------------------------------------------------------------------------

function openDrawer() {
  el.drawer.hidden = false;
  el.scrim.hidden = false;
  // 下一帧再挂 .open：少了这一下就没有滑进来的动画。
  requestAnimationFrame(() => el.drawer.classList.add('open'));
}

function closeDrawer() {
  el.drawer.classList.remove('open');
  el.scrim.hidden = true;
  // 滑回去再藏起来，不然是「啪」地一下消失。
  setTimeout(() => {
    if (!el.drawer.classList.contains('open')) el.drawer.hidden = true;
  }, 180);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

// —— tab：本地切换，主进程在后面记一下 ——
for (const tab of el.tabs) {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    const seq = ++modeSeq;
    render();
    void act('mode', { mode }, seq);
  });
}

el.gear.addEventListener('click', openDrawer);
el.drawerClose.addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);

// 刷新可录的目标：这是**动作**不是设置，所以按钮在顶栏上，不在抽屉里。
el.refresh.addEventListener('click', () => void act('refresh'));

// —— 全屏：点预览图就选中 ——
el.screenGrid.addEventListener('click', (event) => {
  const card = event.target.closest?.('.screen-card');
  if (!card) return;
  const id = card.dataset.id;
  if (!id || id === state?.selectedScreenId) return;
  // **本地立刻选中**：选中这件事根本不用等主进程——
  // 等一次往返就是一次能感觉到的卡顿。
  state = { ...(state || {}), selectedScreenId: id };
  render();
  // 配置在后面悄悄存：界面已经是选好的了，存盘慢一点也不影响。
  void act('select-screen', { id }, undefined, { keepScreen: true });
});

// —— 窗口 ——
// （点条目的事在 renderWindowList 里挂好了）

// —— 声音 ——
el.micSelect.addEventListener('change', () => {
  const value = el.micSelect.value;
  if (value === 'off') {
    void act('mic', { on: false, index: 0 });
  } else {
    void act('mic', { on: true, index: Number(value) || 0 });
  }
});

// 设备名要权限才有。用户真的要用麦克风时才去要：
// 一上来就开麦，系统托盘会闪一个「麦克风在使用」。
el.micSelect.addEventListener('mousedown', () => {
  void unlockMicLabels();
});

el.speakerSelect.addEventListener('change', () => {
  void act('speaker', { on: el.speakerSelect.value === 'on' });
});

// —— 格式 ——
for (const btn of el.formatGroup.querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    void act('format', { format: btn.dataset.format });
  });
}

// —— 录制 ——
el.recordBtn.addEventListener('click', () => {
  if (state?.recording) void act('stop');
  else void act(mode === 'region' ? 'pick-region' : 'start');
});

// —— 抽屉里的设置 ——
el.outputDir.addEventListener('change', () => {
  void act('config', { outputDir: el.outputDir.value.trim() });
});
el.pickDir.addEventListener('click', () => void act('pick-dir'));
el.openDir.addEventListener('click', () => void act('open-dir'));

for (const [input, key] of [
  [el.fps, 'fps'],
  [el.gifWidth, 'gifWidth'],
  [el.gifFps, 'gifFps'],
]) {
  input.addEventListener('change', () => {
    void act('config', { [key]: Number(input.value) });
  });
}

// —— 快捷键：在页面里捕获按键 ——
el.recordStartKey.addEventListener('click', () => startCapture('start', el.hotkeyStart));
el.recordStopKey.addEventListener('click', () => startCapture('stop', el.hotkeyStop));

function startCapture(which, input) {
  capturing = which;
  input.textContent = '按下新的组合键…';
  input.classList.add('capturing');
}

/** 按键 → Electron 的快捷键写法。 */
function toAccelerator(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  const code = event.code || '';
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F[0-9]{1,2}$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  else if (code === 'Enter') key = 'Return';
  else if (code === 'Escape') key = 'Escape';
  else if (code === 'Backspace') key = 'Backspace';
  else if (code.startsWith('Arrow')) {
    key = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[code] || '';
  }
  if (!key) return '';
  // 裸键会劫持所有的字母键，不要。
  if (!parts.length) return '';
  return [...parts, key].join('+');
}

document.addEventListener('keydown', (event) => {
  if (!capturing) return;
  event.preventDefault();
  if (event.key === 'Escape') {
    stopCapture();
    renderDrawer();
    return;
  }
  const accel = toAccelerator(event);
  if (!accel) return;
  const which = capturing;
  stopCapture();
  void act('hotkey', { which, accel });
});

/** 不再等按键了。键帽上那个「正在录」的样式也要摘掉。 */
function stopCapture() {
  capturing = '';
  el.hotkeyStart.classList.remove('capturing');
  el.hotkeyStop.classList.remove('capturing');
}

// ---------------------------------------------------------------------------
// 麦克风设备
// ---------------------------------------------------------------------------

/** 列出麦克风。设备名要权限才有，没权限就显示序号。 */
async function loadMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    micDevices = devices.filter((d) => d.kind === 'audioinput');
    micLabelsKnown = micDevices.some((d) => Boolean(d.label));
  } catch {
    micDevices = [];
  }
  render();
}

/**
 * 要一次麦克风权限，把设备名要出来。
 *
 * 只在用户真的去点麦克风下拉框时才做——一上来就开麦，
 * 系统托盘会闪一个「麦克风在使用」，那才叫吓人。
 */
async function unlockMicLabels() {
  if (micLabelsKnown) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // 要不到就算了：下面显示序号，一样能用。
  }
  await loadMicDevices();
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

/*
 * 首份数据**只从推来的那条路拿**，页面自己不去拉。
 *
 * 早先这里还调了一次 `surface.data()`：面板那边已经在拉一份了，
 * 页面又拉一份——首份数据要算两遍（列目标、抓预览都做两遍，
 * 实测首开 1.4 秒，两次拉就只省一半）。
 *
 * 现在推来的那份一定会到：宿主推早了、页面还没订阅的，
 * preload 会把那份留着，订阅时补上（见 src/preload/panel.cjs
 * 与 plugin.cjs 的 pendingData）。
 */

void loadMicDevices();

// —— 报高度：面板的窗口是按内容撑开的 ——
function reportHeight() {
  requestAnimationFrame(() => {
    // 量**内容**的高度，不是视口的。
    //
    // documentElement.scrollHeight 至少是视口那么高：
    // iframe 比内容高的时候它会多报，主进程按多报的高度开窗，
    // 窗口就再也缩不回去了（底下留一块空白）。
    //
    // **向上取整**：量出来的是带小数的真实高度（512.17 之类），
    // 少报一像素的话 iframe 比内容矮那么一点，
    // 页面里就会冒出一条竖着的滚动条——
    // 有滚动条就窄一点，内容又变高一点，于是宽度与高度互相追着跑。
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
window.__studio = {
  get state() {
    return state;
  },
  get mode() {
    return mode;
  },
};
