import { chatCompletionStreamWithProbe, LlmError, LLM_ERRORS } from '../llm/openai.js';
import { createStreamSplitter, parseReply } from './prompt.js';
import { buildAgentSystemPrompt } from '../agent/prompt.js';
import { AGENT_OUTCOME, createAgentLoop } from '../agent/loop.js';
import { DEFAULT_AGENT } from '../../../shared/assistant.js';

/**
 * 后端 #2：agent 模式。
 *
 * 与 `plain.js` 的关系：**同一个契约下的两个实现**。
 * 上层（气泡、历史、情绪、插件）分不出两者的区别——
 * 用户在设置里把 `llm.backend` 换成 'agent'，就走上多步循环。
 *
 * 差别只有一处实质：**plain 一步就结束，agent 会一直走到模型不再调工具为止。**
 *
 * ## 它不做什么
 *
 * - **不做后台任务**：排队、并发、取消是 L3 的运行时的事。
 * - **不做审批**：审批闸门与气泡是 L3 的事。这里留了 `getGate` 的接缝，
 *   没接上时**写与执行类工具一律不执行**（见 loop.js 的 askApproval）。
 */
export function createAgentBackend({
  fetchImpl = fetch,
  /** agent 的工具表（注册表）。 */
  getTools = () => null,
  /** 审批闸门（L3 才接上）。 */
  getGate = () => null,
  getWorkspace = () => '',
  getPolicy = () => DEFAULT_AGENT.approval.policy,
  getAllowAlways = () => [],
  getMaxSteps = () => DEFAULT_AGENT.maxSteps,
  getPersona = () => ({}),
  getFacts = () => [],
  getNow = () => new Date(),
} = {}) {
  return {
    id: 'agent',
    label: 'agent 模式',

    async chat(ctx) {
      const { messages = [], config = {}, onDelta, onEvent, signal } = ctx;
      const registry = getTools();
      const tools = registry && typeof registry.list === 'function' ? registry.list() : [];

      const system = buildAgentSystemPrompt({
        persona: getPersona(),
        facts: getFacts(),
        tools,
        workspace: getWorkspace(),
        approval: { policy: getPolicy(), allowAlways: getAllowAlways() },
        now: getNow(),
      });

      // **流式正文与元数据要分开**：模型会在正文后面接一段 <<META>> 的 JSON，
      // 那段不能显示在气泡里（plain.js 用的是同一个分离器）。
      const splitter = createStreamSplitter();

      const loop = createAgentLoop({
        callModel: async ({
          system: sys,
          messages: convo,
          tools: toolList,
          onDelta: delta,
          signal: sig,
        }) => {
          const result = await chatCompletionStreamWithProbe(
            {
              apiKey: config.apiKey,
              model: config.model,
              messages: [{ role: 'system', content: sys }, ...convo],
              temperature: config.temperature,
              maxTokens: config.maxTokens,
              maxTokensField: config.maxTokensField,
              tools: toolList,
            },
            {
              fetchImpl,
              baseUrls: config.baseUrls,
              signal: sig,
              onDelta: delta,
            }
          );
          return { text: result.text, toolCalls: result.toolCalls, baseUrl: result.baseUrl };
        },
        resolveTool: (name) =>
          registry && typeof registry.get === 'function' ? registry.get(name) : null,
        gate: getGate(),
        maxSteps: getMaxSteps(),
        onEvent,
      });

      let run;
      try {
        run = await loop.run({
          system,
          messages,
          tools,
          signal,
          onDelta: (delta) => {
            const out = splitter.push(delta);
            if (out) onDelta?.(out);
          },
        });
      } catch (err) {
        throw translateError(err, tools.length > 0);
      }

      // 流结束了：把尾巴也吐出来。
      const tail = splitter.finish();
      if (tail) onDelta?.(tail);

      const parsed = parseReply(run.text || '');
      const text = parsed.text || fallbackText(run);

      return {
        text,
        emotion: parsed.emotion,
        mood: parsed.mood,
        memories: parsed.memories,
        baseUrl: run.baseUrl,
        steps: run.steps,
        outcome: run.outcome,
      };
    },
  };
}

/**
 * 没走完的循环也要给用户一句人话。
 *
 * **空气泡是最糟的失败形态**：用户发了话，桌宠什么都没说，
 * 他会以为程序坏了。
 */
function fallbackText(run) {
  if (run.outcome === AGENT_OUTCOME.MAX_STEPS) {
    return `我没能在这 ${run.steps} 步之内做完这件事，先停下了。`;
  }
  if (run.outcome === AGENT_OUTCOME.REPEATED_ERRORS) {
    return `这个工具连着出了几次错，我先停下了：${run.error || ''}`;
  }
  if (run.outcome === AGENT_OUTCOME.ABORTED) {
    return '这件事取消了。';
  }
  return '我没能完成这件事。';
}

/**
 * 把接口的错误翻译成人听得懂的话。
 *
 * **「模型不支持工具调用」是最容易踩的一种**：agent 模式请求里带着 tools，
 * 有的模型直接 400，而原文是英文的 "tools is not supported"——
 * 用户看了不知道该怎么办，所以这里明说「换个模型或切回普通对话」。
 */
function translateError(err, hadTools) {
  if (err instanceof LlmError && err.code === LLM_ERRORS.BAD_REQUEST && hadTools) {
    return new LlmError(
      '这个模型可能不支持工具调用。换一个支持工具的模型，或者把对话后端切回「普通对话」。',
      { code: LLM_ERRORS.BAD_REQUEST, status: err.status, body: err.body }
    );
  }
  return err;
}
