// plugins/translate/lib/translate.js
/**
 * 翻译的纯逻辑：认语言、定目标语言、拼提示词、拆接口的回复。
 *
 * 这一层**不碰 electron，也不碰网络**（除了那两个明确要发请求的函数），
 * 所以能直接拿单测罩住。
 */

/**
 * 能译成的语言。
 *
 * `label` 是设置里存着的值（面板的下拉直接显示它），
 * `code` 是翻译接口认的代码，`name` 是给模型看的说法。
 */
export const LANGUAGES = Object.freeze([
  { label: '自动（外文→中文，中文→英语）', code: 'auto', name: '自动' },
  { label: '中文', code: 'zh-CN', name: '中文' },
  { label: '英语', code: 'en', name: '英语' },
  { label: '日语', code: 'ja', name: '日语' },
  { label: '韩语', code: 'ko', name: '韩语' },
  { label: '法语', code: 'fr', name: '法语' },
  { label: '德语', code: 'de', name: '德语' },
  { label: '西班牙语', code: 'es', name: '西班牙语' },
  { label: '俄语', code: 'ru', name: '俄语' },
]);

/** 自动模式那一项的 label。 */
export const TARGET_AUTO = LANGUAGES[0].label;

/** 按 label 取语言；认不出来就当自动。 */
export function languageByLabel(label) {
  const found = LANGUAGES.find((item) => item.label === String(label || ''));
  return found || LANGUAGES[0];
}

/**
 * 这段文字是不是中文。
 *
 * 判据只有一条：**有没有汉字**。
 * 够用了——自动模式要回答的只是「译成中文还是译成英语」。
 */
export function isChinese(text) {
  return /[㐀-鿿]/.test(String(text || ''));
}

/**
 * 定下译成哪种语言。
 *
 * 自动模式：中文译成英语，外文译成中文。
 *
 * @param {string} text 原文
 * @param {string} label 设置里选的那个 label
 * @returns {{code: string, name: string, source: 'zh'|'other', auto: boolean}}
 */
export function resolveTarget(text, label) {
  const language = languageByLabel(label);
  if (language.code !== 'auto') {
    return {
      code: language.code,
      name: language.name,
      source: isChinese(text) ? 'zh' : 'other',
      auto: false,
    };
  }
  const source = isChinese(text) ? 'zh' : 'other';
  const target = source === 'zh' ? LANGUAGES.find((l) => l.code === 'en') : LANGUAGES.find((l) => l.code === 'zh-CN');
  return { code: target.code, name: target.name, source, auto: true };
}

/**
 * 给模型的那段提示词。
 *
 * 只让它输出译文：模型爱解释，一解释译文里就混进别的东西。
 */
export function buildPrompt(text, targetName) {
  return [
    `把下面这段文字翻译成${targetName}。`,
    '只输出译文本身：不要解释、不要加引号、不要重复原文。',
    '',
    String(text || ''),
  ].join('\n');
}

/** 给模型的系统提示词（模型不支持 system 时可以不要）。 */
export const TRANSLATE_SYSTEM = '你是一个翻译引擎。用户给你一段文字和目标语言，你只回译文，不要任何多余的字。';

/** 免费公共翻译接口（Google 那个不用 key 的端点）。 */
export const PUBLIC_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * 拆公共接口的回复。
 *
 * 它回的是 `[[["译文","原文",…],["译文2",…]], …]`：
 * 第一层是句子数组，每个句子的第一个元素是译文。
 */
export function parsePublicTranslation(data) {
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const text = segments
    .map((segment) => (Array.isArray(segment) ? String(segment[0] || '') : ''))
    .join('');
  return text.trim();
}

/**
 * 走公共翻译接口。
 *
 * @param {string} text 原文
 * @param {string} targetCode 目标语言的代码
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] 换掉 fetch（测试用）
 * @param {number} [options.timeoutMs] 超时
 */
export async function translateWithPublic(text, targetCode, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url =
    `${PUBLIC_ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(targetCode)}` +
    `&dt=t&q=${encodeURIComponent(String(text || ''))}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`翻译接口回了 ${response.status}`);
  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`翻译接口的回包看不懂：${err?.message || err}`);
  }
  const result = parsePublicTranslation(data);
  if (!result) throw new Error('翻译接口没给出译文');
  return result;
}
