const modelSelect = document.getElementById('model');
const scaleInput = document.getElementById('scale');
const opacityInput = document.getElementById('opacity');
const scaleVal = document.getElementById('scaleVal');
const opacityVal = document.getElementById('opacityVal');
const status = document.getElementById('status');

// 桌面助理
const chimeBox = document.getElementById('chime');
const greetingBox = document.getElementById('greeting');
const soundBox = document.getElementById('sound');
const clipboardBox = document.getElementById('clipboard');
const hotAlertBox = document.getElementById('hotAlert');
const weatherEnabledBox = document.getElementById('weatherEnabled');
const weatherCityInput = document.getElementById('weatherCity');

// 语音
const ttsEnabledBox = document.getElementById('ttsEnabled');
const voiceInput = document.getElementById('voiceId');
const voiceList = document.getElementById('voiceList');
const speedInput = document.getElementById('speed');
const speedVal = document.getElementById('speedVal');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKey');
const clearKeyBtn = document.getElementById('clearKey');
const keyStatus = document.getElementById('keyStatus');

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
const hotkeyInput = document.getElementById('hotkeyValue');
const recordHotkeyBtn = document.getElementById('recordHotkey');
const hotkeyHint = document.getElementById('hotkeyHint');
const systemError = document.getElementById('systemError');

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
const SECTION_KEYS = ['appearance', 'assistant', 'voice', 'chat', 'memory', 'system'];

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

/** 助理那六个开关。 */
const ASSISTANT_TOGGLES = [chimeBox, greetingBox, soundBox, clipboardBox, hotAlertBox, weatherEnabledBox];

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

  // 系统：五项里开了几项（快捷键非空即算「开」）。
  const systemFlags = [
    autoLaunchBox.checked,
    Boolean(hotkeyInput.value.trim()),
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

// ---------------------------------------------------------------------------
// 助理偏好
// ---------------------------------------------------------------------------

/** 把助理状态填进桌面助理/语音那一区的控件。 */
function applyAssistantState(state) {
  if (!state) return;
  chimeBox.checked = Boolean(state.chime?.enabled);
  greetingBox.checked = Boolean(state.greeting?.enabled);
  soundBox.checked = Boolean(state.sound?.enabled);
  clipboardBox.checked = Boolean(state.clipboard?.enabled);
  hotAlertBox.checked = Boolean(state.hotAlert?.enabled);
  weatherEnabledBox.checked = Boolean(state.weather?.enabled);
  weatherCityInput.value = state.weather?.city || '';
  ttsEnabledBox.checked = Boolean(state.tts?.enabled);
  voiceInput.value = state.tts?.voiceId || '';
  speedInput.value = String(state.tts?.speed ?? 1);
  speedVal.textContent = Number(state.tts?.speed ?? 1).toFixed(2);
  setRangeFill(speedInput);

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
    clipboard: { enabled: clipboardBox.checked },
    hotAlert: { enabled: hotAlertBox.checked },
    weather: { enabled: weatherEnabledBox.checked, city: weatherCityInput.value.trim() },
    tts: {
      enabled: ttsEnabledBox.checked,
      voiceId: voiceInput.value.trim(),
      speed: Number(speedInput.value),
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
for (const box of [chimeBox, greetingBox, soundBox, clipboardBox, hotAlertBox, weatherEnabledBox]) {
  box.addEventListener('change', () => {
    persistAssistantPrefs();
  });
}

weatherCityInput.addEventListener('change', () => {
  persistAssistantPrefs();
});

ttsEnabledBox.addEventListener('change', () => {
  persistAssistantPrefs();
});

voiceInput.addEventListener('change', () => {
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
// 系统分区
//
// 这一区的五项（开机自启、全局快捷键、鼠标穿透、边缘吸附、贴边隐藏）
// 全部由**主进程**说了算：界面不另存一份状态，只把主进程报上来的
// 状态显示出来，改动也只是转发过去。
// ---------------------------------------------------------------------------

/** 主进程报上来的快捷键状态。 */
let hotkeyStatus = { state: 'idle', accelerator: '', error: '' };

/**
 * 用户改动开关的时刻。
 *
 * 用来丢弃「改动之前发起的状态拉取」：拉回来的状态是旧的，
 * 套上去会把用户刚点下的勾选框又拨回去。
 */
let systemEditEpoch = 0;

/** 把主进程报上来的系统状态填进控件。 */
function applySystemState(state) {
  if (!state) return;
  autoLaunchBox.checked = Boolean(state.autoLaunch);
  clickThroughBox.checked = Boolean(state.clickThrough);
  edgeSnapBox.checked = state.edgeSnap !== false;
  dockEnabledBox.checked = Boolean(state.dockEnabled);
  if (typeof state.hotkey === 'string' && state.hotkey) {
    hotkeyInput.value = state.hotkey;
  }
  if (state.hotkeyStatus) hotkeyStatus = state.hotkeyStatus;
  applyHotkeyStatus();
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
    // 拉取期间用户改了开关：这次拉回来的是旧状态，别盖掉用户的操作。
    if (epoch !== systemEditEpoch) return;
    applySystemState(state);
  } catch {
    // 拉不到就保留页面上已有的值，别把界面清空。
  }
}

/** 快捷键那一行的文字：按钮文案 + 说明行。 */
function applyHotkeyStatus() {
  if (hotkeyStatus.state === 'recording') {
    recordHotkeyBtn.textContent = '请按下组合键…（Esc 取消）';
    hotkeyHint.textContent = '按下 Ctrl / Alt / Shift 加一个键。';
    return;
  }
  recordHotkeyBtn.textContent = '重新录制';
  if (hotkeyStatus.state === 'error') {
    hotkeyHint.textContent = hotkeyStatus.error || '这个组合不能用了，原来的组合仍然有效。';
    return;
  }
  if (hotkeyStatus.state === 'ok' && hotkeyStatus.accelerator) {
    hotkeyHint.textContent = `已生效：${hotkeyStatus.accelerator}`;
    return;
  }
  hotkeyHint.textContent = '呼出 / 隐藏桌宠。被别的程序占用时这里会写明。';
}

/** 录快捷键：主进程接管按键捕获（before-input-event）。 */
recordHotkeyBtn.addEventListener('click', async () => {
  if (hotkeyStatus.state === 'recording') {
    await window.pet.cancelHotkeyRecording?.();
    return;
  }
  try {
    await window.pet.recordHotkey?.();
  } catch (err) {
    show(`录制失败：${err?.message || err}`, 'error');
  }
});

for (const box of [autoLaunchBox, clickThroughBox, edgeSnapBox, dockEnabledBox]) {
  box.addEventListener('change', async () => {
    systemEditEpoch += 1;
    refreshNavSummaries();
    try {
      // 四个勾选框一起存：saveSettings 是整份设置对象的浅合并补丁，
      // 四个字段一起送过去省得漏。
      await window.pet.saveSettings({
        autoLaunch: autoLaunchBox.checked,
        clickThrough: clickThroughBox.checked,
        edgeSnap: edgeSnapBox.checked,
        dockEnabled: dockEnabledBox.checked,
      });
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
    if (typeof s.autoLaunch === 'boolean') autoLaunchBox.checked = s.autoLaunch;
    if (typeof s.clickThrough === 'boolean') clickThroughBox.checked = s.clickThrough;
    if (typeof s.edgeSnap === 'boolean') edgeSnapBox.checked = s.edgeSnap;
    if (typeof s.dockEnabled === 'boolean') dockEnabledBox.checked = s.dockEnabled;
    // 系统状态可能变了（比如开机自启写注册表失败、开关被回退）：
    // 广播里带的是**设置**，不是系统状态——重新拉一次才能拿到 lastError。
    void refreshSystemState();
    refreshNavSummaries();
  });

  // 快捷键状态：录制中 / 成功 / 失败。
  window.pet.onHotkeyStatus?.((status) => {
    if (!status) return;
    hotkeyStatus = status;
    applyHotkeyStatus();
  });

  const [settings, models, assistantState, tts, llm, systemState] = await Promise.all([
    window.pet.getSettings(),
    window.pet.listModels(),
    window.pet.getAssistantState(),
    window.pet.getTtsStatus(),
    window.pet.getLlmStatus(),
    window.pet.getSystemState(),
  ]);
  // 下拉框照填不误——它所在的分区是不是当前分区，与填充无关。
  // （改成「切到外观分区才填」会让 setModel 的竞态兜底失效，
  //   也会让 e2e 里那条「广播先于下拉框填充到达」的用例失守。）
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelSelect.appendChild(opt);
  }
  // 音色建议表：来自主进程（那边有一份**验过**的清单）。
  for (const v of tts?.voices || []) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.label = v.label;
    voiceList.appendChild(opt);
  }
  // 选项填好了：广播里的值比 getSettings 的结果新，优先用它。
  const latest = { ...settings, ...(pending || {}) };
  pending = null;
  setModel(latest.modelId);
  updateScale(latest.scale);
  updateOpacity(latest.opacity);
  applyAssistantState(assistantState);
  applySystemState(systemState);
  showKeyStatus(tts);
  showLlmKeyStatus(llm);
  refreshNavSummaries();
  // 落在默认分区（外观）。roving tabindex 也在这一步定下来。
  activateSection('appearance');
}

modelSelect.addEventListener('change', async () => {
  const requested = modelSelect.value;
  // 先给一个「进行中」的反馈：切换要等渲染层回执（最长 12 秒），
  // 期间状态栏不能是空的。
  showPending('切换中…');
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

init().catch((e) => show(`加载失败：${e.message}`, 'error'));
