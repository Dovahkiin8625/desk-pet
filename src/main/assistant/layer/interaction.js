import { createAgentLoop, AGENT_OUTCOME } from '../agent/loop.js';
import { modelRecord, stepRecord } from '../agent/record.js';
import { createModelCaller } from '../chat/caller.js';
import { createStreamSplitter, parseReply } from '../chat/prompt.js';
import { fallbackText, translateError } from '../chat/agent.js';
import { createFastToolSet } from './fastTools.js';
import { createCapabilityTool } from './capabilityTool.js';
import { buildInteractionPrompt } from './prompt.js';
import { LAYER, TOOL_RISK } from '../../../shared/assistant.js';

/**
 * 交互层后端（规格 §3、§4）。
 *
 * ## 它是唯一跟用户说话的那一层
 *
 * 执行层只产出结果，不说话。交互层负责：
 * - 秒级回应（最多 3 步、快工具整轮 1 次）；
 * - 判断该不该派单；
 * - 管后台任务（派单 / 查看 / 停止 / 归档 / 追加指令）。
 *
 * ## 为什么复用 agent 循环
 *
 * 循环那套「每个 tool_call 都要配一条 tool 消息」「工具出错喂回模型」
 * 的规矩，交互层一个字都不能改（改了模型就会开始说胡话）。
 * 所以直接用 `createAgentLoop`，只换提示词、工具与步数上限。
 */

/** 交互层一轮最多走几步。 */
export const INTERACTION_MAX_STEPS = 3;

/**
 * 造一个交互层后端。
 *
 * @param {object} options
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.getRegistry] 工具表（取快工具）
 * @param {Function} [options.getSkills] 技能清单（能力清单工具用）
 * @param {Function} [options.getPlugins] 插件清单（能力清单工具与提示词用）
 * @param {Function} [options.getTaskTools] (turn) => 任务管理工具数组
 * @param {Function} [options.getDispatchEnabled] 能不能派单
 * @param {Function} [options.getPersona]
 * @param {Function} [options.getFacts]
 * @param {Function} [options.getNow]
 * @param {Function} [options.getTaskCounts] () => {running, queued}
 * @param {Function} [options.getMaxSteps] () => 步数上限
 * @param {Function} [options.appendRecord] 写一条分类记录（聊天历史页要显示这一回合的过程）
 */
export function createInteractionBackend({
  fetchImpl = fetch,
  getRegistry = () => null,
  getSkills = () => [],
  getPlugins = () => [],
  getTaskTools = () => [],
  getDispatchEnabled = () => true,
  getPersona = () => ({}),
  getFacts = () => [],
  getNow = () => new Date(),
  getTaskCounts = () => ({ running: 0, queued: 0 }),
  getMaxSteps = () => INTERACTION_MAX_STEPS,
  appendRecord = () => {},
  logger = null,
} = {}) {
  /**
   * 这一轮没答上来时的兜底。
   *
   * **不能把模型的窝囊甩给用户**：一句「我没能在这 3 步之内做完这件事」，
   * 用户既不知道发生了什么，也不知道下一步该干什么。
   *
   * 这里按交互层的分派规则来：一次调工具搞不定的事**统统派后台任务**，
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
    try {
      await submit.run({
        title: userText.length > 20 ? `${userText.slice(0, 20)}…` : userText,
        // 派单说明限长 200 字（工具自己会拦），截在这里；
        // 用户原话由 task.submit 原样传给后台任务，不会丢。
        brief: `用户的请求：${userText.slice(0, 190)}`,
      });
    } catch {
      return '这件事我没能在这儿办起来。';
    }
    return '我去查一下，结果出来告诉你。';
  }

  return {
    id: 'interaction',
    label: '交互层',

    async chat(ctx) {
      const { messages = [], config = {}, onDelta, turn = {}, signal = null } = ctx || {};
      const trigger = String(ctx?.trigger || 'user');
      const registry = getRegistry();
      const dispatchEnabled = Boolean(getDispatchEnabled());

      // **每轮新建**：快工具的配额是「每轮一次」，计数器必须每轮归零。
      const fastTools = createFastToolSet({ registry, now: getNow });
      // 能力清单工具：答「你有哪些插件/技能/工具」时用。
      // 它**不受快工具配额限制**——查清单不该把「读一个文件」的机会顶掉。
      const capabilityTools = createCapabilityTool({
        getSkills,
        getPlugins,
        getTools: () => registry?.list?.() || [],
      });
      // 关了派单就**不把任务管理工具给模型**：
      // 给了它就会去调，然后被拒——白白浪费一轮。
      const taskTools = dispatchEnabled ? getTaskTools(turn) : [];
      // **这一轮有没有派过单**：模型自己派了，就别再替它派一次。
      let dispatched = false;
      const tools = [
        ...fastTools,
        ...capabilityTools,
        ...taskTools.map((t) =>
          t.name === 'task.submit'
            ? {
                ...t,
                run: async (args, toolCtx) => {
                  const out = await t.run(args, toolCtx);
                  dispatched = true;
                  return out;
                },
              }
            : t
        ),
      ];
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

      const counts = getTaskCounts() || {};
      const plugins = getPlugins() || [];
      const system = buildInteractionPrompt({
        persona: getPersona(),
        facts: getFacts(),
        now: getNow(),
        runningCount: counts.running || 0,
        queuedCount: counts.queued || 0,
        dispatchEnabled,
        // 报**这一轮实际可用**的快工具：注册表里没有的就不报，
        // 否则模型会去调一个不存在的工具，白烧一步。
        fastToolNames: fastTools.map((t) => t.name),
        // 插件名写进提示词：模型据此知道「这类问题有路可走」，
        // 完整清单由 capability.list 给。
        pluginNames: plugins.map((p) => p?.name).filter(Boolean),
      });

      // **流式正文与元数据要分开**：模型会在正文后面接一段 <<META>> 的 JSON，
      // 那段不能显示在气泡里。
      const splitter = createStreamSplitter();
      const callModel = createModelCaller({ fetchImpl });

      const loop = createAgentLoop({
        callModel: (params) => callModel(params, config),
        resolveTool: (name) => toolMap.get(name) || null,
        // **不设闸门**：交互层没有审批渠道，循环里没有闸门时只放行只读工具，
        // 其余一律被拒（上面那道检查就是为了不让它发生）。
        gate: null,
        maxSteps: getMaxSteps(),
        // 步数用尽时不做总结那一轮：交互层要的是秒级回应。
        summarize: false,
        // **这一回合的过程要写下来**（聊天历史页要显示）：
        // 模型说了什么（model 记录）、调了什么快工具（step 记录）。
        onRound: (round) => {
          // **只记有正文的轮**：工具调用轮模型通常不说话（它只给 tool_calls），
          // 那种轮由 step / dispatch 记录表达——再记一条空记录，页面上就是一行空白。
          const text = String(round?.text || '').trim();
          if (!text) return;
          appendRecord(modelRecord({ index: round?.index, text, model: String(config.model || '') }));
        },
        onEvent: (event) => {
          if (event?.type !== 'step') return;
          // **任务管理工具不记 step**：它们已经由 taskTools 记成派单记录了，
          // 再记一份，页面上会出现两行说同一件事的话。
          const tool = String(event.tool || '');
          if (!tool || tool.startsWith('task.')) return;
          appendRecord(
            stepRecord({
              taskId: '',
              index: event.index,
              tool,
              args: event.args || null,
              result: event.result || '',
              error: event.error || '',
              layer: LAYER.INTERACTION,
            })
          );
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
            if (out) onDelta?.(out);
          },
        });
      } catch (err) {
        // 「模型不支持工具调用」在这里被翻译成人话（规格 §10.4）。
        throw translateError(err, tools.length > 0);
      }

      const tail = splitter.finish();
      if (tail) onDelta?.(tail);

      const parsed = parseReply(run.text || '');
      const text =
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
