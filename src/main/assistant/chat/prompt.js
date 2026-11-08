import {
  EMOTIONS,
  PROMPT_HISTORY_MESSAGES,
  CHAT_KIND_FOR_LAYER,
  LAYER,
  chatKindOf,
} from '../../../shared/assistant.js';

/**
 * 人设、系统提示词与回复解析。
 *
 * **一次模型调用要同时拿三样东西**：回复正文、这一轮的情绪、值得记住的事。
 *
 * 但回复正文必须**先流出来**（气泡要逐字显示），所以约定成：
 *
 * ```
 * <回复正文，最多 3 句，中文口语>
 *
 * <<META>>{"emotion":"happy","mood":5,"memories":["用户喜欢喝美式"]}
 * ```
 *
 * 正文在前、元数据在后。若让模型只回一个 JSON 对象，
 * 气泡在整段 JSON 生成完之前都是空的——流式就没了。
 */

/** 正文与元数据之间的标记符。 */
export const META_MARKER = '<<META>>';

/** 主动搭话时替用户发的那句话。 */
export const PROACTIVE_TRIGGER = '（现在是主动搭话的时刻，用户没有说话。找个由头说一句话。）';

/** 一次回复最多带几条新记忆。 */
const MAX_NEW_MEMORIES = 2;

/** 单条记忆的最长字数。 */
const MAX_MEMORY_LENGTH = 200;

/** 心情增量的上下限。 */
const MAX_MOOD = 10;

/**
 * 输出契约的说明。
 *
 * **普通对话与 agent 共用一份**：两边说不一样的话，
 * 就会出现「普通对话读得出情绪、agent 读不出」这种鬼故事。
 */
export function metaContractLines() {
  return [
    '- 回答写完后，另起一行输出 ' + META_MARKER + '，紧跟一个 JSON 对象（不要代码块围栏）：',
    `  {"emotion":"<情绪>","mood":<整数>,"memories":["<事实>"]}`,
    `- emotion 只能是 ${EMOTIONS.join(' / ')} 之一。`,
    `- mood 是 -${MAX_MOOD} 到 ${MAX_MOOD} 的整数：正数表示这轮让你更开心，负数表示更闷。`,
    '- memories 只写「以后还用得上的、用户身上的事实」，最多 2 条；没有就写 []。',
  ];
}

/**
 * 组装系统提示词：人设 + 记忆 + 输出契约。
 */
export function buildSystemPrompt({ persona = {}, facts = [], now = new Date() } = {}) {
  const name = String(persona.name || '小桌').trim() || '小桌';
  const style = String(persona.style || '').trim();
  const backstory = String(persona.backstory || '').trim();
  const list = Array.isArray(facts) ? facts.filter(Boolean) : [];
  const when = now instanceof Date ? now : new Date(now);

  return [
    `你是「${name}」，一只住在用户桌面上的 Live2D 桌宠。`,
    style ? `你的性格：${style}` : '',
    backstory ? `关于你：${backstory}` : '',
    '',
    '说话规则：',
    '- 用中文口语回答，1~3 句，不超过 80 字。',
    '- 只说给桌宠听的话：不要复述用户的问题，不要 Markdown，不要表情符号。',
    ...metaContractLines(),
    list.length ? `\n你记住的事：\n${list.map((f) => `- ${f}`).join('\n')}` : '',
    `现在是 ${when.getFullYear()} 年 ${when.getMonth() + 1} 月 ${when.getDate()} 日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}。`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 从历史里挑出**这一层**该看见的对话。
 *
 * 「哪一层」是新的维度：交互层看得见自己派过什么（dispatch），
 * 执行层看不见（规格 §6）。
 *
 * **只取最近若干条**：磁盘上留的条数按分类分路（见 memory.js），
 * 提示词里只带 12 条——「记多少」与「发多少」是两回事。
 */
export function buildHistoryMessages({ history = [], layer = LAYER.INTERACTION } = {}) {
  const kinds = CHAT_KIND_FOR_LAYER[layer] || CHAT_KIND_FOR_LAYER[LAYER.INTERACTION];
  const list = Array.isArray(history) ? history : [];
  return list
    .filter((item) => item && item.text && kinds.includes(chatKindOf(item)))
    .slice(-PROMPT_HISTORY_MESSAGES)
    .map((item) => ({
      role: item.role === 'user' ? 'user' : 'assistant',
      content: item.text,
    }));
}

/**
 * 组装要发给接口的消息数组：历史 + 当前这一句。
 *
 * 历史里**不带**当前这句（调用方拿的是还没追加这句话的历史），
 * 否则模型会看到同一句话出现两次。
 */
export function buildChatMessages({
  history = [],
  userText = '',
  trigger = 'user',
  layer = LAYER.INTERACTION,
} = {}) {
  const messages = buildHistoryMessages({ history, layer });
  messages.push({
    role: 'user',
    content: trigger === 'proactive' ? PROACTIVE_TRIGGER : String(userText ?? ''),
  });
  return messages;
}

/**
 * 解析模型的回复。
 *
 * 四种形态都要认：
 * 1. 正文 + `<<META>>` + JSON（标准形态）；
 * 2. 整个回复就是一个 JSON 对象（模型没听话）；
 * 3. ```json 围栏包着的 JSON；
 * 4. 其它 → 整段当正文，情绪 neutral、无记忆。
 *
 * **元数据坏了绝不能丢掉正文**——丢情绪比丢回复好得多。
 */
export function parseReply(raw) {
  const text = String(raw ?? '');
  const markerAt = text.indexOf(META_MARKER);
  if (markerAt >= 0) {
    const body = text.slice(0, markerAt).trim();
    return { text: body, ...readMeta(tryParseJson(text.slice(markerAt + META_MARKER.length))) };
  }

  const trimmed = text.trim();
  // 围栏要先剥：模型有时会回 ```json … ```。
  const unfenced = stripFence(trimmed);
  if (unfenced.startsWith('{')) {
    const parsed = tryParseJson(unfenced);
    const reply = firstString(parsed, ['reply', 'text', 'content', 'message']);
    if (reply !== null) return { text: reply, ...readMeta(parsed) };
  }
  return { text: trimmed, emotion: 'neutral', mood: 0, memories: [] };
}

/** 去掉 ```json … ``` 的围栏。 */
function stripFence(text) {
  const match = String(text || '').match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text;
}

/** 解析 JSON；失败返回 null（不抛——元数据坏了不该毁掉整条回复）。 */
function tryParseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 从若干个字段名里取第一个非空字符串。 */
function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** 从元数据里读情绪、心情与记忆（全部容错）。 */
function readMeta(meta) {
  const emotion = EMOTIONS.includes(meta?.emotion) ? meta.emotion : 'neutral';
  const rawMood = Number(meta?.mood);
  const mood = Number.isFinite(rawMood)
    ? Math.max(-MAX_MOOD, Math.min(MAX_MOOD, Math.round(rawMood)))
    : 0;
  const rawMemories = Array.isArray(meta?.memories) ? meta.memories : [];
  const memories = rawMemories
    .filter((m) => typeof m === 'string')
    .map((m) => m.trim().slice(0, MAX_MEMORY_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_NEW_MEMORIES);
  return { emotion, mood, memories };
}

/**
 * 流式正文与元数据的分离器。
 *
 * 标记符可能跨 chunk 边界（`<<MET` + `A>>`），所以**按住可能成为标记符的那截尾巴**：
 * 已收到的文本若是「`<<META>>` 的一个前缀」，就先别显示，等看清了再说。
 *
 * 按住的只有真正可能是标记符的那几个字——
 * 固定按住 N 个字会让短回复一直憋着不出来。
 *
 * 这段逻辑放在后端里，气泡只管「收到什么显示什么」。
 */
export function createStreamSplitter() {
  let raw = '';
  let shown = 0;

  /** 尾巴有多长是「标记符的一部分」。 */
  function partialMarkerLength(text) {
    const max = Math.min(text.length, META_MARKER.length - 1);
    for (let len = max; len > 0; len -= 1) {
      if (META_MARKER.startsWith(text.slice(-len))) return len;
    }
    return 0;
  }

  /** 收到一段增量，返回**可以显示**的部分（可能为空）。 */
  function flush(final = false) {
    const markerAt = raw.indexOf(META_MARKER);
    let end;
    if (markerAt >= 0) {
      end = markerAt;
    } else {
      const partial = partialMarkerLength(raw);
      end = partial > 0 && !final ? raw.length - partial : raw.length;
    }
    if (end <= shown) return '';
    const out = raw.slice(shown, end);
    shown = end;
    return out;
  }

  return {
    push(delta) {
      raw += String(delta ?? '');
      return flush(false);
    },
    finish() {
      return flush(true);
    },
    get text() {
      return raw;
    },
    /** 已经显示出去的部分。 */
    get shown() {
      return raw.slice(0, shown);
    },
  };
}
