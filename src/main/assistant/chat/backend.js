/**
 * 对话后端的契约与注册表。
 *
 * 一个后端就是一个对象：
 *
 * ```js
 * {
 *   id: 'chat',
 *   label: '普通对话',
 *   chat(ctx) → Promise<ChatResult>
 * }
 * ```
 *
 * `ctx` 是**对象**而不是位置参数，就是为了以后往里加东西而不用改签名——
 * 将来做 agent（nanobot / openclaw 那种会调工具、会多步思考的形态）时，
 * 要加的是 `ctx.tools` / `ctx.runTool()`，而不是改所有后端的调用方式。
 *
 * ```
 * @typedef {object} ChatContext
 * @property {string} system 系统提示词（人设 + 记忆 + 输出契约）
 * @property {Array<{role:'user'|'assistant', content:string}>} messages 组装好的对话
 * @property {'user'|'proactive'} trigger 这次是谁发起的
 * @property {object} config { apiKey, baseUrls, model, temperature, maxTokens, maxTokensField }
 * @property {AbortSignal} [signal]
 * @property {object} [turn] 这一轮带进来的东西：历史、用户原话、config
 * @property {(delta: string) => void} onDelta 流式增量；不支持流式的后端可以不调
 * @property {(event: object) => void} [onEvent] 中间事件（工具调用、步骤…）——给将来的 agent 用
 *
 * @typedef {object} ChatResult
 * @property {string} text 最终回复正文
 * @property {string} emotion 情绪标签
 * @property {number} mood 心情增量
 * @property {string[]} memories 本轮新学到的长期事实
 * @property {string} [baseUrl] 探测出来的可用接口地址（记下来，下次先用它）
 */
export function createBackendRegistry() {
  const backends = new Map();
  return {
    /** 注册一个后端。同 id 会覆盖旧的。 */
    register(id, backend) {
      backends.set(id, backend);
      return backend;
    },
    get(id) {
      return backends.get(id) || null;
    },
    list() {
      return [...backends.keys()];
    },
    has(id) {
      return backends.has(id);
    },
  };
}
