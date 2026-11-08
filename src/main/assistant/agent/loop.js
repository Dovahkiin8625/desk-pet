import { TOOL_RISK } from '../../../shared/assistant.js';
import {
  compactAgentMessages,
  compactionNote,
  stripMeta,
  truncateToolResult,
} from './prompt.js';

/**
 * agent 循环。
 *
 * 规格 §6.1 的骨架：
 *
 * ```
 * 组 system prompt
 * messages = 历史（只取 user/reply）+ 用户这一句
 * 循环（最多 maxSteps 步）：
 *   1. 调模型
 *   2. 没有 tool_calls → 这就是最终回复 → 结束
 *   3. 有 tool_calls → 逐个处理：找工具 → 审批 → 执行 → 结果作为 role:'tool' 喂回去
 * ```
 *
 * ## 三条最容易做错的
 *
 * 1. **每个 tool_call 都要有一条 `role:'tool'` 的消息。**
 *    哪怕内容是「没有这个工具」「用户拒绝了」——
 *    少一条，接口就 400（tool_calls 没有对应的结果）。
 * 2. **工具出错不终止任务**：错误要**喂回模型**，模型才能换条路。
 *    直接终止的话，用户拿到的是「agent 崩了」而不是结果。
 * 3. **上下文压缩的单位是「轮」**：assistant(带 tool_calls) + 后面连续的 tool 消息，
 *    要整轮一起丢——只丢 tool 消息会让接口报错。
 */

/** 一次任务的结局。 */
export const AGENT_OUTCOME = Object.freeze({
  /** 模型给出了最终答复。 */
  DONE: 'done',
  /** 步数用尽。 */
  MAX_STEPS: 'max_steps',
  /** 同一个错误连着出太多次，停下来。 */
  REPEATED_ERRORS: 'repeated_errors',
  /** 被取消。 */
  ABORTED: 'aborted',
});

/** 同一个错误连着出几次就停。 */
export const MAX_SAME_ERRORS = 3;

/**
 * 步数用尽时，让模型用当前上下文给个总结时加的一句。
 *
 * 规格 §12 要求「用当前上下文让模型给个总结」——
 * 甩一句「我没做完」对用户没用，他不知道做到哪一步了。
 */
const SUMMARY_INSTRUCTION =
  '你的步数用完了。请用现在的上下文给用户一个简短的总结：做到哪一步了、结果是什么。不要再调用工具。';

/**
 * 循环提前停下时，给被跳过的调用留的话。
 *
 * 少一条 tool 消息，接口就会因为「tool_calls 没有对应的结果」直接报错。
 */
const SKIPPED_TEXT = '（已跳过：这个工具连着出错，任务已经停下了）';

/**
 * 造一个 agent 循环。
 *
 * @param {object} options
 * @param {Function} options.callModel
 *   ({system, messages, tools, onDelta, signal}) → Promise<{text, toolCalls, baseUrl?}>
 * @param {Function} [options.resolveTool] (name) → 工具描述符 | null
 * @param {object} [options.gate] 审批闸门 {request({tool, args, risk, signal}) → {decision}}
 * @param {number} [options.maxSteps]
 * @param {number} [options.maxSameErrors]
 * @param {Function} [options.onEvent] 步骤事件
 * @param {object} [options.logger] 日志器 {warn?, error?}——工具出错时留一行，
 *   免得用户只看到「agent 停下了」却不知道卡在哪一步
 */
export function createAgentLoop({
  callModel,
  resolveTool = () => null,
  gate = null,
  maxSteps = 20,
  maxSameErrors = MAX_SAME_ERRORS,
  onEvent = null,
  logger = null,
} = {}) {
  /**
   * 跑一次任务。
   *
   * @returns {Promise<{text: string, steps: number, outcome: string, toolCalls: number, error: string, baseUrl: string}>}
   */
  async function run({
    system = '',
    messages = [],
    tools = [],
    signal = null,
    onDelta = null,
  } = {}) {
    let convo = Array.isArray(messages) ? messages.slice() : [];
    const toolList = Array.isArray(tools) ? tools : [];
    let steps = 0;
    // 默认按「步数用尽」算：循环跑完还没给出答复，就是没做完。
    let outcome = AGENT_OUTCOME.MAX_STEPS;
    let finalText = '';
    let lastError = '';
    let baseUrl = '';
    let toolCallCount = 0;
    let droppedTotal = 0;
    // 同一个错误连着出几次的计数。
    let errorKey = '';
    let errorCount = 0;

    while (steps < maxSteps) {
      if (signal?.aborted) {
        outcome = AGENT_OUTCOME.ABORTED;
        break;
      }
      steps += 1;

      let call;
      try {
        call = await callModel({
          system: droppedTotal > 0 ? `${system}\n${compactionNote(droppedTotal)}` : system,
          messages: convo,
          tools: toolList,
          onDelta,
          signal,
        });
      } catch (err) {
        // 取消导致的失败不算错误——它是用户的意思。
        if (signal?.aborted) {
          outcome = AGENT_OUTCOME.ABORTED;
          break;
        }
        throw err;
      }

      const text = String(call?.text || '');
      if (call?.baseUrl) baseUrl = call.baseUrl;
      const calls = Array.isArray(call?.toolCalls) ? call.toolCalls : [];

      // 没有工具调用 → 这就是最终答复。
      if (!calls.length) {
        finalText = text;
        outcome = AGENT_OUTCOME.DONE;
        break;
      }

      // **id 要算一次、两处共用**。
      // assistant 那条里的 tool_calls[].id 与后面 tool 消息的 tool_call_id
      // 必须一模一样：模型没给 id 时（有些服务端不返回），两边各算各的
      // 就会一个填 call_1_0、一个填空串——接口直接 400。
      const ids = calls.map((c, i) => String(c?.id || `call_${steps}_${i}`));

      // assistant 那条必须带 tool_calls：接口靠它把后面的 tool 消息对上号。
      // 正文里的 META 要切掉：那段 JSON 是给最终答案准备的，
      // 这一轮并不打算交卷（见 prompt.js 的 stripMeta）。
      convo.push({
        role: 'assistant',
        content: stripMeta(text),
        tool_calls: calls.map((c, i) => ({
          id: ids[i],
          type: 'function',
          function: {
            name: String(c?.function?.name || ''),
            arguments: String(c?.function?.arguments || ''),
          },
        })),
      });

      // 这一轮提前停下时，剩下的调用就「跳过」——
      // 但**它们仍然要有 tool 消息**，否则这一轮的 tool_calls 悬空。
      let stopped = false;

      for (let i = 0; i < calls.length; i += 1) {
        const c = calls[i];
        const callId = ids[i];
        toolCallCount += 1;

        if (stopped) {
          convo.push({ role: 'tool', tool_call_id: callId, content: SKIPPED_TEXT });
          onEvent?.({
            type: 'step',
            index: toolCallCount,
            tool: String(c?.function?.name || ''),
            args: null,
            result: '',
            error: SKIPPED_TEXT,
          });
          continue;
        }

        const one = await runOne(c, { signal });

        // 错误计数：**同一个**错误连着出三次就停——
        // 换个错重试是模型在换路，那该继续；同一个错反复就是死循环。
        if (one.ok) {
          errorKey = '';
          errorCount = 0;
        } else {
          const key = `${one.tool || ''}:${one.error || ''}`;
          if (key === errorKey) errorCount += 1;
          else {
            errorKey = key;
            errorCount = 1;
          }
          lastError = one.userError || one.error || lastError;
          // 留一行日志：工具出错时，用户只会看到「我停下了」，
          // 真正的原因在这里（agent 自己的日志，不进气泡）。
          // 被拒绝不算出错——那是用户的意思，不用报警。
          if (!one.denied) {
            logger?.warn?.(`[agent] 工具「${one.tool || ''}」出错：${one.error || ''}`);
          }
        }

        // **每个 tool_call 都要有一条 tool 消息**（哪怕内容是错误说明）。
        convo.push({
          role: 'tool',
          tool_call_id: callId,
          content: truncateToolResult(one.text),
        });

        onEvent?.({
          type: 'step',
          index: toolCallCount,
          tool: one.tool || '',
          args: one.args || null,
          result: one.ok ? one.text : '',
          error: one.ok ? '' : one.error || '',
          data: one.data ?? null,
        });

        if (!one.ok && errorCount >= maxSameErrors) {
          outcome = AGENT_OUTCOME.REPEATED_ERRORS;
          stopped = true;
        }
      }
      if (outcome === AGENT_OUTCOME.REPEATED_ERRORS) break;

      // 上下文压缩：工具结果越滚越大，不压迟早撑爆。
      const compacted = compactAgentMessages(convo, {});
      convo = compacted.messages;
      droppedTotal += compacted.dropped;
    }

    // 步数用尽：让模型用现在的上下文给个总结（规格 §12）。
    // **总结时不能再调工具**（tools 给空），否则就成了又一轮循环。
    // 总结失败就算了——后端会给出兜底句，空气泡才是最糟的失败形态。
    if (outcome === AGENT_OUTCOME.MAX_STEPS && finalText === '' && !signal?.aborted) {
      try {
        const call = await callModel({
          system: `${system}\n${SUMMARY_INSTRUCTION}`,
          messages: convo,
          tools: [],
          onDelta,
          signal,
        });
        if (call?.baseUrl) baseUrl = call.baseUrl;
        finalText = String(call?.text || '');
      } catch {
        // 总结失败不用管：兜底句比错误信息更适合放进气泡。
      }
    }

    return {
      text: finalText,
      steps,
      outcome,
      toolCalls: toolCallCount,
      error: outcome === AGENT_OUTCOME.REPEATED_ERRORS ? lastError : '',
      baseUrl,
    };
  }

  /**
   * 执行一次工具调用。
   *
   * **任何失败都变成一条能喂回模型的文字**，不抛异常：
   * 抛出去就等于终止整个任务，模型连换条路的机会都没有。
   *
   * 失败的话有**两句**：
   * - `text`/`error`：喂给模型的（要说清原因，模型才知道换条路）；
   * - `userError`：给用户看的（气泡里会出现，不能有内部黑话）。
   */
  async function runOne(call, { signal }) {
    const name = String(call?.function?.name || '');
    const tool = resolveTool(name);
    if (!tool) {
      const msg = `没有这个工具：${name}`;
      return { ok: false, tool: name, args: null, text: msg, error: msg };
    }

    const rawArgs = String(call?.function?.arguments || '').trim();
    let args = {};
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        const msg = `工具「${name}」的参数不是合法的 JSON`;
        return { ok: false, tool: name, args: null, text: msg, error: msg };
      }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      const msg = `工具「${name}」的参数必须是一个 JSON 对象`;
      return { ok: false, tool: name, args: null, text: msg, error: msg };
    }

    const verdict = await askApproval({ tool, args, signal });
    if (!verdict.allowed) {
      const msg = verdict.reason || `用户拒绝了「${name}」这次调用`;
      return {
        ok: false,
        tool: name,
        args,
        text: msg,
        error: msg,
        userError: verdict.userReason || msg,
        denied: true,
      };
    }

    try {
      const out = await tool.run(args, { signal });
      const text = typeof out?.text === 'string' ? out.text : String(out?.text ?? '');
      return { ok: true, tool: name, args, text, data: out?.data };
    } catch (err) {
      const msg = `工具「${name}」出错：${err?.message || err}`;
      return { ok: false, tool: name, args, text: msg, error: msg };
    }
  }

  /**
   * 问闸门：这个工具要不要用户点头。
   *
   * **没有闸门时，写与执行类工具一律不执行。**
   * L2 还没有审批气泡（那是 L3），用户根本没机会点头——
   * 那就不能替他点头。只读工具照常（只读自动放行，边界由审批策略把关）。
   *
   * **给模型的话与给用户的话要分开**：
   * 模型需要知道「为什么会这样、接下来该怎么办」，
   * 用户只需要知道「这件事我没做」，不需要「审批功能还没上线」这种内部黑话。
   */
  async function askApproval({ tool, args, signal }) {
    if (gate && typeof gate.request === 'function') {
      const decision = await gate.request({ tool, args, risk: tool.risk, signal });
      const d = String(decision?.decision || decision || '').toLowerCase();
      if (d === 'allow' || d === 'always') return { allowed: true };
      return {
        allowed: false,
        reason: `用户拒绝了「${tool.name}」这次调用`,
        userReason: `「${tool.name}」这次没有获准。`,
      };
    }
    if (tool.risk === TOOL_RISK.READ) return { allowed: true };
    return {
      allowed: false,
      reason:
        `「${tool.name}」需要用户确认，但审批功能还没上线：` +
        '请改用只读的方式再试，或者直接告诉用户这件事你做不到。',
      userReason: '有个操作需要你确认，但当前还没有确认的渠道，所以我没有动它。',
    };
  }

  return { run };
}
