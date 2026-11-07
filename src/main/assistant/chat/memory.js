import { randomUUID } from 'node:crypto';
import { MAX_CHAT_FACTS, CHAT_KIND_LIMITS, chatKindOf } from '../../../shared/assistant.js';

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

/**
 * 把任意一条消息规整成新形状。
 *
 * 旧记录（用户升级前的数据）只有 `{role, text, at, proactive}`：
 * 这里补上 `id` 与 `kind`（按 role 兜底）。
 *
 * `id` 用 randomUUID 而不是时间戳：同一毫秒里可能写好几条。
 */
export function normalizeChatEntry(raw) {
  const kind = chatKindOf(raw);
  const role = raw?.role === 'user' ? 'user' : 'assistant';
  const meta = raw?.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : null;
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
 * 第三个参数从「总条数上限」变成了「分路上限表」——
 * 旧的调用方（不传第三个参数）行为不变，只是上限表换成了按类的。
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
