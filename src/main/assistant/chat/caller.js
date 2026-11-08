import { chatCompletionStreamWithProbe } from '../llm/openai.js';

/**
 * 造一个「带着工具调一次模型」的函数（给 agent 循环用）。
 *
 * ## 为什么要单独一个文件
 *
 * 执行层（chat/agent.js）与交互层（layer/interaction.js）都要
 * 「带工具调一次模型」——请求体的拼法必须两处**完全一致**：
 * 只发一个 token 字段、空的 `tools` 不发、think 参数怎么处理。
 * 各写一份的话，改了一处忘了另一处，
 * 症状是「某个后端的工具参数莫名其妙坏了」，极难查。
 *
 * 两边的差别只有两处，都由参数控制：
 * - token 下限（执行层要 2048，交互层按普通对话）；
 * - 传进来的 config。
 */
export function createModelCaller({ fetchImpl = fetch, minMaxTokens = 0 } = {}) {
  return async function callModel(
    { system = '', messages = [], tools = [], onDelta = null, signal = null } = {},
    config = {}
  ) {
    const result = await chatCompletionStreamWithProbe(
      {
        apiKey: config.apiKey,
        model: config.model,
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: config.temperature,
        maxTokens: Math.max(Number(config.maxTokens) || 0, minMaxTokens),
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
