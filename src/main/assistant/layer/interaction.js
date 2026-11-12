import { createAgentLoop, AGENT_OUTCOME } from '../agent/loop.js';
import { modelRecord } from '../agent/record.js';
import { createModelCaller } from '../chat/caller.js';
import { createStreamSplitter, parseReply, META_MARKER } from '../chat/prompt.js';
import { fallbackText, translateError } from '../chat/agent.js';
import { buildInteractionPrompt } from './prompt.js';
import { createSpeechFilter, sanitizeSpeech } from './speech.js';
import { TOOL_RISK } from '../../../shared/assistant.js';

/**
 * 交互层后端（规格 §3、§4）。
 *
 * ## 它是唯一跟用户说话的那一层
 *
 * 执行层只产出结果，不说话。交互层负责：
 * - 秒级回应（最多 2 步、派单只花一次模型往返）；
 * - 管自己手头在做的事（状态写进提示词，问「怎么样了」不用调工具）；
 * - 把干不了的活儿交出去，交的时候顺手把要说的话写完。
 *
 * ## 为什么复用 agent 循环
 *
 * 循环那套「每个 tool_call 都要配一条 tool 消息」「工具出错喂回模型」
 * 的规矩，交互层一个字都不能改（改了模型就会开始说胡话）。
 * 所以直接用 `createAgentLoop`，只换提示词、工具与步数上限。
 */

/** 交互层一轮最多走几步。 */
export const INTERACTION_MAX_STEPS = 2;

/**
 * 交互层发出去的 `max_tokens` 下限。
 *
 * **为什么是下限不是上限**：工具参数与正文共用一个额度，
 * 而 `max_tokens` 是按普通对话设的（默认 800）——说明被截断，
 * 参数就不是合法 JSON，循环报错，白烧掉两步里的一步。
 * 用户自己调大的值照旧尊重，所以取「两者里大的那个」。
 */
export const INTERACTION_MIN_MAX_TOKENS = 1024;

/**
 * 造一个交互层后端。
 *
 * @param {object} options
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.getRegistry] 工具表（只用来取工具名，给过滤器用）
 * @param {Function} [options.getPlugins] 插件名清单（提示词用）
 * @param {Function} [options.getTaskTools] (turn) => 任务管理工具数组
 * @param {Function} [options.getDispatchEnabled] 能不能派单
 * @param {Function} [options.getPersona]
 * @param {Function} [options.getFacts]
 * @param {Function} [options.getNow]
 * @param {Function} [options.getTaskStates] () => 手头在做的事
 * @param {Function} [options.getMaxSteps] () => 步数上限
 * @param {Function} [options.appendRecord] 写一条分类记录（聊天历史页要显示这一回合的过程）
 */
export function createInteractionBackend({
  fetchImpl = fetch,
  getRegistry = () => null,
  getPlugins = () => [],
  getTaskTools = () => [],
  getDispatchEnabled = () => true,
  getPersona = () => ({}),
  getFacts = () => [],
  getNow = () => new Date(),
  getTaskStates = () => [],
  getMaxSteps = () => INTERACTION_MAX_STEPS,
  appendRecord = () => {},
  logger = null,
} = {}) {
  /**
   * 这一轮没答上来时的兜底。
   *
   * **不能把模型的窝囊甩给用户**：一句「我没能在这 2 步之内做完这件事」，
   * 用户既不知道发生了什么，也不知道下一步该干什么。
   *
   * 这里按交互层的分派规则来：干不了的事**统统交出去**，
   * 然后回用户一句「我去查」——用户看到的是事情在往前走。
   */
  async function rescueWithoutAnswer({
    run,
    tools,
    dispatched,
    dispatchEnabled,
    turn,
    trigger,
  }) {
    if (run.outcome !== AGENT_OUTCOME.MAX_STEPS) return fallbackText(run);
    if (dispatched) return '活儿派出去了，结果出来告诉你。';

    const userText = String(turn?.userText || '').trim();
    // 主动搭话不是用户的请求：别替用户派单。
    if (!dispatchEnabled || trigger !== 'user' || !userText) {
      return '这件事我在这儿一次做不完，先停下了。';
    }

    const submit = tools.find((t) => t.name === 'task.submit');
    if (!submit) return '这件事我在这儿一次做不完，先停下了。';
    const reply = '我去查一下，结果出来告诉你。';
    try {
      const out = await submit.run({
        title: userText.length > 20 ? `${userText.slice(0, 20)}…` : userText,
        // 派单说明限长 200 字（工具自己会拦），截在这里；
        // 用户原话由 task.submit 原样传给后台任务，不会丢。
        brief: `用户的请求：${userText.slice(0, 190)}`,
        reply,
      });
      return String(out?.data?.answer || '').trim() || reply;
    } catch {
      return '这件事我没能在这儿办起来。';
    }
  }

  return {
    id: 'interaction',
    label: '交互层',

    async chat(ctx) {
      const { messages = [], config = {}, onDelta, turn = {}, signal = null } = ctx || {};
      const trigger = String(ctx?.trigger || 'user');
      const registry = getRegistry();
      const dispatchEnabled = Boolean(getDispatchEnabled());

      // 关了派单就**不把任务管理工具给模型**：
      // 给了它就会去调，然后被拒——白白浪费一轮。
      const taskTools = dispatchEnabled ? getTaskTools(turn) : [];
      // **这一轮有没有派过单**：模型自己派了，就别再替它派一次。
      let dispatched = false;
      const tools = taskTools.map((t) =>
        t.name === 'task.submit'
          ? {
              ...t,
              run: async (args, toolCtx) => {
                const out = await t.run(args, toolCtx);
                dispatched = true;
                return out;
              },
            }
          : t,
      );
      const toolMap = new Map(tools.map((t) => [t.name, t]));

      // **只读工具这道关**（规格 §8.1 的「没有闸门时」的语义）：
      // 循环里没有闸门时，只放行 risk 为 READ 的工具，其余一律被拒，
      // 模型收到的是「需要用户确认，但审批功能还没上线」——
      // 用户只看到一句莫名其妙的话。
      //
      // 交互层**没有审批渠道**，所以它的工具必须全是只读的。
      // 与其等到运行时被静默拒掉，不如在**接线时**当场报错：
      // 错在哪（哪个工具）一目了然。
      for (const tool of tools) {
        if (tool?.risk !== TOOL_RISK.READ) {
          throw new Error(
            `交互层的工具「${tool?.name || '（无名）'}」不是只读的（risk=${tool?.risk || '未声明'}）：` +
              '没有审批渠道时它会被直接拒掉，请换一个只读工具。'
          );
        }
      }

      // **要藏起来的名字**：这一轮能调的工具，加上注册表里全部工具。
      // 模型偶尔会自己蹦出一个工具名，用户不该看见。
      const toolNames = [
        ...tools.map((t) => t?.name),
        ...(registry?.list?.() || []).map((t) => t?.name),
      ].filter(Boolean);

      const plugins = getPlugins() || [];
      const system = buildInteractionPrompt({
        persona: getPersona(),
        facts: getFacts(),
        now: getNow(),
        taskStates: getTaskStates() || [],
        pluginNames: plugins.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean),
        dispatchEnabled,
      });

      // **流式正文与元数据要分开**：模型会在正文后面接一段 <<META>> 的 JSON，
      // 那段不能显示在气泡里。
      const splitter = createStreamSplitter();
      // **第二道防线**：提示词让模型别把内部话术说出来，这里兜底。
      const speech = createSpeechFilter({ toolNames });
      const callModel = createModelCaller({ fetchImpl, minMaxTokens: INTERACTION_MIN_MAX_TOKENS });

      // **META 的两级来源**：模型调工具时常会顺带说一句「好的，我这就去」，
      // 那句的 META 在**那一轮的正文**里，不在最终答复里。
      let roundMeta = null;

      const loop = createAgentLoop({
        callModel: (params) => callModel(params, config),
        resolveTool: (name) => toolMap.get(name) || null,
        // **不设闸门**：交互层没有审批渠道，循环里没有闸门时只放行只读工具，
        // 其余一律被拒（上面那道检查就是为了不让它发生）。
        gate: null,
        maxSteps: getMaxSteps(),
        // 步数用尽时不做总结那一轮：交互层要的是秒级回应。
        summarize: false,
        // **工具直接给出答复**：模型把要跟用户说的话写在 `reply` 里，
        // 工具跑完直接用它回复——派单只花一次模型往返（规格 §4.2）。
        answerFromTool: true,
        // **这一回合的过程要写下来**（聊天历史页要显示）：
        // 模型说了什么（model 记录）。调了哪几个动作由 taskTools 自己记成派单记录。
        onRound: (round) => {
          const text = String(round?.text || '').trim();
          if (!text) return;
          if (text.includes(META_MARKER)) roundMeta = parseReply(text);
          // **META 那段不记**：它是给主进程看的，聊天记录页给用户看。
          const visible = text.split(META_MARKER)[0].trim();
          if (!visible) return;
          appendRecord(modelRecord({ index: round?.index, text: visible, model: String(config.model || '') }));
        },
        logger,
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
            if (!out) return;
            const safe = speech.push(out);
            if (safe) onDelta?.(safe);
          },
        });
      } catch (err) {
        // 「模型不支持工具调用」在这里被翻译成人话（规格 §10.4）。
        throw translateError(err, tools.length > 0);
      }

      const tail = splitter.finish();
      if (tail) {
        const safe = speech.push(tail);
        if (safe) onDelta?.(safe);
      }
      const tailSafe = speech.finish();
      if (tailSafe) onDelta?.(tailSafe);

      const parsed = parseReply(run.text || '');
      const raw =
        parsed.text ||
        (await rescueWithoutAnswer({
          run,
          tools,
          dispatched,
          dispatchEnabled,
          turn,
          trigger,
        }));
      return {
        // **答复也过一遍过滤器**：提示词是第一道防线，这里是第二道。
        text: sanitizeSpeech(raw, { toolNames }),
        emotion: parsed.emotion !== 'neutral' ? parsed.emotion : roundMeta?.emotion || parsed.emotion,
        mood: parsed.mood || roundMeta?.mood || 0,
        memories: parsed.memories?.length ? parsed.memories : roundMeta?.memories || [],
        baseUrl: run.baseUrl,
        steps: run.steps,
        outcome: run.outcome,
      };
    },
  };
}
