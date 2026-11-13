import {
  EMOTIONS,
  MAX_NEW_MEMORIES,
  MEMORY_KINDS,
  PROMPT_HISTORY_MESSAGES,
  CHAT_KIND_FOR_LAYER,
  LAYER,
  chatKindOf,
} from '../../../shared/assistant.js';
import { normalizeMemory } from './memory.js';
import { snapshotSection } from '../snapshot.js';

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

/**
 * 主动搭话时替用户发的那句话。
 *
 * **它要立住一条规矩**：历史是过去，「此刻」才是现在。
 * 没有这一条，模型会从历史里挖一件早就结束的事当成现状——
 * 用户早就手动停掉的音乐，被说成「还在播放」。
 */
export const PROACTIVE_TRIGGER =
  '（主动搭话：用户此刻没有说话。说一句现在能说的话。' +
  '历史里出现过、但「此刻正在发生的事」里没写的事，就当它已经过去了——别提它现在还在怎样。）';

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
    `  {"emotion":"<情绪>","mood":<整数>,"memories":[{"text":"<一句话事实>","kind":"<类型>"}]}`,
    `- emotion 只能是 ${EMOTIONS.join(' / ')} 之一。`,
    `- mood 是 -${MAX_MOOD} 到 ${MAX_MOOD} 的整数：正数表示这轮让你更开心，负数表示更闷。`,
    `- memories 只记「重要、而且长期有效」的事，最多 ${MAX_NEW_MEMORIES} 条；没有就写 []。`,
    `- kind 只能是 ${MEMORY_KINDS.join(' / ')} 之一：`,
    '  explicit=用户明确让你记住的；preference=用户的偏好习惯；fact=用户的稳定事实；plan=长期约定或承诺。',
    '- 用户说了「记住…」「别忘了…」时，必须记一条，kind 用 explicit。',
    '- 临时的事不要记：今天、刚才、这次、现在这类过几天就失效的，别写。',
  ];
}

/**
 * 组装系统提示词：人设 + 记忆 + 输出契约。
 */
export function buildSystemPrompt({ persona = {}, facts = [], now = new Date(), snapshot = [] } = {}) {
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
    snapshotSection(snapshot),
  ]
    .filter(Boolean)
    .join('\n');
}

/** 早于这个时刻的时间戳是坏数据（多半是 0 或 1），算不出相对时间。 */
const MIN_PLAUSIBLE_AT = Date.UTC(2001, 0, 1);

/**
 * 相对时间（「刚刚」「12 分钟前」）。
 *
 * **历史必须带时间**：不带的话，模型分不清「刚才」和「三天前」，
 * 只能把整段历史当成此刻正在发生的事。
 */
function relativeTime(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t < MIN_PLAUSIBLE_AT) return '';
  const diff = now - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/**
 * 从历史里挑出**这一层**该看见的对话。
 *
 * 「哪一层」是新的维度：交互层看得见自己派过什么（dispatch），
 * 执行层看不见（规格 §6）。
 *
 * **只取最近若干条**：磁盘上留的条数按分类分路（见 memory.js），
 * 提示词里只带 12 条——「记多少」与「发多少」是两回事。
 *
 * **每条都带相对时间**：模型得看得出这条是刚才说的还是三小时前说的。
 */
export function buildHistoryMessages({
  history = [],
  layer = LAYER.INTERACTION,
  now = Date.now(),
} = {}) {
  const kinds = CHAT_KIND_FOR_LAYER[layer] || CHAT_KIND_FOR_LAYER[LAYER.INTERACTION];
  const list = Array.isArray(history) ? history : [];
  return list
    .filter((item) => item && item.text && kinds.includes(chatKindOf(item)))
    .slice(-PROMPT_HISTORY_MESSAGES)
    .map((item) => {
      const when = relativeTime(item.at, now);
      return {
        role: item.role === 'user' ? 'user' : 'assistant',
        content: when ? `[${when}] ${item.text}` : item.text,
      };
    });
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
  now = Date.now(),
} = {}) {
  const messages = buildHistoryMessages({ history, layer, now });
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
  const memories = [];
  for (const item of rawMemories) {
    const entry = normalizeMemory(item);
    if (entry) memories.push(entry);
    if (memories.length >= MAX_NEW_MEMORIES) break;
  }
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
