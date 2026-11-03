import { chatCompletionStreamWithProbe } from '../llm/openai.js';
import { createStreamSplitter, parseReply } from './prompt.js';

/**
 * 后端 #1：普通的大模型聊天。
 *
 * 「普通」的意思是：**一次调用、一段回复、没有工具、没有多步**。
 * 将来做 agent 形态时，它就是「零个工具、一步」的那种 agent——
 * 上层（气泡、历史、情绪、插件）分不出两者的区别。
 *
 * 这一层做两件事：
 * 1. 把「正文 + 元数据」的整段回复拆开（见 prompt.js 的说明）；
 * 2. 把正文**逐段**交给 `ctx.onDelta`，气泡那边就能逐字显示。
 */
export function createPlainBackend({ fetchImpl = fetch } = {}) {
  return {
    id: 'chat',
    label: '普通对话',

    async chat(ctx) {
      const { system, messages, config = {}, onDelta } = ctx;
      const splitter = createStreamSplitter();

      const result = await chatCompletionStreamWithProbe(
        {
          apiKey: config.apiKey,
          model: config.model,
          messages: [{ role: 'system', content: system }, ...(messages || [])],
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          maxTokensField: config.maxTokensField,
        },
        {
          fetchImpl,
          baseUrls: config.baseUrls,
          onDelta: (delta) => {
            // 只有「该显示的那部分」才往外送：元数据不能漏进气泡。
            const out = splitter.push(delta);
            if (out) onDelta?.(out);
          },
        }
      );

      // 流结束了：把尾巴也吐出来（短回复常常全在尾巴里）。
      const tail = splitter.finish();
      if (tail) onDelta?.(tail);

      return { ...parseReply(result.text), baseUrl: result.baseUrl };
    },
  };
}
