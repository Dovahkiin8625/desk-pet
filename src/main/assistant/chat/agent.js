import { LlmError, LLM_ERRORS } from '../llm/openai.js';
import { createStreamSplitter, parseReply } from './prompt.js';
import { buildAgentSystemPrompt } from '../agent/prompt.js';
import { AGENT_OUTCOME, createAgentLoop } from '../agent/loop.js';
import { DEFAULT_AGENT } from '../../../shared/assistant.js';
import { createModelCaller } from './caller.js';

/**
 * agent 模式每一步至少给多少 token。
 *
 * 工具参数（JSON）和正文**共用**同一个额度：上限太小，
 * 参数会被截断成非法 JSON，于是每一轮都在「参数坏了」上白转——
 * 用户看到的是 agent 一直重复同一件事，却不知道为什么。
 *
 * 普通对话的 800 对 agent 来说太小了，这里抬到 2048。
 * （设置界面到 L6 才做，那之后用户可以自己调。）
 */
export const AGENT_MIN_MAX_TOKENS = 2048;

/**
 * 后端 #2：agent 模式。
 *
 * 与 `plain.js` 的关系：**同一个契约下的两个实现**。
 * 上层（气泡、历史、情绪、插件）分不出两者的区别——
 * 走哪一条，由上层选哪个后端决定（**不是**用户在设置里选的：
 * 「对话后端」那个下拉已经撤掉了，前台恒定走交互层）。
 *
 * 差别只有一处实质：**plain 一步就结束，agent 会一直走到模型不再调工具为止。**
 *
 * ## 它不做什么
 *
 * - **不排队、不管并发、不管取消**：那是 L3 的运行时的事，
 *   调用方（agent/tasks.js）把这一步的闸门按任务传进来。
 * - **不弹审批气泡**：气泡由主进程那边的事务管，
 *   这里只认一个闸门对象（`ctx.gate`）；没给闸门时，
 *   **写与执行类工具一律不执行**（见 loop.js 的 askApproval）。
 */
export function createAgentBackend({
  fetchImpl = fetch,
  /** agent 的工具表（注册表）。 */
  getTools = () => null,
  /**
   * agent 的技能清单（渐进式披露的第一级）。
   *
   * 只有「名字：说明」进提示词；正文等模型调 `skill.read` 再取。
   */
  getSkills = () => [],
  /** 审批闸门（L3 才接上）。 */
  getGate = () => null,
  getWorkspace = () => '',
  getPolicy = () => DEFAULT_AGENT.approval.policy,
  getAllowAlways = () => [],
  getMaxSteps = () => DEFAULT_AGENT.maxSteps,
  getPersona = () => ({}),
  getFacts = () => [],
  getNow = () => new Date(),
  /** 日志器（工具出错时留一行）。 */
  logger = null,
} = {}) {
  return {
    id: 'agent',
    label: 'agent 模式',

    async chat(ctx) {
      const { messages = [], config = {}, onDelta, onEvent, signal, steer, taskId = '' } = ctx;
      // 闸门是**每个任务一个**（「自动」是任务级的），
      // 所以由调用方按任务给；没给就用全局那个。
      const gate = ctx.gate ?? getGate();
      const registry = getTools();
      const tools = registry && typeof registry.list === 'function' ? registry.list() : [];

      const system = buildAgentSystemPrompt({
        persona: getPersona(),
        facts: getFacts(),
        tools,
        skills: getSkills(),
        workspace: getWorkspace(),
        approval: { policy: getPolicy(), allowAlways: getAllowAlways() },
        now: getNow(),
      });

      // **流式正文与元数据要分开**：模型会在正文后面接一段 <<META>> 的 JSON，
      // 那段不能显示在气泡里（plain.js 用的是同一个分离器）。
      const splitter = createStreamSplitter();

      const callModel = createModelCaller({
        fetchImpl,
        minMaxTokens: AGENT_MIN_MAX_TOKENS,
      });

      const loop = createAgentLoop({
        callModel: (params) => callModel(params, config),
        resolveTool: (name) =>
          registry && typeof registry.get === 'function' ? registry.get(name) : null,
        gate,
        maxSteps: getMaxSteps(),
        onEvent,
        logger,
        // 追加的要求：绑着这个任务的指令队列。
        steer: typeof steer === 'function' ? steer : null,
      });

      let run;
      try {
        run = await loop.run({
          system,
          messages,
          tools,
          signal,
          // 任务号：工具要写日志（`agent-logs/<taskId>.log`）时用得上。
          taskId,
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
export function fallbackText(run) {
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
 * 用户看了不知道该怎么办，所以这里明说「先按普通对话来」。
 *
 * **但不能见 400 就这么说**：上下文超长、参数不对、额度用完也都是 400。
 * 照着「换个模型」去折腾，用户真正的问题一个字都没被说到。
 * 所以先看原文里有没有提到工具——没提到就原样抛出去。
 */
export function translateError(err, hadTools) {
  if (hadTools && isToolsUnsupportedError(err)) {
    return new LlmError(
      '这个模型不支持工具调用，先按普通对话来。',
      { code: LLM_ERRORS.BAD_REQUEST, status: err.status, body: err.body }
    );
  }
  return err;
}

/**
 * 这个错误是不是「模型不认工具调用」？
 *
 * **不能见 400 就这么说**：上下文超长、参数不对、额度用完也都是 400。
 * 照着「换个模型」去折腾，用户真正的问题一个字都没被说到。
 */
export function isToolsUnsupportedError(err) {
  if (!(err instanceof LlmError) || err.code !== LLM_ERRORS.BAD_REQUEST) return false;
  return mentionsTools(err);
}

/** 错误原文里有没有提到「工具」——只有提到才该翻译成「模型不支持工具调用」。 */
function mentionsTools(err) {
  const text = `${err?.message || ''} ${err?.body || ''}`.toLowerCase();
  return /tool|function_call|工具/.test(text);
}
