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
  drawer: $('drawer'),
  scrim: $('scrim'),
  drawerClose: $('drawerClose'),
  preview: $('screenPreview'),
  previewTip: $('previewTip'),
  screenSelect: $('screenSelect'),
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
  hotkeyStart: $('hotkeyStart'),
  hotkeyStop: $('hotkeyStop'),
  recordStartKey: $('recordStartKey'),
  recordStopKey: $('recordStopKey'),
  pickDir: $('pickDir'),
  openDir: $('openDir'),
  refreshTargets: $('refreshTargets'),
  fps: $('fps'),
  gifWidth: $('gifWidth'),
  gifFps: $('gifFps'),
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
 */
async function act(actionId, payload, seq) {
  try {
    const next = await surface.act(actionId, payload);
    if (next && typeof next === 'object') {
      applyState(next, seq);
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
 */
function applyState(next, seq) {
  const merged = { ...(state || {}), ...next };
  // tab 以本地的为准：用户刚点的那个就是当前这个。
  if (next.mode && (seq === undefined || seq === modeSeq)) mode = next.mode;
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

  // —— 全屏：预览 + 选屏 ——
  if (state.preview) {
    if (el.preview.getAttribute('src') !== state.preview) el.preview.src = state.preview;
  } else {
    el.preview.removeAttribute('src');
    el.previewTip.textContent = '正在取预览…';
  }
  const screens = (state.screens || []).map((s) => ({ value: s.id, label: s.label }));
  const screenSig = `${screens.map((s) => `${s.value}|${s.label}`).join('\n')}|${state.selectedScreenId}`;
  if (screenSig !== lastSig.screens) {
    lastSig.screens = screenSig;
    fillSelect(el.screenSelect, screens, state.selectedScreenId);
  }

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

/** 抽屉里的设置。 */
function renderDrawer() {
  if (document.activeElement !== el.outputDir) el.outputDir.value = state.outputDir || '';
  if (!capturing) {
    if (document.activeElement !== el.hotkeyStart) el.hotkeyStart.value = state.hotkey || '';
    if (document.activeElement !== el.hotkeyStop) el.hotkeyStop.value = state.stopHotkey || '';
  }
  if (document.activeElement !== el.fps) el.fps.value = String(state.fps ?? 30);
  if (document.activeElement !== el.gifWidth) el.gifWidth.value = String(state.gifWidth ?? 480);
  if (document.activeElement !== el.gifFps) el.gifFps.value = String(state.gifFps ?? 12);
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

// —— 全屏 ——
el.screenSelect.addEventListener('change', () => {
  void act('select-screen', { id: el.screenSelect.value });
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
el.refreshTargets.addEventListener('click', () => void act('refresh'));

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
  input.value = '按下新的组合键…';
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
    capturing = '';
    renderDrawer();
    return;
  }
  const accel = toAccelerator(event);
  if (!accel) return;
  const which = capturing;
  capturing = '';
  void act('hotkey', { which, accel });
});

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

// 首份数据：页面可能比数据晚一点（iframe 加载慢），两处都接上。
Promise.resolve(surface.data())
  .then((data) => {
    if (data) applyState(data);
  })
  .catch(() => {});

void loadMicDevices();

// —— 报高度：面板的窗口是按内容撑开的 ——
function reportHeight() {
  requestAnimationFrame(() => {
    const height = document.documentElement.scrollHeight || document.body.scrollHeight;
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
