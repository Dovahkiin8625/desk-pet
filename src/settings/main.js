import { DEFAULT_VOLUME } from '../shared/volume.js';
import { parseTapLines } from '../shared/tapVoice.js';
import { resolveVoiceId, applyVoiceChoice } from '../shared/voiceChoice.js';

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
const llmBaseUrlInput = document.getElementById('llmBaseUrl');
const llmModelInput = document.getElementById('llmModel');
const llmTemperatureInput = document.getElementById('llmTemperature');
const llmTemperatureVal = document.getElementById('llmTemperatureVal');
const llmMaxTokensSelect = document.getElementById('llmMaxTokens');
const llmTokensFieldSelect = document.getElementById('llmTokensField');
const llmApiKeyInput = document.getElementById('llmApiKey');
const saveLlmKeyBtn = document.getElementById('saveLlmKey');
const clearLlmKeyBtn = document.getElementById('clearLlmKey');
const llmKeyStatus = document.getElementById('llmKeyStatus');
const llmPersonaNameInput = document.getElementById('llmPersonaName');
const llmPersonaStyleInput = document.getElementById('llmPersonaStyle');
const llmPersonaBackstoryInput = document.getElementById('llmPersonaBackstory');
const llmProactiveBox = document.getElementById('llmProactive');
const llmProactiveIntervalSelect = document.getElementById('llmProactiveInterval');
const llmFactsList = document.getElementById('llmFacts');
const clearFactsBtn = document.getElementById('clearFacts');

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

/** 七个分区：目录项、面板、摘要都用同一个 key。 */
const SECTION_KEYS = ['appearance', 'assistant', 'voice', 'chat', 'memory', 'plugins', 'system'];

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

let currentSection = 'appearance';

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
// 目录右侧的状态摘要
//
// 目录因此兼作一块仪表盘：不进每一节，也看得出整个应用现在是什么状态。
// ---------------------------------------------------------------------------

/** 助理那三个开关（插件的开关在插件页面里，这里不算）。 */
const ASSISTANT_TOGGLES = [chimeBox, greetingBox, soundBox];

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
  setSummary('appearance', modelName || '—');

  const on = ASSISTANT_TOGGLES.filter((b) => b.checked).length;
  setSummary('assistant', `${on}/${ASSISTANT_TOGGLES.length}`);

  // 语音与对话是三态，不是两态：用户最常见的坑是「开关开了但没填 Key」，
  // 只报「已开」反而把这个坑盖住了。
  const ttsKey = keyStatus.dataset.configured === 'true';
  setSummary('voice', ttsEnabledBox.checked ? (ttsKey ? '已开' : '缺 Key') : '已关');

  const llmKey = llmKeyStatus.dataset.configured === 'true';
  setSummary('chat', llmEnabledBox.checked ? (llmKey ? '已开' : '缺 Key') : '已关');

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
  llmBaseUrlInput.value = llm.baseUrl || '';
  llmModelInput.value = llm.model || '';
  llmTemperatureInput.value = String(llm.temperature ?? 0.7);
  llmTemperatureVal.textContent = Number(llm.temperature ?? 0.7).toFixed(1);
  setRangeFill(llmTemperatureInput);
  llmMaxTokensSelect.value = String(llm.maxTokens ?? 800);
  llmTokensFieldSelect.value = llm.maxTokensField || 'max_tokens';
  llmPersonaNameInput.value = llm.persona?.name || '';
  llmPersonaStyleInput.value = llm.persona?.style || '';
  llmPersonaBackstoryInput.value = llm.persona?.backstory || '';
  llmProactiveBox.checked = Boolean(llm.proactive?.enabled);
  llmProactiveIntervalSelect.value = String(llm.proactive?.minIntervalMs ?? 1800000);

  // 「它记住的事」：用户有权知道桌宠记住了什么。
  renderFacts(state.chat?.facts || []);
}

/** 画「它记住的事」。 */
function renderFacts(facts) {
  llmFactsList.textContent = '';
  for (const fact of facts || []) {
    const li = document.createElement('li');
    li.textContent = fact;
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
      persona: {
        name: llmPersonaNameInput.value.trim(),
        style: llmPersonaStyleInput.value.trim(),
        backstory: llmPersonaBackstoryInput.value.trim(),
      },
      proactive: {
        enabled: llmProactiveBox.checked,
        minIntervalMs: Number(llmProactiveIntervalSelect.value),
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
for (const select of [llmMaxTokensSelect, llmTokensFieldSelect, llmProactiveIntervalSelect]) {
  select.addEventListener('change', () => {
    persistAssistantPrefs();
  });
}
llmTemperatureInput.addEventListener('input', () => {
  llmTemperatureVal.textContent = Number(llmTemperatureInput.value).toFixed(1);
  setRangeFill(llmTemperatureInput);
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
// 世代号：刷新与「忘掉这些」并发时，别把已经清掉的事实写回去。
// ---------------------------------------------------------------------------

let factsEpoch = 0;
// 清除进行中：这段时间里发起的刷新一律作废——
// 那时候主进程里的事实还没清完，拉回来的是旧的。
let factsClearPending = false;

/**
 * 重拉「它记住的事」。
 *
 * 用户在插件面板里聊天时，主进程会追加事实，而设置窗口收不到任何广播——
 * 不重拉的话，列表和计数都是陈的。
 */
async function refreshFacts() {
  if (factsClearPending) return;
  const epoch = factsEpoch;
  try {
    const state = await window.pet.getAssistantState();
    // 期间用户点了「忘掉这些」：这次拉回来的是旧事实，丢掉。
    if (epoch !== factsEpoch || factsClearPending) return;
    renderFacts(state?.chat?.facts || []);
  } catch {
    // 拉不到就先用页面上已有的，别把列表清空。
  }
}

clearFactsBtn.addEventListener('click', async () => {
  showPending('清除中…');
  factsClearPending = true;
  factsEpoch += 1;
  try {
    await window.pet.saveAssistantPrefs({ chat: { messages: [], facts: [] } });
    renderFacts([]);
    show('它记住的事已经清空了');
  } catch (err) {
    show(`清除失败：${err?.message || err}`, 'error');
  } finally {
    factsClearPending = false;
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
      } catch (err) {
        // 没生效就把勾选框拨回去：界面不能显示一个没发生的状态。
        box.checked = !box.checked;
        li.classList.toggle('off', !box.checked);
        show(`开关失败：${err?.message || err}`, 'error');
      }
    });

    li.append(icon, text, src, box);
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
  renderPlugins(list);
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

  const [settings, models, assistantState, tts, llm, systemState] = await Promise.all([
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
  // 落在默认分区（外观）。roving tabindex 也在这一步定下来。
  activateSection('appearance');
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
