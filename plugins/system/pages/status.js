// plugins/system/pages/status.js
/**
 * 系统状态的面板（面板工作台与独立窗口里是同一份）。
 *
 * 页面只管三件事：
 *
 * - **画**：主进程给什么就画什么（首份、每秒推来的新状态、动作的回包）；
 * - **送动作**：抽屉里那个开关要告诉主进程；
 * - **报高度**：面板的窗口是按内容撑开的，页面要报自己的高度。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { createDrawer } from '/src/renderer/ui/drawer.js';

const surface = bindSurface();

/**
 * 面板里与独立窗口里，高度策略是**相反**的：
 * 面板的窗口按内容撑开，独立窗口的高度是用户拖出来的。
 * CSS 靠 body 上的这个类分档（见 status.html）。
 */
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const el = {
  meters: document.getElementById('meters'),
  info: document.getElementById('info'),
  gear: document.getElementById('gearBtn'),
};

/** 主进程给的状态。 */
let state = null;

/**
 * 三条用量：建一次，之后只改数值。
 *
 * 重建的话，进度条每秒都从头长一遍——看着像闪了一下。
 */
const rows = ['CPU', '内存', 'GPU'].map((title) => {
  const row = document.createElement('div');
  row.className = 'meter';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = title;

  const track = document.createElement('span');
  track.className = 'track';
  const fill = document.createElement('i');
  track.append(fill);

  const value = document.createElement('span');
  value.className = 'value';

  const note = document.createElement('span');
  note.className = 'note';

  row.append(name, track, value, note);
  el.meters.append(row);
  return { row, fill, value, note };
});

// ---------------------------------------------------------------------------
// 抽屉：过热提醒
// ---------------------------------------------------------------------------

const drawer = createDrawer({ button: el.gear });

const field = document.createElement('label');
field.className = 'dp-field';
const fieldName = document.createElement('span');
fieldName.textContent = '过热时提醒我';
const hotAlert = document.createElement('input');
hotAlert.id = 'hotAlert';
hotAlert.type = 'checkbox';
field.append(fieldName, hotAlert);

const hint = document.createElement('p');
hint.className = 'dp-field-hint';
hint.textContent = '机器热到不行时，桌宠在气泡里说一声。';

drawer.body.append(field, hint);

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------

/** 画一条用量。采不到的数（null）就画成空条——报 0% 是在说谎。 */
function setMeter(row, percent, note) {
  const known = typeof percent === 'number' && Number.isFinite(percent);
  row.fill.style.width = known ? `${Math.max(0, Math.min(100, percent))}%` : '0%';
  row.value.textContent = known ? `${Math.round(percent)}%` : '—';
  row.row.classList.toggle('hot', known && percent >= 85);
  row.note.textContent = note || '';
}

/** 显存：用了多少、一共多少。 */
function vramText(gpu) {
  if (!gpu || typeof gpu.memUsed !== 'number' || typeof gpu.memTotal !== 'number') return '';
  const gb = (mb) => `${(mb / 1024).toFixed(1)}G`;
  return `显存 ${gb(gpu.memUsed)}/${gb(gpu.memTotal)}`;
}

function render() {
  if (!state) return;
  setMeter(rows[0], state.cpu, '');
  setMeter(rows[1], state.memory, state.memoryText || '');
  setMeter(rows[2], state.gpu?.util ?? null, state.gpu?.name || '');

  const parts = [];
  if (state.thermalText) parts.push(`温度 ${state.thermalText}`);
  if (state.onBattery === true) parts.push('电池供电');
  else if (state.onBattery === false) parts.push('已接电');
  const vram = vramText(state.gpu);
  if (vram) parts.push(vram);
  el.info.textContent = parts.join(' · ') || '状态未知';

  if (hotAlert.checked !== Boolean(state.hotAlert)) hotAlert.checked = Boolean(state.hotAlert);
}

function applyState(next) {
  if (!next) return;
  state = { ...state, ...next };
  render();
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 送一个动作给主进程，顺手把回来的状态画上去。 */
async function act(actionId, payload) {
  try {
    const next = await surface.act(actionId, payload);
    if (next && typeof next === 'object') {
      applyState(next);
      // 主进程回的那句话（做了什么）摆在底下那行字里。
      if (next.message) surface.setStatus(next.message);
    }
  } catch (err) {
    el.info.textContent = `做不了：${err?.message || err}`;
  }
}

hotAlert.addEventListener('change', () => {
  void act('hot-alert', { enabled: hotAlert.checked });
});

// ---------------------------------------------------------------------------
// 数据与高度
// ---------------------------------------------------------------------------

surface.onData((data) => applyState(data));
surface.onTick((data) => applyState(data));
void surface.data().then((data) => applyState(data));

function reportHeight() {
  requestAnimationFrame(() => {
    // 量**内容**的高度，不是视口的（见插件开发指南）。
    const rect = document.body.getBoundingClientRect();
    surface.setHeight(Math.ceil(Math.max(rect.height, document.body.scrollHeight)));
  });
}

if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => reportHeight()).observe(document.body);
}
window.addEventListener('resize', reportHeight);
reportHeight();
