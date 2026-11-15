import { chatCompletionStreamWithProbe } from '../llm/openai.js';

/**
 * 造一个「带着工具调一次模型」的函数（给 agent 循环用）。
 *
 * ## 为什么要单独一个文件
 *
 * 请求体的拼法必须只有一份：只发一个 token 字段、空的 `tools` 不发、
 * think 参数怎么处理。各写一份的话，改了一处忘了另一处，
 * 症状是「工具参数莫名其妙坏了」，极难查。
 *
 * 差别只有一处，由参数控制：token 下限（agent 要 2048，普通对话按 800）。
 */
export function createModelCaller({ fetchImpl = fetch, minMaxTokens = 0 } = {}) {
  return async function callModel(
    { system = '', messages = [], tools = [], onDelta = null, signal = null } = {},
    config = {}
  ) {
    // 缺省时按 800 兜底（与 llm/openai.js 一致）：
    // 少了它，`Number(undefined) || 0` 会算出 0——而 0 是「合法数字」，
    // 于是真的发出去 max_tokens: 0，服务端会当成「一个字也不许说」。
    const wanted = Number(config.maxTokens);
    const base = Number.isFinite(wanted) && wanted > 0 ? wanted : 800;
    const result = await chatCompletionStreamWithProbe(
      {
        apiKey: config.apiKey,
        model: config.model,
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: config.temperature,
        maxTokens: Math.max(base, minMaxTokens),
        maxTokensField: config.maxTokensField,
        // think 模式：模型先思考再回答（关着时只是一个「不要思考」）。
        think: config.think,
        tools,
      },
      { fetchImpl, baseUrls: config.baseUrls, signal, onDelta }
    );
    return { text: result.text, toolCalls: result.toolCalls, baseUrl: result.baseUrl };
  };
}
