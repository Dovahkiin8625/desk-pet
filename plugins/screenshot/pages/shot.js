// plugins/screenshot/pages/shot.js
/**
 * 截图插件的页面。
 *
 * 页面只有两样东西：一个按钮（开始截图）和设置。
 * 框选、标注、工具条都在**桌面上的遮罩**里，不在这儿。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { hydrateIcons } from '/src/renderer/ui/icons.js';
import { createDrawer } from '/src/renderer/ui/drawer.js';
import { initPersonaName } from '/src/renderer/ui/persona.js';
import { accelFromEvent, describeAccel } from '../lib/accelerator.js';

// 页面里凡是写死「桌宠」的地方，换成人设名（默认「小桌」）。
initPersonaName();

const surface = bindSurface();

hydrateIcons();

document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const $ = (id) => document.getElementById(id);

const el = {
  shotBtn: $('shotBtn'),
  statusText: $('statusText'),
  gearBtn: $('gearBtn'),
};

/** 主进程给的状态。 */
let state = null;

/** 面板里报的高度：定值（与清单里的 window.height 一致）。 */
const PANEL_HEIGHT = 260;
let panelHeightReported = false;

// ---------------------------------------------------------------------------
// 设置抽屉
// ---------------------------------------------------------------------------

const drawer = createDrawer({ button: el.gearBtn });

const languageSelect = document.createElement('select');
const languageField = document.createElement('label');
languageField.className = 'dp-field';
languageField.append(
  Object.assign(document.createElement('span'), { textContent: '识别语言' }),
  languageSelect
);

const languageHint = document.createElement('p');
languageHint.className = 'dp-field-hint';
languageHint.textContent = '「自动」用系统的中英双语识别：汉字认得准，英文也认得准。';

const saveDirInput = document.createElement('input');
saveDirInput.type = 'text';
saveDirInput.placeholder = '图片文件夹下的「截图」子目录';
const saveDirField = document.createElement('label');
saveDirField.className = 'dp-field';
saveDirField.append(
  Object.assign(document.createElement('span'), { textContent: '保存目录' }),
  saveDirInput
);

const saveDirHint = document.createElement('p');
saveDirHint.className = 'dp-field-hint';
saveDirHint.textContent = '留空就用图片文件夹下的「截图」子目录；保存时还能在「另存为」对话框里再换。';

// —— 全局快捷键 ——
// 键帽摆成只读的（不能直接打字），靠「改」录一个组合；
// 留空 = 不设这个快捷键。
const hotkeyTitle = document.createElement('p');
hotkeyTitle.className = 'dp-section-title';
hotkeyTitle.textContent = '全局快捷键';

const hotkeyRow = document.createElement('div');
hotkeyRow.className = 'hk-row';
const hotkeyKey = document.createElement('kbd');
hotkeyKey.className = 'hk-key';
const recordHotkeyBtn = document.createElement('button');
recordHotkeyBtn.type = 'button';
recordHotkeyBtn.className = 'dp-button small';
recordHotkeyBtn.textContent = '改';
recordHotkeyBtn.title = '改「全局快捷键」';
const clearHotkeyBtn = document.createElement('button');
clearHotkeyBtn.type = 'button';
clearHotkeyBtn.className = 'dp-button small';
clearHotkeyBtn.textContent = '清除';
clearHotkeyBtn.title = '不设这个快捷键';
hotkeyRow.append(hotkeyKey, recordHotkeyBtn, clearHotkeyBtn);

const hotkeyHint = document.createElement('p');
hotkeyHint.className = 'dp-field-hint';
hotkeyHint.textContent = '按下就直接开始截图（桌宠启动就生效）。';

const hotkeyError = document.createElement('p');
hotkeyError.className = 'hotkey-error';
hotkeyError.hidden = true;

drawer.body.append(
  languageField,
  languageHint,
  saveDirField,
  saveDirHint,
  hotkeyTitle,
  hotkeyRow,
  hotkeyHint,
  hotkeyError
);

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

async function act(actionId, payload) {
  try {
    const next = await surface.act(actionId, payload);
    if (next && typeof next === 'object') applyState(next);
  } catch (err) {
    setStatus(`做不了：${err?.message || err}`);
  }
}

el.shotBtn.addEventListener('click', () => act('shot', {}));

languageSelect.addEventListener('change', () => {
  act('setting', { key: 'language', value: languageSelect.value });
});

saveDirInput.addEventListener('change', () => {
  act('setting', { key: 'saveDir', value: saveDirInput.value });
});

// —— 全局快捷键：在页面里捕获按键 ——
let capturing = false;

recordHotkeyBtn.addEventListener('click', () => {
  capturing = true;
  hotkeyKey.textContent = '按下新的组合键…';
  hotkeyKey.classList.add('capturing');
});

clearHotkeyBtn.addEventListener('click', () => {
  capturing = false;
  hotkeyKey.classList.remove('capturing');
  void act('setting', { key: 'hotkey', value: '' });
});

document.addEventListener('keydown', (event) => {
  if (!capturing) return;
  event.preventDefault();
  if (event.key === 'Escape') {
    capturing = false;
    hotkeyKey.classList.remove('capturing');
    render();
    return;
  }
  // 裸键不要：它会劫持用户所有的字母键。
  const accel = accelFromEvent(event);
  if (!accel) return;
  capturing = false;
  hotkeyKey.classList.remove('capturing');
  void act('setting', { key: 'hotkey', value: accel });
});

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------

function setStatus(text) {
  el.statusText.textContent = text || '';
}

function render() {
  if (!state) return;
  el.shotBtn.disabled = Boolean(state.busy);
  languageSelect.value = state.language || '自动';
  if (document.activeElement !== saveDirInput) saveDirInput.value = state.saveDir || '';
  if (!capturing) {
    hotkeyKey.textContent = describeAccel(state.hotkey) || '没设置';
    hotkeyKey.title = state.hotkey || '';
  }
  clearHotkeyBtn.disabled = !state.hotkey;
  if (state.hotkeyError) {
    hotkeyError.textContent = state.hotkeyError;
    hotkeyError.hidden = false;
  } else {
    hotkeyError.textContent = '';
    hotkeyError.hidden = true;
  }
  setStatus(state.status || '');
}

function applyState(next) {
  state = { ...(state || {}), ...next };
  render();
}

// ---------------------------------------------------------------------------
// 数据与高度
// ---------------------------------------------------------------------------

surface.onData((data) => applyState(data));
surface.data().then((data) => {
  if (data) applyState(data);
});

function reportHeight() {
  if (surface.inPanel) {
    if (panelHeightReported) return;
    panelHeightReported = true;
    surface.setHeight(PANEL_HEIGHT);
    return;
  }
  requestAnimationFrame(() => {
    const rect = document.body.getBoundingClientRect();
    const height = Math.ceil(Math.max(rect.height, document.body.scrollHeight));
    surface.setHeight(height);
  });
}

if (!surface.inPanel && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => reportHeight()).observe(document.body);
}
window.addEventListener('resize', reportHeight);
reportHeight();
