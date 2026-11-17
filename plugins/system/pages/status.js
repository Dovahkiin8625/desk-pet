// plugins/system/pages/status.js
/**
 * 系统状态的面板（面板工作台与独立窗口里是同一份）。
 *
 * 页面只管三件事：
 *
 * - **画**：主进程给什么就画什么（首份、每秒推来的新状态、动作的回包）；
 * - **送动作**：抽屉里那个开关要告诉主进程；
 * - **报高度**：面板里报一个定值（plugin.json 的 window.height），数据再多也不变。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { createDrawer } from '/src/renderer/ui/drawer.js';
import { hydrateIcons, iconSvg } from '/src/renderer/ui/icons.js';
import { formatNetworkShort } from '/src/shared/network.js';
import { initPersonaName } from '/src/renderer/ui/persona.js';

// 页面里凡是写死「桌宠」的地方，换成人设名（默认「小桌」）。
initPersonaName();

const surface = bindSurface();

// 页面里的占位图标换成真的 SVG（图标只有一份，见 src/shared/icons.js）。
hydrateIcons();

/**
 * 面板里与独立窗口里，高度策略不一样：
 * 面板的窗口是定高的（页面报一个定值），独立窗口的高度是用户拖出来的。
 * CSS 靠 body 上的这个类分档（见 status.html）。
 */
document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const el = {
  meters: document.getElementById('meters'),
  info: document.getElementById('info'),
  banner: document.getElementById('banner'),
  bannerText: document.getElementById('bannerText'),
  thermalTile: document.getElementById('thermalTile'),
  thermalText: document.getElementById('thermalText'),
  powerText: document.getElementById('powerText'),
  netTile: document.getElementById('netTile'),
  netText: document.getElementById('netText'),
  gear: document.getElementById('gearBtn'),
};

/** 主进程给的状态。 */
let state = null;

const CARDS = [
  { id: 'cpu', icon: 'cpu', label: 'CPU' },
  { id: 'memory', icon: 'memory', label: '内存' },
  { id: 'gpu', icon: 'monitor', label: 'GPU' },
];

/**
 * 三条用量：建一次，之后只改数值。
 *
 * 重建的话，进度条每秒都从头长一遍——看着像闪了一下。
 */
const cards = CARDS.map(({ id, icon, label }) => {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'stat-head';
  const tile = document.createElement('span');
  tile.className = 'stat-icon';
  tile.append(iconSvg(icon));
  const name = document.createElement('span');
  name.className = 'stat-label';
  name.textContent = label;
  head.append(tile, name);

  const value = document.createElement('div');
  value.className = 'stat-value';

  const track = document.createElement('div');
  track.className = 'track';
  const fill = document.createElement('i');
  track.append(fill);

  const note = document.createElement('div');
  note.className = 'stat-note';

  card.append(head, value, track, note);
  el.meters.append(card);
  return { id, card, fill, value, note };
});
const [cpuCard, memCard, gpuCard] = cards;

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
function setCard(card, percent, note) {
  const known = typeof percent === 'number' && Number.isFinite(percent);
  card.fill.style.width = known ? `${Math.max(0, Math.min(100, percent))}%` : '0%';
  card.value.textContent = known ? `${Math.round(percent)}%` : '—';
  card.card.classList.toggle('hot', known && percent >= 85);
  card.note.textContent = note || ' ';
}

/** 显存：用了多少、一共多少。 */
function vramText(gpu) {
  if (!gpu || typeof gpu.memUsed !== 'number' || typeof gpu.memTotal !== 'number') return '';
  const gb = (mb) => `${(mb / 1024).toFixed(1)}G`;
  return `显存 ${gb(gpu.memUsed)}/${gb(gpu.memTotal)}`;
}

/** 温度到这个档就该叫它一声：横幅与整格染红。 */
function isTooHot(thermal) {
  return thermal === 'serious' || thermal === 'critical';
}

function render() {
  if (!state) return;
  setCard(cpuCard, state.cpu, '');
  setCard(memCard, state.memory, state.memoryText || '');
  setCard(gpuCard, state.gpu?.util ?? null, state.gpu?.name || '');

  // 温度：横幅 + 整格染色（serious/critical 时才嚷嚷）。
  const hot = isTooHot(state.thermal);
  el.banner.hidden = !hot;
  if (hot) el.bannerText.textContent = `机器${state.thermalText || '很热'}，先歇一会儿或把负载降下来`;
  el.thermalTile.classList.toggle('hot', hot);
  el.thermalText.textContent = state.thermalText || '未知';

  el.powerText.textContent = state.onBattery === true ? '电池供电' : state.onBattery === false ? '已接电' : '—';

  const net = formatNetworkShort(state.network);
  el.netText.textContent = net || '—';
  el.netTile.title = net.length > 30 ? net : '';

  const vram = vramText(state.gpu);
  el.info.textContent = vram || (state.onBattery ? '电池供电中' : '状态正常');

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

/** 面板里插件页面的固定高度（= plugin.json 的 window.height）。 */
const PANEL_HEIGHT = 480;
/** 面板里只报一次：数据再多高度也不再变。 */
let panelHeightReported = false;

function reportHeight() {
  if (surface.inPanel) {
    if (panelHeightReported) return;
    panelHeightReported = true;
    surface.setHeight(PANEL_HEIGHT);
    return;
  }
  requestAnimationFrame(() => {
    // 量**内容**的高度，不是视口的（见插件开发指南）。
    const rect = document.body.getBoundingClientRect();
    surface.setHeight(Math.ceil(Math.max(rect.height, document.body.scrollHeight)));
  });
}

if (!surface.inPanel && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => reportHeight()).observe(document.body);
}
window.addEventListener('resize', reportHeight);
reportHeight();
