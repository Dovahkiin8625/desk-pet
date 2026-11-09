import { randomUUID } from 'node:crypto';
import {
  MAX_CHAT_FACTS,
  CHAT_KIND,
  CHAT_KIND_LIMITS,
  chatKindOf,
} from '../../../shared/assistant.js';

/**
 * 记忆的纯函数工具。
 *
 * 「记多少」与「发多少」是两回事：
 * - **记**：磁盘上留的条数**按分类分路**（见 CHAT_KIND_LIMITS）、50 条事实
 *   （用户能在设置页里看到并清空）；
 * - **发**：每次只把最近 12 条 user/reply 交给模型
 *   （见 prompt.js 的 buildChatMessages）。
 *
 * 截断的**最终关口**在 `sanitizeAssistant`（读写都过那里）；
 * 这里的函数负责「追加时不要让它无限增长」。
 */

/** meta 里单个字符串最多留多少字。 */
const MAX_META_STRING = 1000;

/** meta 里一个数组最多留多少项。 */
const MAX_META_ITEMS = 20;

/** meta 里最多留多少个键。 */
const MAX_META_KEYS = 30;

/** 一条记录的 meta 最多多少字符（超了就再砍字符串）。 */
const MAX_META_CHARS = 4000;

/**
 * 把 meta 里的长字符串、数组、层级收一收。
 *
 * 递归深度也有限：meta 是给界面看的结构化数据，不是数据湖。
 */
function clampMeta(value, limit, depth = 0) {
  if (depth > 4) return '[略]';
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_META_ITEMS).map((item) => clampMeta(item, limit, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_META_KEYS)) {
      out[key] = clampMeta(item, limit, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 给 meta 定一个体积上限。
 *
 * **为什么要有**：规格 §4.4 估的是「每条约 200 字」，
 * 但工具结果（读一个 500 行的文件、跑一条 `ls -la` 的输出）天然可以很大；
 * 而 assistant.json 是**每次改动整份重写**的——
 * 一条撑爆的记录会让每次保存都变贵。
 *
 * 砍体积时**保留结构**：taskId、tool 名这些字段没了就没法把步骤归并回任务了。
 * 所以是「把长字符串砍短」，而不是「只留一段预览」。
 */
export function capMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  let limit = MAX_META_STRING;
  let clamped = clampMeta(meta, limit);
  let text = '';
  try {
    text = JSON.stringify(clamped);
  } catch {
    return null; // 循环引用之类的坏数据：直接不要 meta
  }
  let guard = 0;
  while (text.length > MAX_META_CHARS && guard < 10) {
    limit = Math.max(8, Math.floor(limit / 2));
    clamped = clampMeta(meta, limit);
    try {
      text = JSON.stringify(clamped);
    } catch {
      return null;
    }
    guard += 1;
  }
  return clamped;
}

/**
 * 把任意一条消息规整成新形状。
 *
 * 旧记录（用户升级前的数据）只有 `{role, text, at, proactive}`：
 * 这里补上 `id` 与 `kind`（按 role 兜底）。
 *
 * **`role` 由 `kind` 推导**，不是反过来：
 * kind 是新契约，role 只是为兼容旧数据保留的字段。
 * 两个都是真值来源就会自相矛盾——
 * 比如 `{kind:'user'}`（按新契约写、不写 role）会被归一化成 role:'assistant'，
 * 用户自己说的话就以助手的身份进了模型上下文（模型开始自问自答，且不报错）。
 *
 * `id` 用 randomUUID 而不是时间戳：同一毫秒里可能写好几条。
 */
export function normalizeChatEntry(raw) {
  const kind = chatKindOf(raw);
  const role = kind === CHAT_KIND.USER ? 'user' : 'assistant';
  const meta = capMeta(raw?.meta);
  return {
    id: typeof raw?.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    at: Number.isFinite(raw?.at) ? raw.at : Date.now(),
    kind,
    role,
    text: String(raw?.text ?? ''),
    proactive: Boolean(raw?.proactive),
    ...(meta ? { meta } : {}),
  };
}

/**
 * 按分类分路截断：**每路各自砍自己的尾巴**，不动别的路。
 *
 * 砍数组尾巴的做法在有步骤记录之后是错的：
 * 一条新步骤会把最老的用户输入挤掉，而模型恰恰最需要那几条用户输入。
 *
 * 保留的条目维持原有时间顺序。
 *
 * 上限表里某个分类写成 `0` 表示**这一路不限**（不是「一条不留」）。
 */
export function truncateByKind(messages, limits = CHAT_KIND_LIMITS) {
  const list = Array.isArray(messages) ? messages : [];
  const kept = [];
  const counts = new Map();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    const kind = chatKindOf(item);
    const max = Number.isFinite(limits?.[kind]) ? limits[kind] : CHAT_KIND_LIMITS[kind] ?? 0;
    const seen = (counts.get(kind) || 0) + 1;
    if (max > 0 && seen > max) continue;
    counts.set(kind, seen);
    kept.push(item);
  }
  return kept.reverse();
}

/**
 * 追加一条聊天记录，并按分类分路截断。
 *
 * 第三个参数从「总条数上限」变成了「分路上限表」；
 * 不传时用 `CHAT_KIND_LIMITS`——**注意总条数上限因此从 40 变成了分路各算**
 * （user/reply 各 40，step 与 model 各 200，task/approval/dispatch 各 100）。
 */
export function appendMessage(messages, message, limits = CHAT_KIND_LIMITS) {
  const list = Array.isArray(messages) ? messages : [];
  const next = [...list, normalizeChatEntry(message)];
  return truncateByKind(next, limits);
}

/**
 * 合并新的长期记忆：去重（按去空格后的原文）并截断。
 *
 * 去重很重要：模型很容易反复报告同一件事，
 * 不去重的话「记住的事」列表很快就变成一坨重复。
 */
export function mergeFacts(facts, newFacts, max = MAX_CHAT_FACTS) {
  const list = Array.isArray(facts) ? facts : [];
  const incoming = Array.isArray(newFacts) ? newFacts : [];
  const seen = new Set(list);
  const next = [...list];
  for (const fact of incoming) {
    const text = typeof fact === 'string' ? fact.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    next.push(text);
  }
  return next.length > max ? next.slice(next.length - max) : next;
}
