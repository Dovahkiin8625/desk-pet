import { DEFAULT_VOLUME } from '../shared/volume.js';
import { parseTapLines } from '../shared/tapVoice.js';
import { resolveVoiceId, applyVoiceChoice } from '../shared/voiceChoice.js';
import {
  DISPATCH_MODES,
  dispatchModeInfo,
  APPROVAL_POLICIES,
  approvalPolicyInfo,
  THINK_LEVELS,
  ACK_DELAY_PRESETS,
  ACK_DELAY_OFF,
  ackPrefsFromValue,
  ackValueFromPrefs,
} from '../shared/assistant.js';
import {
  TOOL_APPROVAL,
  applyBatchEnabled,
  applyBatchApproval,
  selectAllState,
} from './toolBatch.js';

const modelSelect = document.getElementById('model');
const importModelBtn = document.getElementById('importModel');
const deleteModelBtn = document.getElementById('deleteModel');
const scaleInput = document.getElementById('scale');
const opacityInput = document.getElementById('opacity');
const scaleVal = document.getElementById('scaleVal');
const opacityVal = document.getElementById('opacityVal');
const status = document.getElementById('status');

// 桌面助理
//
// 剪贴板、天气、过热提醒的开关**不在这里**：它们是插件的配置，
// 归各自的插件页面管（面板里搜插件名就能打开）。
// 这里既不显示它们，也**不把它们写回去**——
// 补丁里带上一个旧值，用户在插件页面改过的设置就被这里悄悄覆盖了。
const chimeBox = document.getElementById('chime');
const greetingBox = document.getElementById('greeting');
const soundBox = document.getElementById('sound');

// 语音
const ttsEnabledBox = document.getElementById('ttsEnabled');
// 音色有两个控件：下拉框选常用音色，输入框填清单以外的 id。
// 哪个生效由 shared/voiceChoice.js 的 resolveVoiceId 说了算。
const voiceSelect = document.getElementById('voiceSelect');
const voiceInput = document.getElementById('voiceId');
const voiceList = document.getElementById('voiceList');
const voiceCurrent = document.getElementById('voiceCurrent');
const speedInput = document.getElementById('speed');
const speedVal = document.getElementById('speedVal');
const volumeInput = document.getElementById('volume');
const volumeVal = document.getElementById('volumeVal');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const clearKeyBtn = document.getElementById('clearKey');
const keyStatus = document.getElementById('keyStatus');

// 点桌宠时说的话
const tapTalkEnabledBox = document.getElementById('tapTalkEnabled');
const tapTalkModelSoundBox = document.getElementById('tapTalkModelSound');
const tapTalkLinesInput = document.getElementById('tapTalkLines');

// 对话
const llmEnabledBox = document.getElementById('llmEnabled');
const llmDispatchSelect = document.getElementById('llmDispatch');
const llmDispatchHint = document.getElementById('llmDispatchHint');
/** 派单模式的当前值：用户不点头切「只聊天」时，下拉框要退回这里。 */
let dispatchModeValue = 'auto';
const llmBaseUrlInput = document.getElementById('llmBaseUrl');
const llmModelInput = document.getElementById('llmModel');
const llmTemperatureInput = document.getElementById('llmTemperature');
const llmTemperatureVal = document.getElementById('llmTemperatureVal');
const llmMaxTokensSelect = document.getElementById('llmMaxTokens');
const llmTokensFieldSelect = document.getElementById('llmTokensField');
const llmThinkBox = document.getElementById('llmThink');
const llmThinkLevelSelect = document.getElementById('llmThinkLevel');
const llmApiKeyInput = document.getElementById('llmApiKey');
const saveLlmKeyBtn = document.getElementById('saveLlmKey');
const clearLlmKeyBtn = document.getElementById('clearLlmKey');
const llmKeyStatus = document.getElementById('llmKeyStatus');
const llmPersonaNameInput = document.getElementById('llmPersonaName');
const llmPersonaStyleInput = document.getElementById('llmPersonaStyle');
const llmPersonaBackstoryInput = document.getElementById('llmPersonaBackstory');
const llmProactiveBox = document.getElementById('llmProactive');
const llmProactiveIntervalSelect = document.getElementById('llmProactiveInterval');
const llmAckDelaySelect = document.getElementById('llmAckDelay');
const llmFactsList = document.getElementById('llmFacts');
const clearFactsBtn = document.getElementById('clearFacts');

// 后台任务
const agentMaxConcurrentInput = document.getElementById('agentMaxConcurrent');
const agentMaxStepsInput = document.getElementById('agentMaxSteps');
const agentTimeoutSelect = document.getElementById('agentTimeout');
const agentWorkspaceInput = document.getElementById('agentWorkspace');
const agentPolicySelect = document.getElementById('agentPolicy');
const agentPolicyHint = document.getElementById('agentPolicyHint');

// 工具
const toolGroupSelect = document.getElementById('toolGroup');
const toolGroupsBox = document.getElementById('toolGroups');
const toolSelectAll = document.getElementById('toolSelectAll');
const toolSelectedCount = document.getElementById('toolSelectedCount');
const toolBatchEnable = document.getElementById('toolBatchEnable');
const toolBatchDisable = document.getElementById('toolBatchDisable');
const toolBatchApproval = document.getElementById('toolBatchApproval');
const toolDrawer = document.getElementById('toolDrawer');
const toolDrawerBackdrop = document.getElementById('toolDrawerBackdrop');
const toolDrawerClose = document.getElementById('toolDrawerClose');
const toolDrawerName = document.getElementById('toolDrawerName');
const toolDrawerId = document.getElementById('toolDrawerId');
const toolDrawerDesc = document.getElementById('toolDrawerDesc');
const toolDrawerParams = document.getElementById('toolDrawerParams');
const toolDrawerEnabled = document.getElementById('toolDrawerEnabled');
const toolDrawerApproval = document.getElementById('toolDrawerApproval');
const toolDrawerApprovalHint = document.getElementById('toolDrawerApprovalHint');
const toolDrawerRisk = document.getElementById('toolDrawerRisk');

// 系统
const autoLaunchBox = document.getElementById('autoLaunch');
const clickThroughBox = document.getElementById('clickThrough');
const edgeSnapBox = document.getElementById('edgeSnap');
const dockEnabledBox = document.getElementById('dockEnabled');
const systemError = document.getElementById('systemError');

/**
 * 两个全局快捷键在界面上的对应物。
 *
 * 键名与主进程的**槽位名**一一对应（见 src/shared/hotkeys.js）：
 * 主进程推来的状态带着槽位名，界面据此知道说的是哪一个快捷键。
 */
const HOTKEY_FIELDS = {
  hotkey: {
    input: document.getElementById('hotkeyValue'),
    button: document.getElementById('recordHotkey'),
    hint: document.getElementById('hotkeyHint'),
    setLabel: '重新录制',
    // 「呼出/隐藏桌宠」永远有值（默认 Control+Shift+D），
    // 所以未设置时也写着「重新录制」——按钮文案不会在加载时闪一下。
    unsetLabel: '重新录制',
    emptyHint: '呼出 / 隐藏桌宠。被别的程序占用时这里会写明。',
  },
  panelHotkey: {
    input: document.getElementById('panelHotkeyValue'),
    button: document.getElementById('recordPanelHotkey'),
    clearButton: document.getElementById('clearPanelHotkey'),
    hint: document.getElementById('panelHotkeyHint'),
    setLabel: '重新录制',
    unsetLabel: '录制',
    emptyHint: '唤出输入框（面板的搜索框），可以直接打字。默认不设。',
  },
};

/**
 * 状态栏。
 *
 * 两条消息渠道，各管各的：
 * - `data-state` 是给自动化用的终态标记（'done' / 'pending'），
 *   `test/e2e/failure.spec.js` 靠它判断「切换中…」还是最终结论。
 * - `data-kind` 只管配色（'ok' / 'pending' / 'error'）。
 */
function show(msg, kind = 'ok') {
  status.dataset.state = 'done';
  status.dataset.kind = kind;
  status.textContent = msg;
  if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 2000);
}

/**
 * 显示「进行中」状态：不会自动消失，必须由后面的 show() 顶掉。
 *
 * 没有它时，渲染层迟迟不回执的那 12 秒里状态栏是空的——
 * 用户按下拉框后看不到任何反馈，只会觉得程序卡住了。
 */
function showPending(msg) {
  status.dataset.state = 'pending';
  status.dataset.kind = 'pending';
  status.textContent = msg;
}

function formatScale(v) {
  return `${Number(v).toFixed(2)}x`;
}

function formatOpacity(v) {
  return `${Math.round(Number(v) * 100)}%`;
}

function formatVolume(v) {
  return `${Math.round(Number(v) * 100)}%`;
}

/**
 * 把滑块「已经走到哪儿」画出来。
 *
 * 滑块的填充是 CSS 渐变，用的是这个变量——
 * 浏览器自己画的填充画的是 accent-color，没走的那段是深炭灰，
 * 在米色底上太扎眼；自己画就能两头都用暖色。
 */
function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--pct', `${Math.min(100, Math.max(0, pct))}%`);
}

// ---------------------------------------------------------------------------
// 分区导航
//
// 设置项有三十来个，全平铺在一页上既难找又难读。
// 左边是目录，右边一次只显示一节。
// ---------------------------------------------------------------------------

/** 六个分区：目录项、面板、摘要都用同一个 key。 */
const SECTION_KEYS = ['pet', 'voice', 'chat', 'memory', 'plugins', 'system'];

const nav = document.getElementById('nav');
const pane = document.getElementById('pane');
const navTabs = new Map();
const navPanels = new Map();
const navSummaries = new Map();
for (const key of SECTION_KEYS) {
  navTabs.set(key, document.getElementById(`tab-${key}`));
  navPanels.set(key, document.getElementById(`panel-${key}`));
  navSummaries.set(key, nav.querySelector(`[data-summary="${key}"]`));
}

let currentSection = 'pet';

/**
 * 切到某个分区。
 *
 * 焦点**留在目录按钮上**，不自动跳进面板：跳焦点会让用户失去
 * 「我还在导航里」的位置感，还会把面板滚到顶上。
 * 非当前分区是 display:none，整体退出 Tab 顺序——
 * 所以从目录按一下 Tab，就正好落到当前面板的第一个控件。
 */
function activateSection(key, { focus = false } = {}) {
  if (!SECTION_KEYS.includes(key)) return;
  currentSection = key;
  for (const k of SECTION_KEYS) {
    const active = k === key;
    const tab = navTabs.get(k);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    // roving tabindex：整个目录只占一个 Tab 停靠点。
    tab.tabIndex = active ? 0 : -1;
    navPanels.get(k).hidden = !active;
  }
  pane.scrollTop = 0;
  if (focus) navTabs.get(key).focus();
  // 事实列表会过期：在插件面板里聊一句，桌宠就可能多记住一条。
  if (key === 'memory') void refreshFacts();
  // 插件清单也会过期：用户可能刚装了插件，或者在别处关了哪个。
  if (key === 'plugins') void refreshPlugins();
  // 系统状态也会过期：开机自启可能写注册表失败了，快捷键可能被别人占了。
  if (key === 'system') void refreshSystemState();
}

for (const key of SECTION_KEYS) {
  navTabs.get(key).addEventListener('click', () => activateSection(key));
}

// 方向键在目录里移动并切换。竖排用 ↑↓、横排用 ←→，两个都支持更省心
// （窄窗口下目录会收成横向标签条）。
nav.addEventListener('keydown', (e) => {
  const idx = SECTION_KEYS.indexOf(currentSection);
  let next = -1;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % SECTION_KEYS.length;
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx + SECTION_KEYS.length - 1) % SECTION_KEYS.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = SECTION_KEYS.length - 1;
  if (next < 0) return;
  e.preventDefault();
  activateSection(SECTION_KEYS[next], { focus: true });
});

// 窄窗口下目录变成横向标签条：aria-orientation 得跟着变，CSS 改不了属性。
const narrowQuery = window.matchMedia('(max-width: 560px)');
const syncOrientation = () => {
  nav.setAttribute('aria-orientation', narrowQuery.matches ? 'horizontal' : 'vertical');
};
narrowQuery.addEventListener('change', syncOrientation);
syncOrientation();

// ---------------------------------------------------------------------------
// 对话分区的二级标签
//
// 「对话」这一节里的设置项分成了五组（模型、人设、主动搭话、先应一声、
// 后台任务），平铺下来太长。标签条放在分区标题下面，一组一页。
// ---------------------------------------------------------------------------

const chatTabs = document.getElementById('chatTabs');
const chatSubTabs = Array.from(chatTabs.querySelectorAll('[data-sub]'));
const chatSubPanels = new Map(
  chatSubTabs.map((t) => [t.dataset.sub, document.getElementById(t.getAttribute('aria-controls'))])
);

/** 切到某个分组。焦点留在标签上，与左边目录一个路数。 */
function activateChatSub(key, { focus = false } = {}) {
  for (const t of chatSubTabs) {
    const active = t.dataset.sub === key;
    t.setAttribute('aria-selected', active ? 'true' : 'false');
    // roving tabindex：整条标签只占一个 Tab 停靠点。
    t.tabIndex = active ? 0 : -1;
    chatSubPanels.get(t.dataset.sub).hidden = !active;
  }
  if (focus) chatTabs.querySelector(`[data-sub="${key}"]`)?.focus();
  // 标签条放不下时是横向滚的：选中的那个得滚进视野。
  chatTabs.querySelector(`[data-sub="${key}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

for (const t of chatSubTabs) {
  t.addEventListener('click', () => activateChatSub(t.dataset.sub));
}

// 方向键在标签条里移动并切换。
chatTabs.addEventListener('keydown', (e) => {
  const idx = chatSubTabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  let next = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % chatSubTabs.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx + chatSubTabs.length - 1) % chatSubTabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = chatSubTabs.length - 1;
  if (next < 0) return;
  e.preventDefault();
  activateChatSub(chatSubTabs[next].dataset.sub, { focus: true });
});

// ---------------------------------------------------------------------------
// 目录右侧的状态摘要
//
// 目录因此兼作一块仪表盘：不进每一节，也看得出整个应用现在是什么状态。
// ---------------------------------------------------------------------------

function setSummary(key, text) {
  const el = navSummaries.get(key);
  if (el && el.textContent !== text) el.textContent = text;
}

/**
 * 刷新目录上的状态摘要。
 *
 * 摘要**只从活的 DOM 推导**，不另存一份状态：
 * 控件才是唯一的事实来源，存第二份必然会漂。
 */
function refreshNavSummaries() {
  const modelName = modelSelect.selectedOptions?.[0]?.textContent?.trim();
  setSummary('pet', modelName || '—');

  // 语音与对话是三态，不是两态：用户最常见的坑是「开关开了但没填 Key」，
  // 只报「已开」反而把这个坑盖住了。
  const ttsKey = keyStatus.dataset.configured === 'true';
  setSummary('voice', ttsEnabledBox.checked ? (ttsKey ? '已开' : '缺 Key') : '已关');

  const llmKey = llmKeyStatus.dataset.configured === 'true';
  // 摘要里带上派单模式：用户最常问的「它现在会自己干活吗」，
  // 不该靠切进分区去看下拉框。
  const dispatchName = dispatchModeInfo(llmDispatchSelect.value).label;
  setSummary(
    'chat',
    llmEnabledBox.checked ? (llmKey ? `已开 · ${dispatchName}` : '缺 Key') : '已关'
  );

  setSummary('memory', `${llmFactsList.children.length} 条`);

  // 系统：六项里开了几项（快捷键非空即算「开」）。
  const systemFlags = [
    autoLaunchBox.checked,
    Boolean(HOTKEY_FIELDS.hotkey.input.value.trim()),
    Boolean(HOTKEY_FIELDS.panelHotkey.input.value.trim()),
    clickThroughBox.checked,
    edgeSnapBox.checked,
    dockEnabledBox.checked,
  ];
  setSummary('system', `${systemFlags.filter(Boolean).length}/${systemFlags.length}`);
}

// init() 完成之前收到的广播：先记下来，等初始化结束时统一应用。
//
// 监听器是先于 Promise.all([getSettings(), listModels()]) 注册的，
// 两者之间到达的广播会撞上空的 options：setModel 只能把 value 置空，
// 随后 init() 结束时又用**更旧**的 getSettings 结果覆盖一次——
// 下拉框显示的就不是桌面上跑的那个，而且不会有下一次广播来纠正。
// 缩放与透明度同理：广播里的新值会被 init 的旧值盖回去。
let pending = null;

// 下拉框只认注册表里的 id：存着的 id 不在列表里（比如形象被删了），
// 就退回到列表第一项——那正是渲染层 loadManifest 的回退规则，
// 两边不一致的话，设置窗口显示的形象会和桌面上显示的对不上。
function setModel(id) {
  if (typeof id !== 'string' || id === '') return;
  if (modelSelect.options.length === 0) {
    // 选项还没填好：先记下来，填充完再应用。
    pending = { ...(pending || {}), modelId: id };
    return;
  }
  const known = Array.from(modelSelect.options).some((o) => o.value === id);
  modelSelect.value = known ? id : modelSelect.options[0]?.value || '';
  updateDeleteEnabled();
}

// 形象注册表（内置 + 用户导入的）。用来判断选中的是不是「导入的」——
// 内置模型删不得，那是程序的一部分。
let knownModels = [];

/**
 * 当前选中的形象能不能删。
 *
 * 导入的与预制的**都能删**，只是后果不同：导入的删模型文件，
 * 预制的只是从形象列表里移除（模型文件仍在程序目录中）。
 * 确认框（主进程弹的原生框）会把区别说清楚。
 *
 * 列表里只剩一个形象时不能删：一个都没有的话桌宠窗口里什么也画不出来。
 */
function updateDeleteEnabled() {
  const id = modelSelect.value;
  const entry = knownModels.find((m) => m.id === id);
  const removable = !!entry && knownModels.length > 1;
  deleteModelBtn.disabled = !removable;
  if (!entry) {
    deleteModelBtn.title = '没有选中的形象。';
  } else if (knownModels.length <= 1) {
    deleteModelBtn.title = '至少要保留一个形象。';
  } else if (entry.source === 'user') {
    deleteModelBtn.title = `删除「${entry.name}」（会删掉模型文件）`;
  } else {
    deleteModelBtn.title = `移除「${entry.name}」（从列表中去掉，模型文件仍保留）`;
  }
}

/**
 * 重建形象下拉框。
 *
 * 导入/删除之后必须重新拉注册表：新形象的 id 只有主进程知道，
 * 渲染层这边还拿着旧的列表。
 */
async function refreshModelOptions(preferredId) {
  let models = null;
  try {
    models = (await window.pet.listModels()) || [];
  } catch (err) {
    console.warn('[desk-pet] 形象列表刷新失败：', err?.message);
    // 拉不到就别动下拉框：清空之后填不上，比继续显示旧列表糟得多。
    return;
  }
  knownModels = models;

  // 重建选项前先记住当前选中项：清空 select 会把 value 变成空串。
  const keep = preferredId || modelSelect.value;
  modelSelect.textContent = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    // 导入的模型标一下：用户一眼能看出哪些是自己加的、哪些能删。
    opt.textContent = m.source === 'user' ? `${m.name}（导入）` : m.name;
    modelSelect.appendChild(opt);
  }
  if (models.length > 0) {
    const known = models.some((m) => m.id === keep);
    modelSelect.value = known ? keep : models[0].id;
  }
  updateDeleteEnabled();
}

function updateScale(v) {
  scaleInput.value = String(v);
  scaleVal.textContent = formatScale(v);
  setRangeFill(scaleInput);
}

function updateOpacity(v) {
  opacityInput.value = String(v);
  opacityVal.textContent = formatOpacity(v);
  setRangeFill(opacityInput);
}

function updateVolume(v) {
  volumeInput.value = String(v);
  volumeVal.textContent = formatVolume(v);
  setRangeFill(volumeInput);
}

// ---------------------------------------------------------------------------
// 助理偏好
// ---------------------------------------------------------------------------

/** 下拉框里那些常用音色的 id。 */
function knownVoiceIds() {
  return Array.from(voiceSelect.options).map((o) => o.value);
}

/** 「当前生效」那一行：显示真正会被发去接口的那个 id。 */
function updateVoiceCurrent() {
  const id = resolveVoiceId(voiceInput.value, voiceSelect.value);
  voiceCurrent.textContent = id || '—';
}

/**
 * 填「先应一声」的下拉框。
 *
 * 「关闭」不是时长，单独放第一项——它表示「一声不吭地等答案」。
 * 其余按 shared/assistant.js 的 ACK_DELAY_PRESETS 填，不在这里写死。
 */
function fillAckOptions() {
  llmAckDelaySelect.textContent = '';
  const off = document.createElement('option');
  off.value = ACK_DELAY_OFF;
  off.textContent = '关闭';
  llmAckDelaySelect.appendChild(off);
  for (const preset of ACK_DELAY_PRESETS) {
    const opt = document.createElement('option');
    opt.value = String(preset.value);
    opt.textContent = preset.label;
    llmAckDelaySelect.appendChild(opt);
  }
}
fillAckOptions();

/**
 * 填「桌宠能做什么」的下拉框。
 *
 * 选项按 shared/assistant.js 的 DISPATCH_MODES 填，不在这里写死：
 * 写死一份的话，加了第三个模式，设置页上还是那两个。
 *
 * 模块加载时就填好：init() 要拉一堆数据，万一哪步失败，
 * 设置页至少还能看见下拉框。
 */
function fillDispatchOptions() {
  llmDispatchSelect.textContent = '';
  for (const id of DISPATCH_MODES) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = dispatchModeInfo(id).label;
    llmDispatchSelect.appendChild(opt);
  }
}
fillDispatchOptions();

/** 把当前派单模式的说明写在下面——用户切过去时得当场看见差别。 */
function updateDispatchHint() {
  const info = dispatchModeInfo(llmDispatchSelect.value);
  llmDispatchHint.textContent = info.hint || `桌宠能做什么：${info.label}`;
}

/**
 * 把当前值补进下拉框（如果预设里没有它）。
 *
 * 磁盘上的值可能是手改的，也可能是旧版本留下的——
 * 下拉框里没有对应选项时它会显示成空的，
 * 那等于骗用户说「没设置」，还会在下一次保存时把它改掉。
 */
function ensureAckOption(value) {
  const str = String(value);
  if (Array.from(llmAckDelaySelect.options).some((o) => o.value === str)) return;
  const opt = document.createElement('option');
  opt.value = str;
  opt.textContent = `${(Number(str) / 1000).toFixed(1)} 秒`;
  llmAckDelaySelect.appendChild(opt);
}

/**
 * 填「动我的东西要不要问」的下拉框。
 *
 * 选项按 shared/assistant.js 的 APPROVAL_POLICIES 填：
 * 档位增删时设置页跟着走，不在这里写死一份。
 */
function fillApprovalOptions() {
  agentPolicySelect.textContent = '';
  for (const id of APPROVAL_POLICIES) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = approvalPolicyInfo(id).label;
    agentPolicySelect.appendChild(opt);
  }
}
fillApprovalOptions();

/** 把当前档位的后果写在下面——用户切过去时得当场看见差别。 */
function updateApprovalHint() {
  const info = approvalPolicyInfo(agentPolicySelect.value);
  agentPolicyHint.textContent = info.hint || '';
}

/**
 * 把当前超时值补进下拉框（如果预设里没有它）。
 *
 * 磁盘上的值可能是手改的，也可能是旧版本留下的——
 * 下拉框里没有对应选项时它会显示成空的，
 * 那等于骗用户说「没设置」，还会在下一次保存时把它改掉。
 */
function ensureTimeoutOption(value) {
  const str = String(value);
  if (Array.from(agentTimeoutSelect.options).some((o) => o.value === str)) return;
  const opt = document.createElement('option');
  opt.value = str;
  const ms = Number(str);
  opt.textContent = ms % 60000 === 0 ? `${ms / 60000} 分钟` : `${ms / 1000} 秒`;
  agentTimeoutSelect.appendChild(opt);
}

/**
 * 读一个「有几个」的输入框，并把读到的值夹回合法范围。
 *
 * 越界的值主进程也会夹，但界面上得显示夹完的值——
 * 不然用户填 999，磁盘上存着 100，界面还写着 999。
 */
function readClampedInt(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const n = Math.round(Number(input.value));
  const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
  input.value = String(v);
  return v;
}

/** 工具清单：主进程给的工具与它们的来源。 */
let agentToolList = [];

/** 永久放行（以后不问）的工具名。 */
let allowAlwaysNames = new Set();

/** 被关掉的工具名。 */
let disabledToolNames = new Set();

/**
 * 选中的工具名（批量操作的对象）。
 *
 * 选中状态**记在名字上**，不记在 DOM 上：清单会重画
 * （插件开关一拨就重画），记在 DOM 上的选中会跟着一起没。
 */
let selectedToolNames = new Set();

/** 插件 id → 插件名（分组标题用）。 */
let pluginNames = new Map();

/** 工具按来源分组：内置的一组，每个接给 agent 的插件各一组。 */
function toolGroups() {
  const groups = new Map();
  const push = (key, title) => {
    if (!groups.has(key)) groups.set(key, { key, title, tools: [] });
    return groups.get(key);
  };
  for (const t of agentToolList) {
    const owner = String(t.owner || '');
    const key = owner ? `plugin:${owner}` : 'builtin';
    const title = owner ? pluginNames.get(owner) || owner : '内置';
    push(key, title).tools.push(t);
  }
  return [...groups.values()];
}

/** 画「工具」这一页：按来源分组，每组一个下拉框能筛。 */
function renderTools() {
  toolGroupsBox.textContent = '';

  // 工具没了（插件被卸了），选中的那个也就没意义了——从选中里剔掉。
  const alive = new Set(agentToolList.map((t) => t.name));
  for (const name of [...selectedToolNames]) {
    if (!alive.has(name)) selectedToolNames.delete(name);
  }

  // 分组下拉框：全部 / 内置 / 每个插件。
  const groups = toolGroups();
  const keep = toolGroupSelect.value;
  toolGroupSelect.textContent = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全部分组';
  toolGroupSelect.appendChild(all);
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g.key;
    opt.textContent = g.title;
    toolGroupSelect.appendChild(opt);
  }
  toolGroupSelect.value = groups.some((g) => g.key === keep) ? keep : '';

  const shown = groups.filter((g) => !toolGroupSelect.value || g.key === toolGroupSelect.value);
  for (const g of shown) {
    const section = document.createElement('section');
    section.className = 'tool-group';

    const title = document.createElement('h2');
    title.className = 'tool-group-title';
    title.textContent = g.title;
    section.appendChild(title);

    const ul = document.createElement('ul');
    ul.className = 'tool-list';
    for (const t of g.tools) ul.appendChild(toolRow(t));
    section.appendChild(ul);

    toolGroupsBox.appendChild(section);
  }

  // 名单里有的、工具表里没有的（插件被卸了）：也列出来，
  // 否则用户看不见它，也没法把它从「以后不问」里去掉。
  const orphans = [...allowAlwaysNames].filter(
    (name) => !agentToolList.some((t) => t.name === name)
  );
  if (orphans.length) {
    const section = document.createElement('section');
    section.className = 'tool-group';
    const title = document.createElement('h2');
    title.className = 'tool-group-title';
    title.textContent = '已不存在的工具';
    section.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'tool-list';
    for (const name of orphans) {
      const li = document.createElement('li');
      li.className = 'tool-row unavailable';
      const text = document.createElement('span');
      text.className = 'tool-text';
      const label = document.createElement('span');
      label.className = 'tool-name';
      label.textContent = name;
      const id = document.createElement('span');
      id.className = 'tool-id';
      id.textContent = '（插件已经不在了）';
      text.append(label, id);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.title = '从「以后不问」的名单里去掉';
      box.addEventListener('change', () => {
        if (!box.checked) {
          allowAlwaysNames.delete(name);
          persistAssistantPrefs();
        }
      });
      li.append(box, text);
      ul.appendChild(li);
    }
    section.appendChild(ul);
    toolGroupsBox.appendChild(section);
  }

  updateToolBatchBar();
}

/**
 * 一个工具的一行。
 *
 * 行里只有名字：开关与介绍都在**抽屉**里。
 * 左边的勾选框只做一件事：把这个工具选进批量操作的范围。
 */
function toolRow(t) {
  const selected = selectedToolNames.has(t.name);
  const li = document.createElement('li');
  li.className = `tool-row${disabledToolNames.has(t.name) ? ' off' : ''}${selected ? ' selected' : ''}`;
  li.dataset.toolName = t.name;

  const select = document.createElement('input');
  select.type = 'checkbox';
  select.className = 'tool-select';
  select.checked = selected;
  select.title = '选中它，好批量改';
  select.setAttribute('aria-label', `选中 ${t.label || t.name}`);
  // 勾选框**不打开抽屉**：整行才是抽屉的入口，勾选框是另一件事。
  select.addEventListener('click', (e) => e.stopPropagation());
  select.addEventListener('change', () => {
    if (select.checked) selectedToolNames.add(t.name);
    else selectedToolNames.delete(t.name);
    li.classList.toggle('selected', select.checked);
    updateToolBatchBar();
  });

  const text = document.createElement('span');
  text.className = 'tool-text';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = t.label || t.name;
  const id = document.createElement('span');
  id.className = 'tool-id';
  id.textContent = t.name;
  text.append(name, id);

  const arrow = document.createElement('span');
  arrow.className = 'tool-arrow';
  arrow.textContent = '›';

  li.append(select, text, arrow);
  li.addEventListener('click', () => openToolDrawer(t));
  return li;
}

/**
 * 当前**看得见**的工具名（受「只看」那个筛选影响）。
 *
 * 「全选」选的就是这些：用户看不见的工具不该被顺手改掉。
 */
function visibleToolNames() {
  const key = toolGroupSelect.value;
  return toolGroups()
    .filter((g) => !key || g.key === key)
    .flatMap((g) => g.tools.map((t) => t.name));
}

/**
 * 刷新批量操作那一条：选中几个、按钮能不能点、「全选」是什么状态。
 *
 * **两个数不是一回事**：选中的是**所有**选中的工具（哪怕它现在被筛选藏起来了），
 * 而「全选」那个勾选框只管**当前看得见的**那些。
 */
function updateToolBatchBar() {
  const names = visibleToolNames();
  const state = selectAllState(names, selectedToolNames);
  const picked = selectedToolNames.size;

  toolSelectAll.checked = state.all;
  // 选了一部分时打半勾：只显示成「没勾」的话，
  // 用户不知道自己已经选了几个。
  toolSelectAll.indeterminate = state.some;

  toolSelectedCount.textContent = picked ? `已选 ${picked} 个` : '还没选工具';

  const has = picked > 0;
  toolBatchEnable.disabled = !has;
  toolBatchDisable.disabled = !has;
  toolBatchApproval.disabled = !has;
}

/** 风险等级给人看的说法。 */
const RISK_TEXT = {
  read: '只读——它只是看，不会动你的东西。',
  write: '写入——它会改东西，改之前要你点头。',
  exec: '执行——它会跑命令或启动程序，动手之前要你点头。',
};

/**
 * 抽屉里「审批等级」那一栏底下的话。
 *
 * 只读的工具在「问一声」档位下直接做，但档位改成「每件事都问」
 * 时它也会问——所以这句话得看**当前档位**怎么说，不能写死。
 */
function toolApprovalHint(readOnly) {
  if (!readOnly) return '「以后不问」= 用它的时候不再弹确认。';
  if (agentPolicySelect.value === 'manual') return '现在是「每件事都问」：只读的工具也会问一声。';
  return '只读的工具不改这一栏：「问一声」档位下它直接做，不会弹确认。';
}

/**
 * 打开工具抽屉。
 *
 * 左边滑出来的那一张卡：介绍、入参、启用开关与审批等级。
 */
function openToolDrawer(t) {
  toolDrawerName.textContent = t.label || t.name;
  toolDrawerId.textContent = t.name;
  toolDrawerDesc.textContent = t.description || '（这个工具没有写介绍。）';
  renderToolParams(t);

  const enabled = !disabledToolNames.has(t.name);
  toolDrawerEnabled.checked = enabled;
  // 显示的是**真存下来的那份名单**：在「以后不问」里就是「以后不问」。
  toolDrawerApproval.value = allowAlwaysNames.has(t.name) ? 'always' : 'ask';
  // 只读的工具：审批等级改不了——它在「问一声」档位下本来就不会问你。
  const readOnly = t.risk === 'read';
  toolDrawerApproval.disabled = !enabled || readOnly;
  toolDrawerApprovalHint.textContent = toolApprovalHint(readOnly);
  toolDrawerRisk.textContent = RISK_TEXT[t.risk] || '这个工具没声明风险等级，按最严格的来。';

  toolDrawer.dataset.toolName = t.name;
  toolDrawer.dataset.risk = String(t.risk || '');
  toolDrawerBackdrop.hidden = false;
  toolDrawer.hidden = false;
}

/** 抽屉里的入参表：从 JSON Schema 里读出参数名、类型与说明。 */
function renderToolParams(t) {
  toolDrawerParams.textContent = '';
  const schema = t.parameters && typeof t.parameters === 'object' ? t.parameters : null;
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const entries = Object.entries(props);

  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'drawer-empty';
    li.textContent = '这个工具不用参数。';
    toolDrawerParams.appendChild(li);
    return;
  }

  for (const [key, spec] of entries) {
    const li = document.createElement('li');
    li.className = 'param-item';

    const name = document.createElement('span');
    name.className = 'param-name';
    name.textContent = key;
    li.appendChild(name);

    const type = document.createElement('span');
    type.className = 'param-type';
    type.textContent = String(spec?.type || 'any');
    li.appendChild(type);

    if (required.has(key)) {
      const req = document.createElement('span');
      req.className = 'param-req';
      req.textContent = '必填';
      li.appendChild(req);
    }

    if (spec?.description) {
      const desc = document.createElement('span');
      desc.className = 'param-desc';
      desc.textContent = String(spec.description);
      li.appendChild(desc);
    }

    toolDrawerParams.appendChild(li);
  }
}

/** 关抽屉。 */
function closeToolDrawer() {
  toolDrawer.hidden = true;
  toolDrawerBackdrop.hidden = true;
}

/**
 * think 没打开时，深度那一栏是**用不上的**——灰掉它。
 *
 * 不灰掉的话，用户会以为「中」正在生效。
 */
function updateThinkLevelEnabled() {
  llmThinkLevelSelect.disabled = !llmThinkBox.checked;
}

/** 把助理状态填进桌面助理/语音那一区的控件。 */
function applyAssistantState(state) {
  if (!state) return;
  chimeBox.checked = Boolean(state.chime?.enabled);
  greetingBox.checked = Boolean(state.greeting?.enabled);
  soundBox.checked = Boolean(state.sound?.enabled);
  ttsEnabledBox.checked = Boolean(state.tts?.enabled);
  // 音色：清单里的走下拉框，清单外的填进自定义框。
  const voice = applyVoiceChoice(state.tts?.voiceId || '', knownVoiceIds());
  voiceSelect.value = voice.select;
  voiceInput.value = voice.custom;
  updateVoiceCurrent();
  speedInput.value = String(state.tts?.speed ?? 1);
  speedVal.textContent = Number(state.tts?.speed ?? 1).toFixed(2);
  setRangeFill(speedInput);
  // 点桌宠时说的话。
  tapTalkEnabledBox.checked = Boolean(state.tapTalk?.enabled);
  tapTalkModelSoundBox.checked = Boolean(state.tapTalk?.modelSound);
  tapTalkLinesInput.value = (state.tapTalk?.lines || []).join('\n');
  // 总音量：存在 assistant.json 的 sound.volume 里，不在 settings.json。
  updateVolume(state.sound?.volume ?? DEFAULT_VOLUME);

  const llm = state.llm || {};
  llmEnabledBox.checked = Boolean(llm.enabled);
  // 派单模式：磁盘上的值可能是旧版本留下的，也可能是手改的——
  // 认不出来就退回默认（主进程已经迁移过了，这里读到的是迁移后的值）。
  llmDispatchSelect.value = DISPATCH_MODES.includes(state.agent?.dispatch)
    ? state.agent.dispatch
    : 'auto';
  dispatchModeValue = llmDispatchSelect.value;
  updateDispatchHint();

  // 后台任务。
  const agent = state.agent || {};
  agentMaxConcurrentInput.value = String(agent.maxConcurrent ?? 1);
  agentMaxStepsInput.value = String(agent.maxSteps ?? 20);
  ensureTimeoutOption(agent.timeoutMs ?? 120000);
  agentTimeoutSelect.value = String(agent.timeoutMs ?? 120000);
  agentWorkspaceInput.value = agent.workspace || '';
  agentPolicySelect.value = APPROVAL_POLICIES.includes(agent.approval?.policy)
    ? agent.approval.policy
    : 'graded';
  updateApprovalHint();
  allowAlwaysNames = new Set(agent.approval?.allowAlways || []);
  disabledToolNames = new Set(agent.tools?.disabled || []);
  renderTools();

  llmBaseUrlInput.value = llm.baseUrl || '';
  llmModelInput.value = llm.model || '';
  llmTemperatureInput.value = String(llm.temperature ?? 0.7);
  llmTemperatureVal.textContent = Number(llm.temperature ?? 0.7).toFixed(1);
  setRangeFill(llmTemperatureInput);
  llmMaxTokensSelect.value = String(llm.maxTokens ?? 800);
  llmTokensFieldSelect.value = llm.maxTokensField || 'max_tokens';
  // think 模式与深度：深度只认三个档位，认不出来当「中」。
  llmThinkBox.checked = Boolean(llm.think);
  llmThinkLevelSelect.value = THINK_LEVELS.includes(llm.thinkLevel) ? llm.thinkLevel : 'medium';
  updateThinkLevelEnabled();
  llmPersonaNameInput.value = llm.persona?.name || '';
  llmPersonaStyleInput.value = llm.persona?.style || '';
  llmPersonaBackstoryInput.value = llm.persona?.backstory || '';
  llmProactiveBox.checked = Boolean(llm.proactive?.enabled);
  llmProactiveIntervalSelect.value = String(llm.proactive?.minIntervalMs ?? 1800000);
  // 「先应一声」：下拉框的值 = 关掉还是等多久。
  const ackValue = ackValueFromPrefs(llm.ackEnabled, llm.ackDelayMs);
  ensureAckOption(ackValue);
  llmAckDelaySelect.value = ackValue;

  // 「它记住的事」：用户有权知道桌宠记住了什么。
  renderFacts(state.chat?.facts || []);
}

/** 当前显示着的事实（删一条时要从它算出剩下哪些）。 */
let currentFacts = [];

/**
 * 画「它记住的事」。
 *
 * 每条右边一个删除按钮：整页记住的东西一起清掉太粗，
 * 想忘掉一句时用不着把别的也搭进去。
 */
function renderFacts(facts) {
  currentFacts = Array.isArray(facts) ? [...facts] : [];
  llmFactsList.textContent = '';
  for (const fact of currentFacts) {
    const li = document.createElement('li');

    const text = document.createElement('span');
    text.className = 'fact-text';
    text.textContent = fact;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fact-del';
    del.textContent = '×';
    del.title = '忘掉这一条';
    del.setAttribute('aria-label', `忘掉这一条：${fact}`);
    del.addEventListener('click', () => {
      void deleteFact(fact);
    });

    li.append(text, del);
    llmFactsList.appendChild(li);
  }
  refreshNavSummaries();
}

/** 把控件上的值收集成一份助理偏好补丁。 */
function assistantPatchFromControls() {
  return {
    chime: { enabled: chimeBox.checked },
    greeting: { enabled: greetingBox.checked },
    sound: { enabled: soundBox.checked },
    // 剪贴板 / 天气 / 过热提醒**故意不在这里**：
    // 它们是插件的配置，由插件页面自己管。
    // 这里写回一份旧值，用户在插件页面改过的设置就被覆盖了。
    tts: {
      enabled: ttsEnabledBox.checked,
      voiceId: resolveVoiceId(voiceInput.value, voiceSelect.value),
      speed: Number(speedInput.value),
    },
    tapTalk: {
      enabled: tapTalkEnabledBox.checked,
      modelSound: tapTalkModelSoundBox.checked,
      // 台词：一行一句。解析规则与主进程一致（见 shared/tapVoice.js）。
      lines: parseTapLines(tapTalkLinesInput.value),
    },
    llm: {
      enabled: llmEnabledBox.checked,
      baseUrl: llmBaseUrlInput.value.trim(),
      model: llmModelInput.value.trim(),
      temperature: Number(llmTemperatureInput.value),
      maxTokens: Number(llmMaxTokensSelect.value),
      maxTokensField: llmTokensFieldSelect.value,
      think: llmThinkBox.checked,
      thinkLevel: llmThinkLevelSelect.value,
      persona: {
        name: llmPersonaNameInput.value.trim(),
        style: llmPersonaStyleInput.value.trim(),
        backstory: llmPersonaBackstoryInput.value.trim(),
      },
      proactive: {
        enabled: llmProactiveBox.checked,
        minIntervalMs: Number(llmProactiveIntervalSelect.value),
      },
      // 「先应一声」：下拉框一个控件管两件事——关不关、等多久。
      ...ackPrefsFromValue(llmAckDelaySelect.value),
    },
    agent: {
      // 派单模式与后台任务的各项上限。
      dispatch: llmDispatchSelect.value,
      maxConcurrent: readClampedInt(agentMaxConcurrentInput),
      maxSteps: readClampedInt(agentMaxStepsInput),
      timeoutMs: Number(agentTimeoutSelect.value),
      workspace: agentWorkspaceInput.value.trim(),
      // 审批：**整段一起带上**。
      // 合并只深一层，只带 policy 会把永久放行的名单整个换掉。
      approval: {
        policy: agentPolicySelect.value,
        allowAlways: [...allowAlwaysNames],
      },
      // 工具开关：记的是「关掉了哪些」。
      tools: {
        disabled: [...disabledToolNames],
      },
    },
  };
}

/** 存助理偏好；失败要说出来，不能静默。 */
async function saveAssistantPrefs(patch) {
  try {
    await window.pet.saveAssistantPrefs(patch);
  } catch (err) {
    show(`保存失败：${err?.message || err}`, 'error');
  }
}

/**
 * 改一个助理控件就落一次盘，同时刷新目录摘要。
 *
 * 摘要从 DOM 读，而 DOM 已经是改过的了——所以先刷摘要再存盘，
 * 顺序反了就会出现「摘要慢半拍」。
 */
function persistAssistantPrefs() {
  refreshNavSummaries();
  void saveAssistantPrefs(assistantPatchFromControls());
}

/** 每个勾选框的变更都立刻生效。 */
for (const box of [chimeBox, greetingBox, soundBox]) {
  box.addEventListener('change', () => {
    persistAssistantPrefs();
  });
}

ttsEnabledBox.addEventListener('change', () => {
  persistAssistantPrefs();
});

// 音色：下拉框和自定义输入框都是「改了就存」。
voiceSelect.addEventListener('change', () => {
  // 选了清单里的音色，自定义框就该让位——
  // 两个控件同时指着一个东西，用户会以为自己填的那串才是生效的。
  voiceInput.value = '';
  updateVoiceCurrent();
  persistAssistantPrefs();
});

voiceInput.addEventListener('change', () => {
  updateVoiceCurrent();
  persistAssistantPrefs();
});

// —— 点桌宠时说的话 ——
for (const box of [tapTalkEnabledBox, tapTalkModelSoundBox]) {
  box.addEventListener('change', () => {
    persistAssistantPrefs();
  });
}

// 台词是文本框：失焦或按下回车时才算数。
//
// 「input」事件每敲一个字就存一次盘——文本框里常有中文输入法，
// 拼音过程中会存下一堆半成品，白白写磁盘。
tapTalkLinesInput.addEventListener('change', () => {
  persistAssistantPrefs();
});

speedInput.addEventListener('input', () => {
  speedVal.textContent = Number(speedInput.value).toFixed(2);
  setRangeFill(speedInput);
  persistAssistantPrefs();
});

// —— 对话 ——
for (const box of [llmEnabledBox, llmProactiveBox]) {
  box.addEventListener('change', () => {
    persistAssistantPrefs();
  });
}
llmDispatchSelect.addEventListener('change', async () => {
  const next = llmDispatchSelect.value;
  if (next === 'off') {
    // 切到「只聊天」之前问一句：正在做的事会被停掉，停掉了就回不来了。
    const res = await window.pet.confirmDispatchOff?.();
    if (!res?.confirmed) {
      // 用户不点头：下拉框退回原来的值，什么都不改。
      llmDispatchSelect.value = dispatchModeValue;
      updateDispatchHint();
      return;
    }
  }
  dispatchModeValue = next;
  updateDispatchHint();
  persistAssistantPrefs();
});
for (const input of [
  llmBaseUrlInput,
  llmModelInput,
  llmPersonaNameInput,
  llmPersonaStyleInput,
  llmPersonaBackstoryInput,
]) {
  input.addEventListener('change', () => {
    persistAssistantPrefs();
  });
}
for (const select of [llmMaxTokensSelect, llmTokensFieldSelect, llmProactiveIntervalSelect, llmThinkLevelSelect]) {
  select.addEventListener('change', () => {
    persistAssistantPrefs();
  });
}
// think 的开关：先把深度那栏灰掉，再存盘。
llmThinkBox.addEventListener('change', () => {
  updateThinkLevelEnabled();
  persistAssistantPrefs();
});
// 「先应一声」的等待时长：改了立刻生效（下一轮对话就用新的了）。
llmAckDelaySelect.addEventListener('change', () => {
  persistAssistantPrefs();
});
llmTemperatureInput.addEventListener('input', () => {
  llmTemperatureVal.textContent = Number(llmTemperatureInput.value).toFixed(1);
  setRangeFill(llmTemperatureInput);
  persistAssistantPrefs();
});

// —— 后台任务 ——
for (const input of [agentMaxConcurrentInput, agentMaxStepsInput]) {
  input.addEventListener('change', () => {
    readClampedInt(input);
    persistAssistantPrefs();
  });
}
agentTimeoutSelect.addEventListener('change', () => {
  persistAssistantPrefs();
});
agentWorkspaceInput.addEventListener('change', () => {
  persistAssistantPrefs();
});
// 审批档位：切过去当场看见后果。
agentPolicySelect.addEventListener('change', () => {
  updateApprovalHint();
  // 抽屉开着的话，它那一句也得跟着换——只读的工具问不问，取决于档位。
  if (!toolDrawer.hidden) {
    toolDrawerApprovalHint.textContent = toolApprovalHint(toolDrawer.dataset.risk === 'read');
  }
  persistAssistantPrefs();
});

// 「工具」页的分组筛选：只看某一组。
toolGroupSelect.addEventListener('change', () => {
  renderTools();
});

// —— 「工具」页的批量操作 ——

/**
 * 把一次批量改动落到界面上：重画清单（开关状态变了）并存盘。
 *
 * @param {'enabled'|'approval'} kind 改哪一项
 * @param {boolean|string} value 开关用布尔，审批等级用 'always' / 'ask'
 */
function applyToolBatch(kind, value) {
  const selected = [...selectedToolNames];
  if (!selected.length) return 0;
  if (kind === 'enabled') {
    disabledToolNames = applyBatchEnabled(selected, value, disabledToolNames);
  } else {
    allowAlwaysNames = applyBatchApproval(selected, value, allowAlwaysNames);
  }
  renderTools();
  persistAssistantPrefs();
  return selected.length;
}

// 「全选」：勾上就是选中当前筛选下看得见的那些，取消勾就是取消选中。
toolSelectAll.addEventListener('change', () => {
  const names = visibleToolNames();
  if (toolSelectAll.checked) for (const n of names) selectedToolNames.add(n);
  else for (const n of names) selectedToolNames.delete(n);
  // 行里的勾选框得跟着变，所以清单要重画一遍。
  renderTools();
  show(
    toolSelectAll.checked
      ? `已选中看得见的 ${names.length} 个工具`
      : `已取消选中看得见的 ${names.length} 个工具`
  );
});

// 批量开启：选中的工具重新回到 agent 的工具表里。
toolBatchEnable.addEventListener('click', () => {
  const n = applyToolBatch('enabled', true);
  if (n) show(`已开启 ${n} 个工具`);
});

// 批量关闭：关掉的工具桌宠看不见，也不会去调。
toolBatchDisable.addEventListener('click', () => {
  const n = applyToolBatch('enabled', false);
  if (n) show(`已关闭 ${n} 个工具`);
});

// 批量审批等级：选中的工具要么进「以后不问」的名单，要么从名单里去掉。
toolBatchApproval.addEventListener('change', () => {
  const value = toolBatchApproval.value;
  if (!value) return;
  const n = applyToolBatch('approval', value);
  // 下拉框回到「批量设等级…」：不然同一个选项没法再选第二次。
  toolBatchApproval.value = '';
  if (!n) return;
  show(
    value === TOOL_APPROVAL.ALWAYS
      ? `已把 ${n} 个工具设成「以后不问」`
      : `已把 ${n} 个工具设成「每次询问」`
  );
});

// 抽屉：关掉它的三种方式——按钮、点遮罩、按 Esc。
toolDrawerClose.addEventListener('click', closeToolDrawer);
toolDrawerBackdrop.addEventListener('click', closeToolDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !toolDrawer.hidden) closeToolDrawer();
});

// 抽屉里的「启用」：关掉的工具桌宠看不见，也不会去调。
toolDrawerEnabled.addEventListener('change', () => {
  const name = toolDrawer.dataset.toolName;
  if (!name) return;
  if (toolDrawerEnabled.checked) disabledToolNames.delete(name);
  else disabledToolNames.add(name);
  toolDrawerApproval.disabled = !toolDrawerEnabled.checked || toolDrawer.dataset.risk === 'read';
  const row = toolGroupsBox.querySelector(`li[data-tool-name="${name}"]`);
  row?.classList.toggle('off', !toolDrawerEnabled.checked);
  persistAssistantPrefs();
});

// 抽屉里的「审批等级」：以后不问的工具，用它的时候不再弹确认。
toolDrawerApproval.addEventListener('change', () => {
  const name = toolDrawer.dataset.toolName;
  if (!name) return;
  if (toolDrawerApproval.value === 'always') allowAlwaysNames.add(name);
  else allowAlwaysNames.delete(name);
  persistAssistantPrefs();
});

// ---------------------------------------------------------------------------
// API Key
// ---------------------------------------------------------------------------

/** 显示 key 的状态：只显示掩码，**永远不回显明文**。 */
function showKeyStatus(status_) {
  const configured = Boolean(status_?.configured);
  keyStatus.textContent = configured ? `已配置 ${status_.mask}` : '未配置';
  // data-configured 供目录摘要读：它要判断「有没有可用的 key」。
  keyStatus.dataset.configured = String(configured);
  refreshNavSummaries();
}

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    show('请先填入 API Key');
    return;
  }
  showPending('保存中…');
  try {
    const result = await window.pet.setTtsApiKey(key);
    apiKeyInput.value = '';
    showKeyStatus({ configured: true, mask: result?.mask || '' });
    show('API Key 已保存');
  } catch (err) {
    show(`保存失败：${err?.message || err}`, 'error');
  }
});

clearKeyBtn.addEventListener('click', async () => {
  showPending('清除中…');
  try {
    await window.pet.setTtsApiKey('');
    apiKeyInput.value = '';
    showKeyStatus({ configured: false, mask: '' });
    show('API Key 已清除');
  } catch (err) {
    show(`清除失败：${err?.message || err}`, 'error');
  }
});

// ---------------------------------------------------------------------------
// 对话的 Key 与「它记住的事」
// ---------------------------------------------------------------------------

/**
 * 显示对话 key 的状态。
 *
 * `dedicated` 说明它是**单独配的**——没单独配就是沿用 MiniMax 的那个，
 * 这时要写清楚，否则用户以为「没配」就找不到地方填。
 */
function showLlmKeyStatus(status_) {
  const configured = Boolean(status_?.configured);
  llmKeyStatus.textContent = !configured
    ? '未配置'
    : (status_.dedicated ? `已配置 ${status_.mask}` : `沿用 MiniMax Key（${status_.mask}）`);
  llmKeyStatus.dataset.configured = String(configured);
  refreshNavSummaries();
}

saveLlmKeyBtn.addEventListener('click', async () => {
  const key = llmApiKeyInput.value.trim();
  if (!key) {
    show('请先填入对话用的 Key');
    return;
  }
  showPending('保存中…');
  try {
    const result = await window.pet.setLlmApiKey(key);
    llmApiKeyInput.value = '';
    showLlmKeyStatus({ configured: true, dedicated: true, mask: result?.mask || '' });
    show('对话 Key 已保存');
  } catch (err) {
    show(`保存失败：${err?.message || err}`, 'error');
  }
});

clearLlmKeyBtn.addEventListener('click', async () => {
  showPending('清除中…');
  try {
    await window.pet.setLlmApiKey('');
    llmApiKeyInput.value = '';
    showLlmKeyStatus({ configured: false, dedicated: false, mask: '' });
    show('对话 Key 已清除');
  } catch (err) {
    show(`清除失败：${err?.message || err}`, 'error');
  }
});

// ---------------------------------------------------------------------------
// 「它记住的事」
//
// 世代号：刷新与「删掉/清空」并发时，别把已经删掉的事实写回去。
// ---------------------------------------------------------------------------

let factsEpoch = 0;
// 写入进行中：这段时间里发起的刷新一律作废——
// 那时候主进程里的事实还没删完，拉回来的是旧的。
let factsWritePending = false;

/**
 * 重拉「它记住的事」。
 *
 * 用户在插件面板里聊天时，主进程会追加事实，而设置窗口收不到任何广播——
 * 不重拉的话，列表和计数都是陈的。
 */
async function refreshFacts() {
  if (factsWritePending) return;
  const epoch = factsEpoch;
  try {
    const state = await window.pet.getAssistantState();
    // 期间用户删掉了事实：这次拉回来的是旧事实，丢掉。
    if (epoch !== factsEpoch || factsWritePending) return;
    renderFacts(state?.chat?.facts || []);
  } catch {
    // 拉不到就先用页面上已有的，别把列表清空。
  }
}

/**
 * 忘掉一条。
 *
 * 先改界面再存盘：等磁盘写完才动界面，用户会以为按钮没反应。
 * 存盘失败就把真的那份拉回来——不能界面说没了、磁盘上还在。
 */
async function deleteFact(fact) {
  const next = currentFacts.filter((f) => f !== fact);
  factsEpoch += 1;
  factsWritePending = true;
  renderFacts(next);
  let failed = false;
  try {
    // 只写 facts：聊天记录（chat.messages）不受影响。
    await window.pet.saveAssistantPrefs({ chat: { facts: next } });
    show('忘掉了一条');
  } catch (err) {
    failed = true;
    show(`删除失败：${err?.message || err}`, 'error');
  } finally {
    factsWritePending = false;
    factsEpoch += 1;
  }
  // 存盘失败：把真的那份拉回来——不能界面说没了、磁盘上还在。
  // 必须在解除「写入进行中」之后拉：刷新会被正在进行的写入挡住。
  if (failed) void refreshFacts();
}

clearFactsBtn.addEventListener('click', async () => {
  showPending('清除中…');
  factsWritePending = true;
  factsEpoch += 1;
  try {
    await window.pet.saveAssistantPrefs({ chat: { messages: [], facts: [] } });
    renderFacts([]);
    show('它记住的事已经清空了');
  } catch (err) {
    show(`清除失败：${err?.message || err}`, 'error');
  } finally {
    factsWritePending = false;
    factsEpoch += 1;
  }
});

// ---------------------------------------------------------------------------
// 插件分区
//
// 「装了什么、开着哪些」是**应用级别**的开关，所以归设置窗口管。
// 插件**自己**的偏好（剪贴板助手的开关、天气的城市……）在插件页面里——
// 各管各的，这里不重复一份。
// ---------------------------------------------------------------------------

const pluginListEl = document.getElementById('pluginList');

/** 画插件清单。 */
function renderPlugins(list) {
  pluginListEl.textContent = '';
  let on = 0;
  for (const p of list) {
    if (p.enabled) on += 1;

    const li = document.createElement('li');
    li.className = p.enabled ? 'plugin-row' : 'plugin-row off';
    // 带上 id：自动化要能指着某个插件点（它也方便用户用开发者工具查）。
    li.dataset.pluginId = p.id;

    const icon = document.createElement('span');
    icon.className = 'p-icon';
    icon.textContent = p.icon || '•';

    const text = document.createElement('span');
    text.className = 'p-text';
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name || p.id;
    const desc = document.createElement('span');
    desc.className = 'p-desc';
    desc.textContent = p.description || '';
    text.append(name, desc);

    // 「内置 / 用户」：用户得一眼看出哪个是自己装的。
    const src = document.createElement('span');
    src.className = 'p-src';
    src.textContent = p.source === 'user' ? '用户' : '内置';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'p-enable';
    box.checked = Boolean(p.enabled);
    box.title = p.enabled ? '关掉它' : '打开它';
    box.addEventListener('change', async () => {
      // 勾选框已经动了：界面先跟上，别等 IPC 回来才变。
      li.classList.toggle('off', !box.checked);
      try {
        const result = await window.pet.setPluginEnabled(p.id, box.checked);
        if (!result || result.ok !== true) {
          throw new Error(result?.message || '主进程拒绝了这次开关');
        }
        show(box.checked ? `「${p.name}」开起来了` : `「${p.name}」关掉了`);
        // 重画一遍：关掉的插件它的窗口也跟着关了，状态要从主进程重新拉。
        await refreshPlugins();
        // 插件开不开决定它的工具在不在 agent 的表里。
        await refreshAgentTools();
      } catch (err) {
        // 没生效就把勾选框拨回去：界面不能显示一个没发生的状态。
        box.checked = !box.checked;
        li.classList.toggle('off', !box.checked);
        show(`开关失败：${err?.message || err}`, 'error');
      }
    });

    li.append(icon, text, src);

    // 「注册到 agent」：这个插件的工具与技能接不接给 agent。
    // 没有工具也没有技能的插件没什么可接的——不给这个开关。
    if (p.hasAgent) {
      const agent = document.createElement('label');
      agent.className = 'p-agent';
      agent.title = '把这个插件的工具与技能接给 agent';
      const agentBox = document.createElement('input');
      agentBox.type = 'checkbox';
      agentBox.checked = Boolean(p.agentEnabled);
      agentBox.addEventListener('change', async () => {
        try {
          const result = await window.pet.setPluginAgentEnabled(p.id, agentBox.checked);
          if (!result || result.ok !== true) {
            throw new Error(result?.message || '主进程拒绝了这次开关');
          }
          show(
            agentBox.checked
              ? `「${p.name}」接给 agent 了`
              : `「${p.name}」不再接给 agent`
          );
          // 它的工具进出了 agent 的工具表，「工具」页要重画。
          await refreshAgentTools();
        } catch (err) {
          agentBox.checked = !agentBox.checked;
          show(`开关失败：${err?.message || err}`, 'error');
        }
      });
      const agentText = document.createElement('span');
      agentText.textContent = '注册到 agent';
      agent.append(agentBox, agentText);
      li.append(agent);
    }

    li.append(box);
    pluginListEl.append(li);
  }
  setSummary('plugins', `${on}/${list.length}`);
}

/** 重新拉一次插件清单。 */
async function refreshPlugins() {
  let list = null;
  try {
    list = (await window.pet.listPlugins?.()) || [];
  } catch (err) {
    console.warn('[desk-pet] 插件清单拉取失败：', err?.message);
    return;
  }
  // 插件名用来给「工具」页分组取标题。
  pluginNames = new Map(list.map((p) => [p.id, p.name || p.id]));
  renderPlugins(list);
  // 插件名变了，工具的分组标题也要跟着重画。
  renderTools();
}

/**
 * 重新拉一次工具清单。
 *
 * 插件的开关一拨，它提供的工具就进出 agent 的工具表——
 * 「工具」页得跟着重画，不然用户看的是一份过期清单。
 */
async function refreshAgentTools() {
  try {
    agentToolList = ((await window.pet.listAgentTools?.()) || []).filter((t) => t?.name);
  } catch (err) {
    console.warn('[desk-pet] 工具清单拉取失败：', err?.message);
    return;
  }
  renderTools();
}

// ---------------------------------------------------------------------------
// 系统分区
//
// 这一区的五项（开机自启、全局快捷键、鼠标穿透、边缘吸附、贴边隐藏）
// 全部由**主进程**说了算：界面不另存一份状态，只把主进程报上来的
// 状态显示出来，改动也只是转发过去。
// ---------------------------------------------------------------------------

/** 每个槽位一份状态：{ state, accelerator, error }。 */
const hotkeyStatus = {
  hotkey: { state: 'idle', accelerator: '', error: '' },
  panelHotkey: { state: 'idle', accelerator: '', error: '' },
};

/**
 * 每个槽位有没有收到过主进程推来的**带组合**的快捷键状态。
 *
 * 快捷键状态有两个来源：主进程的推送（实时）与 getState() 的快照（初始读数）。
 * 快照是**发起拉取那一刻**的值，可能比刚到的推送旧——
 * 收到过推送之后，快照就不再覆盖它。
 *
 * 只有**带组合**的推送才算数：那条推送才真的在更新快捷键状态。
 * 不带组合的推送若也置位，首个快照就再也写不进只读框了。
 */
const hotkeyStatusFromPush = { hotkey: false, panelHotkey: false };

/**
 * 用户改动开关的时刻。
 *
 * 用来保护「用户刚点的勾选框」：拉取回来的状态可能是**改动之前**的，
 * 套上去会把用户的选择闪回旧值。
 */
let systemEditEpoch = 0;

/**
 * 把主进程报上来的系统状态填进控件。
 *
 * `keepToggles` 表示「这次拉取是用户改动之前发起的」——
 * 那时四个开关的值是旧的，不能盖掉用户刚点的勾选框；
 * 快捷键状态与失败原因照常应用（它们不受本地改动影响）。
 */
function applySystemState(state, { keepToggles = false } = {}) {
  if (!state) return;
  if (!keepToggles) {
    autoLaunchBox.checked = Boolean(state.autoLaunch);
    clickThroughBox.checked = Boolean(state.clickThrough);
    edgeSnapBox.checked = state.edgeSnap !== false;
    dockEnabledBox.checked = Boolean(state.dockEnabled);
  }
  // 还没收到过推送时，快照是快捷键的唯一来源；
  // 收到过之后，快照里的值可能比推送旧，就不再用它了。
  if (!hotkeyStatusFromPush.hotkey) {
    if (typeof state.hotkey === 'string' && state.hotkey) {
      HOTKEY_FIELDS.hotkey.input.value = state.hotkey;
    }
    if (state.hotkeyStatus?.hotkey) hotkeyStatus.hotkey = state.hotkeyStatus.hotkey;
  }
  // 「唤醒输入框」那个**可以是空的**（空 = 不设），
  // 所以空串也要照写进去——否则清除之后框里还留着旧组合。
  if (!hotkeyStatusFromPush.panelHotkey) {
    if (typeof state.panelHotkey === 'string') {
      HOTKEY_FIELDS.panelHotkey.input.value = state.panelHotkey;
    }
    if (state.hotkeyStatus?.panelHotkey) {
      hotkeyStatus.panelHotkey = state.hotkeyStatus.panelHotkey;
    }
  }
  applyHotkeyStatus('hotkey');
  applyHotkeyStatus('panelHotkey');
  // 系统级失败的原因（开机自启写注册表失败之类）。
  // 「失败必须留痕 + 在界面上说得出来」那半的载体——只有终端日志用户看不见。
  if (state.lastError) {
    systemError.textContent = state.lastError;
    systemError.hidden = false;
  } else {
    systemError.textContent = '';
    systemError.hidden = true;
  }
  refreshNavSummaries();
}

/**
 * 重新拉一次主进程的系统状态。
 *
 * 切到「系统」分区、以及任何设置广播到达时都要拉：
 * 勾选框可能是在**别的窗口**里改的（托盘菜单里切穿透），
 * 而失败原因（lastError）只在主进程的状态里。
 */
async function refreshSystemState() {
  const epoch = systemEditEpoch;
  try {
    const state = await window.pet.getSystemState?.();
    // 拉取期间用户改了开关：这次拉回来的四个开关是旧值，
    // 别盖掉用户刚点的勾选框；其余（快捷键、失败原因）照常应用。
    applySystemState(state, { keepToggles: epoch !== systemEditEpoch });
  } catch {
    // 拉不到就保留页面上已有的值，别把界面清空。
  }
}

/**
 * 快捷键那一行的文字：按钮文案 + 说明行。
 *
 * 按槽位分别渲染：两个快捷键各说各的，状态也是各存各的。
 */
function applyHotkeyStatus(slotKey) {
  const field = HOTKEY_FIELDS[slotKey];
  const status = hotkeyStatus[slotKey];
  if (!field || !status) return;
  if (status.state === 'recording') {
    field.button.textContent = '请按下组合键…（Esc 取消）';
    field.hint.textContent = '按下 Ctrl / Alt / Shift 加一个键。';
    return;
  }
  field.button.textContent = status.accelerator ? field.setLabel : field.unsetLabel;
  if (status.state === 'error') {
    const reason = status.error || '这个组合不能用了';
    // 失败时要把「现在用的是哪个」一起写出来：
    // 只说失败不说保留了什么，用户得自己往上面那个框里找。
    //
    // 但**不能**说它「仍然有效」：主进程在**启动时**注册失败也会推来
    // state:'error' + 同一个组合，而那个组合根本没注册上——
    // 那样宣称「仍然有效」就是在骗人。
    // 「当前设置的组合」两种情形都成立（上面那个只读框显示的也是它）。
    field.hint.textContent = status.accelerator
      ? `${reason}。当前设置的组合：${status.accelerator}`
      : `${reason}。`;
    return;
  }
  if (status.state === 'ok' && status.accelerator) {
    field.hint.textContent = `已生效：${status.accelerator}`;
    return;
  }
  field.hint.textContent = field.emptyHint;
}

/**
 * 录快捷键：主进程接管按键捕获（before-input-event）。
 *
 * 两个快捷键共用这一个入口——一次只能录一个，
 * 主进程那边靠槽位名区分（按键捕获是全局的，不能同时录两个）。
 */
for (const [slotKey, field] of Object.entries(HOTKEY_FIELDS)) {
  field.button.addEventListener('click', async () => {
    if (hotkeyStatus[slotKey].state === 'recording') {
      try {
        const cancelled = await window.pet.cancelHotkeyRecording?.();
        // 主进程在系统控制器缺失时返回 false（**不抛**）：静默失败同样要说话。
        if (!cancelled) show('取消失败：系统还没准备好', 'error');
      } catch (err) {
        show(`取消失败：${err?.message || err}`, 'error');
      }
      return;
    }
    try {
      const started = await window.pet.recordHotkey?.(slotKey);
      // 主进程在系统控制器缺失时返回 false（**不抛**）——
      // 只在抛错时提示的话，点了没反应就是一次静默失败。
      if (!started) show('录制失败：系统还没准备好', 'error');
    } catch (err) {
      show(`录制失败：${err?.message || err}`, 'error');
    }
  });
}

/**
 * 清除「唤醒输入框」的快捷键（= 不设它）。
 *
 * 注销要由主进程做（渲染层碰不到全局快捷键），
 * 所以这里只递一个「请清除」的意图过去。
 */
HOTKEY_FIELDS.panelHotkey.clearButton.addEventListener('click', async () => {
  try {
    const ok = await window.pet.clearHotkey?.('panelHotkey');
    if (!ok) {
      show('清除失败：主进程拒绝了这次清除', 'error');
      return;
    }
    show('已清除输入框快捷键');
  } catch (err) {
    show(`清除失败：${err?.message || err}`, 'error');
  }
});

/**
 * 四个系统开关与它们的设置字段名。
 *
 * **一次只送被改的那一个字段**：全量送回会把用户没碰过的开关一起写回去。
 * 那不只是多余——它会真的把设置改坏：
 *
 * 1. 设置窗口刚打开、状态还没从主进程拉回来时，四个框全是 HTML 默认值；
 *    用户此刻点一下「鼠标穿透」，`edgeSnap` 的默认值就跟着被写回磁盘，
 *    边缘吸附被**静默**关掉。
 * 2. 托盘菜单改了穿透 → 广播 → 设置窗口的异步 `refreshSystemState()`
 *    还没回来之前，用户在设置窗口动另一个开关 → 全量写回会把托盘那次改动
 *    覆盖回旧值。
 *
 * 主进程是唯一的状态来源：这里只转发「用户改了什么」。
 */
const SYSTEM_TOGGLES = [
  [autoLaunchBox, 'autoLaunch'],
  [clickThroughBox, 'clickThrough'],
  [edgeSnapBox, 'edgeSnap'],
  [dockEnabledBox, 'dockEnabled'],
];

for (const [box, key] of SYSTEM_TOGGLES) {
  box.addEventListener('change', async () => {
    systemEditEpoch += 1;
    refreshNavSummaries();
    try {
      // 只送被改的那一个字段。
      await window.pet.saveSettings({ [key]: box.checked });
    } catch (err) {
      show(`保存失败：${err?.message || err}`, 'error');
    }
  });
}

async function init() {
  // 先挂监听再取数据：设置可能在读取期间就变了，漏掉的那次广播
  // 会让界面停在旧值上。
  window.pet.onSettingsChanged((s) => {
    if (!s) return;
    // 记下最近一次广播：init() 结束时要用它，而不是更旧的 getSettings 结果。
    pending = { ...(pending || {}), ...s };
    if (typeof s.modelId === 'string') setModel(s.modelId);
    if (typeof s.scale === 'number') updateScale(s.scale);
    if (typeof s.opacity === 'number') updateOpacity(s.opacity);
    // 系统状态可能变了（比如开机自启写注册表失败、开关被回退）：
    // 广播里带的是**设置**，不是系统状态——重新拉一次才能拿到 lastError。
    //
    // 广播**不直接写勾选框**：那样一次早于用户点击的广播会把刚勾上的框闪回旧值。
    // 勾选框只有一处真相——主进程的状态（refreshSystemState 里带 epoch 保护）。
    void refreshSystemState();
    refreshNavSummaries();
  });

  // 快捷键状态：录制中 / 成功 / 失败。
  //
  // 推送带着**槽位名**：两个快捷键的状态从同一条通道上来，
  // 不知道说的是哪一个就会张冠李戴。
  window.pet.onHotkeyStatus?.((status) => {
    if (!status) return;
    const slotKey = status.slot;
    const field = HOTKEY_FIELDS[slotKey];
    if (!field) return;
    hotkeyStatus[slotKey] = {
      state: status.state,
      accelerator: status.accelerator || '',
      error: status.error || '',
    };
    if (status.accelerator) {
      // 闩**只在推送带着组合时**才置位：
      // 推送是快捷键状态的实时通道，收到过之后 getState() 的快照
      // 就不再覆盖它了（快照可能是发起拉取那一刻的旧值）。
      //
      // 但一条**不带组合**的推送（比如刚进录制态、还没录出组合）
      // 并没有在更新快捷键状态——它若也把闩置位，
      // 首个快照就永远写不进只读框，框会一直停在占位符「未设置」。
      hotkeyStatusFromPush[slotKey] = true;
      // 上面那个只读框显示的是「当前生效的组合」。
      // 推送里的 accelerator 就是当前生效的那一个——
      // 录制成功时旧的此刻已经被注销了，框里还留着它就是骗人。
      field.input.value = status.accelerator;
    } else if (status.state === 'idle') {
      // 「空闲」且没有组合 = 这个快捷键被清除了。
      // 这时框里的旧组合必须抹掉：它已经不生效了。
      hotkeyStatusFromPush[slotKey] = false;
      field.input.value = '';
    }
    applyHotkeyStatus(slotKey);
    refreshNavSummaries();
  });

  const [settings, models, assistantState, tts, llm, systemState, agentTools] = await Promise.all([
    window.pet.getSettings(),
    window.pet.listModels(),
    window.pet.getAssistantState(),
    window.pet.getTtsStatus(),
    window.pet.getLlmStatus(),
    // 系统状态拉不到不能拖垮整个初始化：拉不到就当没有系统状态，
    // 其余分区照常显示（Promise.all 一挂，设置窗口就停在半初始化状态）。
    //
    // 可选调用：preload 日后少了这个 API 时也不能**同步**抛
    // （`undefined.catch` 是 TypeError，正好抵消这里想要的容错）。
    Promise.resolve(window.pet.getSystemState?.()).catch(() => null),
    // 工具清单：拉不到就当没有可放行的工具，那一栏空着。
    Promise.resolve(window.pet.listAgentTools?.()).catch(() => []),
  ]);
  // 下拉框照填不误——它所在的分区是不是当前分区，与填充无关。
  // （改成「切到外观分区才填」会让 setModel 的竞态兜底失效，
  //   也会让 e2e 里那条「广播先于下拉框填充到达」的用例失守。）
  knownModels = models || [];
  for (const m of knownModels) {
    const opt = document.createElement('option');
    opt.value = m.id;
    // 导入的模型标一下：用户一眼能看出哪些是自己加的、哪些能删。
    opt.textContent = m.source === 'user' ? `${m.name}（导入）` : m.name;
    modelSelect.appendChild(opt);
  }
  // 音色：下拉框选常用音色（中文名），datalist 让自定义框里能查到 id。
  //
  // 下拉框**不能**用 datalist 代替：datalist 的候选弹层会按输入框当前的
  // 内容过滤，字段预填着当前音色 id 时，几十条里只显示前缀匹配的那几条——
  // 看着就像「音色没加上」。
  for (const v of tts?.voices || []) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    voiceSelect.appendChild(opt);

    const item = document.createElement('option');
    item.value = v.id;
    item.label = v.label;
    voiceList.appendChild(item);
  }
  // 选项填好了：广播里的值比 getSettings 的结果新，优先用它。
  const latest = { ...settings, ...(pending || {}) };
  pending = null;
  setModel(latest.modelId);
  updateScale(latest.scale);
  updateOpacity(latest.opacity);
  // 工具清单要先到，「工具」页才能按来源分组画出来。
  agentToolList = (agentTools || []).filter((t) => t?.name);
  applyAssistantState(assistantState);
  // 助理状态拉不到时 applyAssistantState 会直接返回，
  // 音色那一栏就还是初始的样子——「当前生效」得照常显示。
  updateVoiceCurrent();
  applySystemState(systemState);
  showKeyStatus(tts);
  showLlmKeyStatus(llm);
  // 插件清单：目录上的「N/M」摘要要一开始就对。
  await refreshPlugins();
  refreshNavSummaries();
  // 落在默认分区（桌宠）。roving tabindex 也在这一步定下来。
  activateSection('pet');
}

modelSelect.addEventListener('change', async () => {
  const requested = modelSelect.value;
  // 先给一个「进行中」的反馈：切换要等渲染层回执（最长 12 秒），
  // 期间状态栏不能是空的。
  showPending('切换中…');
  // 选中项变了：「删除」能不能点取决于它是不是导入的模型。
  updateDeleteEnabled();
  // 下拉框已经变了，摘要要跟着变。
  refreshNavSummaries();
  let result;
  try {
    // switchModel 现在**等渲染层的回执**：主进程拿到「模型真的上屏了」
    // 才算成功。加载失败时主进程会把磁盘上的 modelId 回滚到屏幕上
    // 那个形象，并在这里报告失败——不能先显示「已切换到 …」。
    result = await window.pet.switchModel(requested);
  } catch (err) {
    show(`切换失败：${err?.message || err}`, 'error');
    return;
  }
  if (!result || result.ok !== true) {
    // 被**更新的**请求顶掉：这不是失败，不该弹一条「切换失败」——
    // 后面那次请求的结论才是用户该看到的。
    // 也不能动下拉框：它已经停在用户最后选的那一项上，
    // 拨回去反而会让下拉框与屏幕上跑的形象对不上。
    if (result?.superseded) return;
    // 失败：下拉框拨回**屏幕上那个**形象，别停在用户点的那个。
    if (result?.modelId) setModel(result.modelId);
    refreshNavSummaries();
    show(`切换失败：${result?.error || '模型加载失败'}`, 'error');
    return;
  }
  // 成功：请求了未知 id 时主进程会按注册表回退，
  // 这里必须把下拉框也拨回实际生效的那个。
  if (typeof result.modelId === 'string' && result.modelId !== requested) setModel(result.modelId);
  const label = modelSelect.options[modelSelect.selectedIndex]?.text || requested;
  refreshNavSummaries();
  show(`已切换到 ${label}`);
});

/**
 * 导入一个 Live2D 模型。
 *
 * 复制模型文件是 IO 密集的（几十 MB 的贴图），期间必须有反馈：
 * 没有进度提示的话，界面看起来就像卡死了。
 */
importModelBtn.addEventListener('click', async () => {
  importModelBtn.disabled = true;
  showPending('导入中…');
  let result;
  try {
    result = await window.pet.importModel();
  } catch (err) {
    show(`导入失败：${err?.message || err}`, 'error');
    importModelBtn.disabled = false;
    return;
  }
  importModelBtn.disabled = false;

  // 用户在文件夹选择器里点了取消：不是错误，别弹红色提示。
  if (result?.canceled) {
    show('');
    return;
  }
  if (!result || result.ok !== true) {
    show(`导入失败：${result?.error || '未知原因'}`, 'error');
    return;
  }
  // 注册表变了：重新拉一次，下拉框里才有新形象。
  await refreshModelOptions(result.model?.id);
  refreshNavSummaries();
  if (result.switched === false) {
    // 模型已经在库里，只是没切过去——这与「导入失败」是两件事，
    // 说混了会让用户去重复导入一遍。
    show(`已导入 ${result.model?.name || ''}，但切换失败：${result.error || '未知原因'}`, 'error');
    return;
  }
  show(`已导入并切换到 ${result.model?.name || ''}`);
});

/**
 * 删除一个导入的模型。
 *
 * 确认框在主进程弹（原生）：模型文件从用户数据目录里消失之后没法撤销，
 * 一次点击不该就删掉。
 */
deleteModelBtn.addEventListener('click', async () => {
  const id = modelSelect.value;
  const entry = knownModels.find((m) => m.id === id);
  if (!entry) {
    show('没有选中的形象。', 'error');
    return;
  }
  deleteModelBtn.disabled = true;
  let result;
  try {
    result = await window.pet.deleteModel(id);
  } catch (err) {
    show(`删除失败：${err?.message || err}`, 'error');
    updateDeleteEnabled();
    return;
  }
  if (result?.canceled) {
    updateDeleteEnabled();
    return;
  }
  if (!result || result.ok !== true) {
    show(`删除失败：${result?.error || '未知原因'}`, 'error');
    updateDeleteEnabled();
    return;
  }
  // 列表变了：重新拉。删掉的形象可能正是当前在用的那个，
  // 主进程已经把它切走了——它把现在该选哪个一并带回来了。
  await refreshModelOptions(result.modelId);
  refreshNavSummaries();
  show(entry.source === 'user' ? `已删除 ${result.name || ''}` : `已移除 ${result.name || ''}`);
});

// 主进程导入/删除之后会通知：设置窗口据此刷新下拉框。
// 少了这一步，新导入的形象不会出现在列表里——
// 而主进程已经切过去了，用户看到的是「桌宠换了，列表里没有它」。
//
// 通知里带着「刷新后该选哪个」：刷新是异步的，而设置广播可能先到
// 也可能后到，把该选哪个一并告诉它，两条消息到达的先后就无所谓了。
window.pet.onModelsChanged?.((modelId) => {
  refreshModelOptions(modelId).catch(() => {});
});

// 导入进度：复制几十 MB 的贴图要一会儿，没有进度就像卡死了。
window.pet.onImportProgress?.((p) => {
  if (!p || p.phase !== 'copy') return;
  const pct = p.total > 0 ? Math.round((p.copied / p.total) * 100) : 0;
  showPending(`导入中… ${pct}%（${p.copied}/${p.total}）`);
});

scaleInput.addEventListener('input', async () => {
  const v = Number(scaleInput.value);
  scaleVal.textContent = formatScale(v);
  setRangeFill(scaleInput);
  try {
    await window.pet.saveSettings({ scale: v });
  } catch (err) {
    show(`保存失败：${err?.message || err}`, 'error');
  }
});

opacityInput.addEventListener('input', async () => {
  const v = Number(opacityInput.value);
  opacityVal.textContent = formatOpacity(v);
  setRangeFill(opacityInput);
  try {
    await window.pet.saveSettings({ opacity: v });
  } catch (err) {
    show(`保存失败：${err?.message || err}`, 'error');
  }
});

/**
 * 总音量滑块。
 *
 * 存在 assistant.json 的 `sound.volume` 里，不在 settings.json——
 * 它是**助理**的偏好（提示音与桌宠说话共用一个值）。
 * 补丁只送 `{sound:{volume}}` 一层：mergePatch 会把 sound 里的字段
 * 深一层合并，所以 `sound.enabled` 不会被这行抹掉。
 */
volumeInput.addEventListener('input', async () => {
  const v = Number(volumeInput.value);
  volumeVal.textContent = formatVolume(v);
  setRangeFill(volumeInput);
  try {
    await window.pet.saveAssistantPrefs({ sound: { volume: v } });
  } catch (err) {
    show(`保存失败：${err?.message || err}`, 'error');
  }
});

init().catch((e) => show(`加载失败：${e.message}`, 'error'));
