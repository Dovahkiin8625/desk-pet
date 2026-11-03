import { MAX_CHAT_MESSAGES, MAX_CHAT_FACTS } from '../../../shared/assistant.js';

/**
 * 记忆的纯函数工具。
 *
 * 「记多少」与「发多少」是两回事：
 * - **记**：磁盘上留 40 条消息、50 条事实（用户能在设置页里看到并清空）；
 * - **发**：每次只把最近 12 条消息交给模型（见 prompt.js 的 buildChatMessages）。
 *
 * 截断的**最终关口**在 `sanitizeAssistant`（读写都过那里）；
 * 这里的函数负责「追加时不要让它无限增长」。
 */

/** 追加一条聊天消息，并截断到上限。 */
export function appendMessage(messages, message, max = MAX_CHAT_MESSAGES) {
  const list = Array.isArray(messages) ? messages : [];
  const next = [...list, message];
  return next.length > max ? next.slice(next.length - max) : next;
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
