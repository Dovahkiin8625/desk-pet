// plugins/toolbox/pages/toolbox.js
/**
 * 工具箱插件的页面。
 *
 * 工具逻辑都在 lib/tools.js 里，是纯函数——页面直接 import 来实时算，
 * 不用来回跑 IPC。主进程只负责把文字写进剪贴板（见 act('copy')）。
 */
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { hydrateIcons } from '/src/renderer/ui/icons.js';
import {
  base64Decode,
  base64Encode,
  dateToTimestamp,
  estimateTokens,
  formatJson,
  minifyJson,
  testRegex,
  timestampToDate,
  urlDecode,
  urlEncode,
  validateJson,
} from '../lib/tools.js';

const surface = bindSurface();

hydrateIcons();

document.body.classList.toggle('dp-panel', Boolean(surface.inPanel));

const $ = (id) => document.getElementById(id);

/** 面板里报的高度：定值（与清单里的 window.height 一致）。 */
const PANEL_HEIGHT = 560;
let panelHeightReported = false;

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------------------
// 复制与浮出提示
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  if (!message) return;
  el.textContent = message;
  el.classList.toggle('error', Boolean(isError));
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 1600);
}

/** 让主进程把文字写进剪贴板，顺手浮一句话。 */
async function copyText(text) {
  const content = String(text ?? '');
  if (!content.trim()) {
    toast('没有可复制的东西', true);
    return;
  }
  try {
    const next = await surface.act('copy', { text: content });
    const hint = next?.copied;
    toast(hint?.message || '已复制到剪贴板', hint ? hint.ok === false : false);
  } catch (err) {
    toast(`复制不了：${err?.message || err}`, true);
  }
}

// ---------------------------------------------------------------------------
// 选项卡
// ---------------------------------------------------------------------------

const tabs = [...document.querySelectorAll('.tab')];
const panels = Object.fromEntries(
  tabs.map((tab) => [tab.dataset.tool, document.getElementById(`tool-${tab.dataset.tool}`)]),
);

function activateTool(tool) {
  for (const tab of tabs) {
    const selected = tab.dataset.tool === tool;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    const panel = panels[tab.dataset.tool];
    if (panel) panel.hidden = !selected;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => activateTool(tab.dataset.tool));
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const jsonInput = $('jsonInput');
const jsonStatus = $('jsonStatus');
const jsonError = $('jsonError');

function showJsonResult(result) {
  if (result.ok) {
    if ('output' in result) jsonInput.value = result.output;
    jsonStatus.textContent = result.summary;
    jsonStatus.classList.remove('error');
    jsonError.hidden = true;
    jsonError.textContent = '';
    return;
  }
  const { error } = result;
  jsonStatus.textContent = '不是合法的 JSON';
  jsonStatus.classList.add('error');
  jsonError.textContent = error.line
    ? `第 ${error.line} 行第 ${error.column} 列：${error.message}`
    : error.message;
  jsonError.hidden = false;

}

$('jsonFormat').addEventListener('click', () => showJsonResult(formatJson(jsonInput.value)));
$('jsonMinify').addEventListener('click', () => showJsonResult(minifyJson(jsonInput.value)));
$('jsonValidate').addEventListener('click', () => showJsonResult(validateJson(jsonInput.value)));
$('jsonCopy').addEventListener('click', () => void copyText(jsonInput.value));

// ---------------------------------------------------------------------------
// Base64 / URL 编解码
// ---------------------------------------------------------------------------

const codecInput = $('codecInput');
const codecOutput = $('codecOutput');
const codecStatus = $('codecStatus');

const CODEC_RUNNERS = {
  base64Encode: (text) => base64Encode(text),
  base64Decode: (text) => base64Decode(text),
  urlEncode: (text) => urlEncode(text),
  urlDecode: (text) => urlDecode(text),
};

for (const button of document.querySelectorAll('[data-codec]')) {
  button.addEventListener('click', () => {
    const run = CODEC_RUNNERS[button.dataset.codec];
    try {
      codecOutput.value = run(codecInput.value);
      codecStatus.textContent = '';
      codecStatus.classList.remove('error');
    } catch (err) {
      codecOutput.value = '';
      codecStatus.textContent = err?.message || String(err);
      codecStatus.classList.add('error');
    }
  });
}

codecOutput.addEventListener('click', () => void copyText(codecOutput.value));

// ---------------------------------------------------------------------------
// 时间戳
// ---------------------------------------------------------------------------

const tsInput = $('tsInput');
const tsUnit = $('tsUnit');
const tsResult = $('tsResult');
const dtInput = $('dtInput');
const dtResult = $('dtResult');
const timeStatus = $('timeStatus');

/** 上一次换算出来的值（点结果行时复制用）。 */
let tsValues = null;
let dtValues = null;

function renderTime() {
  const raw = tsInput.value.trim();
  if (!raw) {
    tsResult.hidden = true;
    tsValues = null;
    timeStatus.textContent = '';
    timeStatus.classList.remove('error');
    return;
  }
  const result = timestampToDate(raw, tsUnit.value);
  if (!result.ok) {
    tsResult.hidden = true;
    tsValues = null;
    timeStatus.textContent = result.error;
    timeStatus.classList.add('error');
    return;
  }
  tsValues = result;
  tsResult.hidden = false;
  timeStatus.textContent = result.unit === 's' ? '按秒解读' : '按毫秒解读';
  timeStatus.classList.remove('error');
  for (const button of tsResult.querySelectorAll('.result-value')) {
    const key = button.dataset.copy;
    button.textContent = String(result[key] ?? '');
    button.title = String(result[key] ?? '');
  }
}

function renderDateTime() {
  const raw = dtInput.value.trim();
  if (!raw) {
    dtResult.hidden = true;
    dtValues = null;
    return;
  }
  const result = dateToTimestamp(raw);
  if (!result.ok) {
    dtResult.hidden = true;
    dtValues = null;
    timeStatus.textContent = result.error;
    timeStatus.classList.add('error');
    return;
  }
  dtValues = result;
  dtResult.hidden = false;
  for (const button of dtResult.querySelectorAll('.result-value')) {
    const key = button.dataset.copy;
    button.textContent = String(result[key] ?? '');
    button.title = String(result[key] ?? '');
  }
}

const renderTimeDebounced = debounce(renderTime, 150);
const renderDateTimeDebounced = debounce(renderDateTime, 150);

tsInput.addEventListener('input', renderTimeDebounced);
tsUnit.addEventListener('change', renderTime);
dtInput.addEventListener('input', renderDateTimeDebounced);

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** datetime-local 的本地值：YYYY-MM-DDTHH:mm:ss。 */
function localInputValue(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

$('tsNow').addEventListener('click', () => {
  tsInput.value = tsUnit.value === 'ms' ? String(Date.now()) : String(Math.floor(Date.now() / 1000));
  renderTime();
});

$('dtNow').addEventListener('click', () => {
  dtInput.value = localInputValue(new Date());
  renderDateTime();
});

for (const container of [tsResult, dtResult]) {
  container.addEventListener('click', (event) => {
    const button = event.target.closest('.result-value');
    if (!button) return;
    const source = container === tsResult ? tsValues : dtValues;
    const value = source?.[button.dataset.copy];
    if (value !== undefined) void copyText(String(value));
  });
}

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

const tokenInput = $('tokenInput');
const stTokens = $('stTokens');
const stChars = $('stChars');
const stBytes = $('stBytes');
const stLines = $('stLines');

const fmt = (n) => Number(n).toLocaleString('zh-CN');

function renderToken() {
  const result = estimateTokens(tokenInput.value);
  stTokens.textContent = fmt(result.tokens);
  stChars.textContent = fmt(result.characters);
  stBytes.textContent = fmt(result.bytes);
  stLines.textContent = fmt(result.lines);
}

tokenInput.addEventListener('input', debounce(renderToken, 120));
renderToken();

// ---------------------------------------------------------------------------
// 正则表达式
// ---------------------------------------------------------------------------

const regexPattern = $('regexPattern');
const regexText = $('regexText');
const regexFlags = $('regexFlags');
const regexStatus = $('regexStatus');
const regexMatches = $('regexMatches');

/** 界面上最多列出这么多条匹配。 */
const MAX_LISTED = 50;

function currentFlags() {
  return [...regexFlags.querySelectorAll('input[type="checkbox"]:checked')]
    .map((box) => box.value)
    .join('');
}

function renderRegex() {
  const text = regexText.value;
  regexMatches.textContent = '';
  if (!regexPattern.value.trim()) {
    regexStatus.textContent = '';
    regexStatus.classList.remove('error');
    return;
  }
  const result = testRegex({
    pattern: regexPattern.value,
    flags: currentFlags(),
    text,
  });
  if (!result.ok) {
    regexStatus.textContent = `正则不合法：${result.error}`;
    regexStatus.classList.add('error');
    return;
  }
  regexStatus.classList.remove('error');
  if (result.count === 0) {
    regexStatus.textContent = '没有匹配';
    return;
  }
  const listed = result.matches.slice(0, MAX_LISTED);
  regexStatus.textContent =
    (result.truncated || result.count > listed.length)
      ? `匹配到很多处（已列出前 ${listed.length} 条）`
      : `${result.count} 处匹配`;
  for (const [position, item] of listed.entries()) {
    const row = document.createElement('div');
    row.className = 'match-row';

    const index = document.createElement('span');
    index.className = 'match-index';
    index.textContent = `#${position + 1} @${item.index}`;

    const match = document.createElement('span');
    match.className = 'match-text';
    match.textContent = item.match === '' ? '(零宽匹配)' : item.match;
    match.title = item.match;

    row.append(index, match);

    const groupParts = [];
    if (item.namedGroups) {
      for (const [name, value] of Object.entries(item.namedGroups)) {
        groupParts.push(`${name}=${value}`);
      }
    } else {
      item.groups.forEach((group, i) => {
        if (group !== undefined) groupParts.push(`${i + 1}=${group}`);
      });
    }
    if (groupParts.length) {
      const groups = document.createElement('span');
      groups.className = 'match-groups';
      groups.textContent = groupParts.join('  ');
      groups.title = groups.textContent;
      row.append(groups);
    }
    regexMatches.append(row);
  }
}

const renderRegexDebounced = debounce(renderRegex, 150);
regexPattern.addEventListener('input', renderRegexDebounced);
regexText.addEventListener('input', renderRegexDebounced);
regexFlags.addEventListener('change', renderRegex);

// ---------------------------------------------------------------------------
// 数据与高度
// ---------------------------------------------------------------------------

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
