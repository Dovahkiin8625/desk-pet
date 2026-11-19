import { LlmError, LLM_ERRORS } from '../llm/openai.js';
import { createStreamSplitter, parseReply, META_MARKER } from './prompt.js';
import { buildAgentSystemPrompt } from '../agent/prompt.js';
import { AGENT_OUTCOME, createAgentLoop, safeConvo } from '../agent/loop.js';
import { DEFAULT_AGENT } from '../../../shared/assistant.js';
import { createModelCaller } from './caller.js';
import { createSpeechFilter, sanitizeSpeech } from '../layer/speech.js';
import { promisesAction } from '../layer/promise.js';

/**
 * 前台一轮最多走几步。
 *
 * **为什么是上限而不是预算**：模型不调工具就一步结束，
 * 所以这个数只罚「连着调工具」的请求——普通闲聊不会多花一次往返。
 *
 * 三步够：一步查、一步做、一步答。
 */
export const FOREGROUND_MAX_STEPS = 3;

/**
 * 说了要做却没动手时的追加提醒。
 *
 * **同一句话模型大约五次漏一次**（提示词里已经反复强调了）。
 * 漏了的后果很糟：用户以为桌宠在忙，其实什么都没发生。
 * 所以这里再兜一层：说了要做，就得真的动手。
 */
const NUDGE = '\n（上一轮你只是说要做，却没有真的动手。现在就用工具去做。）';

/**
 * agent 模式：**唯一的后端**。
 *
 * ## 为什么只有一份
 *
 * 以前有两份后端：交互层那份（只说话，两步）与执行层那份（干活，二十步）。
 * 分成两份的代价：
 * - 两套提示词，同一件事在两个地方是两种做法；
 * - 前台没有工具，任何需要一点数据的事都得派单——慢；
 * - 派单要把请求压成一段说明交给后台——有损，而且没人发现派歪了。
 *
 * 现在合成一份：**同一个 agent 在前台与后台跑**。
 * 前台有全部工具（改动类操作走审批气泡，用户点一下），
 * 后台是同一个 agent 的**延续**（带着同一段对话继续，不重写一遍）。
 *
 * ## 前台与后台的差别只有三处
 *
 * 1. 步数上限（前台少，后台多）；
 * 2. 步数用尽时是**总结**还是**交给后台继续**；
 * 3. 工具要不要带一句给用户的话（前台要，后台不要——后台的结论要喂回模型）。
 *
 * @param {object} options
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.getTools] 工具表（注册表）
 * @param {Function} [options.getSkills] 技能清单
 * @param {Function} [options.getPlugins] 能打开界面的插件（名字）
 * @param {Function} [options.getGate] 审批闸门
 * @param {Function} [options.getWorkspace]
 * @param {Function} [options.getPolicy]
 * @param {Function} [options.getAllowAlways]
 * @param {Function} [options.getMaxSteps]
 * @param {Function} [options.getPersona]
 * @param {Function} [options.getFacts]
 * @param {Function} [options.getSnapshot] 此刻正在发生的事
 * @param {Function} [options.getTaskStates] 手头在做的事
 * @param {Function} [options.getClips] 形象有哪些 clip（id + label + 分类）
 * @param {Function} [options.getNow]
 * @param {object} [options.logger]
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
  /**
   * 能打开界面的插件（名字）：提示词里要列出来，
   * 模型才知道「系统状态」这样的界面自己能开。
   */
  getPlugins = () => [],
  /** 审批闸门（没给就用这个全局的）。 */
  getGate = () => null,
  getWorkspace = () => '',
  getPolicy = () => DEFAULT_AGENT.approval.policy,
  getAllowAlways = () => [],
  getMaxSteps = () => DEFAULT_AGENT.maxSteps,
  getPersona = () => ({}),
  getFacts = () => [],
  getSnapshot = () => [],
  getTaskStates = () => [],
  getClips = () => [],
  getNow = () => new Date(),
  /** 日志器（工具出错时留一行）。 */
  logger = null,
} = {}) {
  return {
    id: 'agent',
    label: 'agent 模式',

    async chat(ctx) {
      const {
        messages = [],
        config = {},
        onDelta,
        onEvent,
        onRound,
        signal,
        steer,
        taskId = '',
        /** 这一轮是谁发起的（'user' | 'proactive' | 'ambient' | 'task'…）：自发反应整轮可以不说话。 */
        trigger = '',
        /**
         * 这一轮**多带**的工具（前台的任务工具）。
         *
         * 与注册表里的工具**合并**，不是替换：
         * 前台也得能用那些真工具（查状态、读文件），只是多几个
         * 「把这件事交出去」「取消一件事」这类管事的。
         *
         * 可以是函数：拿到当前对话（交出去的时候要的就是它）。
         */
        tools: extraTools = null,
        /**
         * 要不要带上注册表里的那些真工具。
         *
         * 「只聊天」模式关掉它：桌宠不查本机、不翻文件、不跑命令。
         */
        includeRegistryTools = true,
        /** 这一轮最多走几步（前台少，后台多）。 */
        maxSteps = null,
        /** 做完的标准（开工前定下的）。 */
        criteria = '',
        /** 能不能把这件事交给后台继续做。 */
        canEscalate = false,
        /**
         * 交给后台继续做的那个动作。
         *
         * @param {object} payload {convo, tools}
         * @returns {Promise<{ok: boolean, taskId?: string, answer?: string}>}
         */
        escalate = null,
        /** 步数用尽时要不要让模型总结一次（后台要，前台不要——前台要交出去）。 */
        summarize = true,
        /** 工具自己带回的答复算不算这一轮的最终答复（前台要，后台不要）。 */
        answerFromTool = false,
      } = ctx;

      // 闸门是**每个任务一个**（「自动」是任务级的），
      // 所以由调用方按任务给；没给就用全局那个。
      const gate = ctx.gate ?? getGate();
      // 运行时的挂起接口：给要等用户回话的工具用
      // （等答复的时候把并发槽让出去）。
      const hooks = ctx.hooks ?? null;
      const registry = getTools();
      const registryTools = registry && typeof registry.list === 'function' ? registry.list() : [];
      // 当前的对话：工具可能要在这一刻把这件事交出去继续做。
      let currentConvo = Array.isArray(messages) ? messages.slice() : [];
      // **这一轮的工具**：注册表里的全部工具，**加上**这一轮多带的。
      //
      // 前台多带的是任务工具（交出去继续做、取消…），
      // 但前台并不因此失去那些真工具——前台照样能查、能改。
      //
      // 传函数的话，它拿到的是「当前这段对话」——
      // 交出去的时候要的就是它（带着对话继续，不是重写一遍）。
      const extras =
        extraTools === null || extraTools === undefined
          ? []
          : typeof extraTools === 'function'
            ? extraTools(() => currentConvo)
            : extraTools;
      const tools = [
        ...(includeRegistryTools ? registryTools : []),
        ...(extras || []),
      ];
      // **这一轮有没有把活儿交出去过**：交出去了就不该再交一次。
      //
      // 靠工具自己声明（`handsOver`）——只有「把这件事交出去继续做」
      // 那个工具算，别人不算。
      let handedOver = false;
      const toolMap = new Map(
        tools.map((t) => {
          if (!t?.handsOver || typeof t.run !== 'function') return [t?.name, t];
          const wrapped = {
            ...t,
            run: async (args, toolCtx) => {
              const out = await t.run(args, toolCtx);
              handedOver = true;
              return out;
            },
          };
          return [t.name, wrapped];
        })
      );

      const system = buildAgentSystemPrompt({
        persona: getPersona(),
        facts: getFacts(),
        tools,
        skills: getSkills(),
        plugins: getPlugins(),
        workspace: getWorkspace(),
        approval: { policy: getPolicy(), allowAlways: getAllowAlways() },
        snapshot: getSnapshot(),
        taskStates: getTaskStates(),
        clips: getClips(),
        criteria,
        canEscalate,
        now: getNow(),
      });

      // **流式正文与元数据要分开**：模型会在正文后面接一段 <<META>> 的 JSON，
      // 那段不能显示在气泡里。
      const splitter = createStreamSplitter();

      const callModel = createModelCaller({
        fetchImpl,
        minMaxTokens: AGENT_MIN_MAX_TOKENS,
      });

      // **要藏起来的名字**：这一轮能调的工具，加上注册表里全部工具。
      // 模型偶尔会自己蹦出一个工具名，用户不该看见。
      const toolNames = [
        ...(tools || []).map((t) => t?.name),
        ...registryTools.map((t) => t?.name),
      ].filter(Boolean);
      const speech = createSpeechFilter({ toolNames });

      const loop = createAgentLoop({
        callModel: (params) => callModel(params, config),
        resolveTool: (name) => toolMap.get(name) || registry?.get?.(name) || null,
        gate,
        hooks,
        maxSteps: Number(maxSteps) > 0 ? Number(maxSteps) : getMaxSteps(),
        onEvent,
        onRound,
        logger,
        summarize,
        answerFromTool,
        steer: typeof steer === 'function' ? steer : null,
        onState: ({ convo }) => {
          currentConvo = convo;
        },
      });

      /** 跑一轮循环。 */
      async function runOnce(systemText) {
        return loop.run({
          system: systemText,
          messages,
          tools,
          signal,
          taskId,
          onDelta: (delta) => {
            const out = splitter.push(delta);
            if (!out) return;
            const safe = speech.push(out);
            if (safe) onDelta?.(safe);
          },
        });
      }

      let run;
      try {
        run = await runOnce(system);
      } catch (err) {
        throw translateError(err, (tools || []).length > 0);
      }

      // **说了要做，却一个工具都没调**：再来一轮，逼它动手。
      //
      // 只有「模型给出了答复但没动手」才重来：
      // 用户看到一句「我去查一下」却什么都没发生，是最伤信任的一种失败。
      // 只重来一次——再失败就交出去（下面那段）。
      if (
        run.outcome === AGENT_OUTCOME.DONE &&
        run.toolCalls === 0 &&
        tools?.length &&
        promisesAction(run.text)
      ) {
        try {
          const again = await runOnce(`${system}${NUDGE}`);
          if (again.text) run = again;
        } catch {
          // 重来失败就用原来那轮：有个答复总比没有强。
        }
      }

      // 流结束了：把尾巴也吐出来。
      const tail = splitter.finish();
      if (tail) {
        const safe = speech.push(tail);
        if (safe) onDelta?.(safe);
      }
      const tailSafe = speech.finish();
      if (tailSafe) onDelta?.(tailSafe);

      // **前台预算用尽 → 交给后台继续做**。
      //
      // 交出去的是**这段对话**：用户说的原话、已经查到的结果都在里面，
      // 后台接着干，一个字都不用重写。
      //
      // 另一种也交出去：**说了要做却还是没动手**——
      // 前台已经提醒过它一次了，再拖下去只是让用户干等。
      //
      // **已经交出去过的不再交**：那是派两遍，后台会做同一件事两回。
      const outOfBudget = !run.text && run.outcome === AGENT_OUTCOME.MAX_STEPS;
      const promisedOnly =
        run.outcome === AGENT_OUTCOME.DONE && run.toolCalls === 0 && promisesAction(run.text);
      if (escalate && canEscalate && !handedOver && (outOfBudget || promisedOnly)) {
        const handed = await escalate({
          // **要能直接发出去的那份**：交出去的时候对话可能停在
          // 「assistant 说了要调工具、结果还没写回来」的半截上，
          // 那样发出去接口会直接 400。
          convo: safeConvo(run.convo || currentConvo),
          tools,
        });
        if (handed?.ok) {
          return {
            text: String(handed.answer || '').trim() || '这个要多花点时间，我接着做，做完告诉你。',
            emotion: 'neutral',
            mood: 0,
            action: '',
            memories: [],
            baseUrl: run.baseUrl,
            steps: run.steps,
            outcome: run.outcome,
            escalated: true,
            taskId: String(handed.taskId || ''),
          };
        }
      }

      const parsed = parseReply(run.text || '');
      // 调试开关：`DESK_PET_DEBUG_META=1 npm start` 时，每一轮都把模型原始
      // 输出的 <<META>> 段和解析结果打到终端——排查「agent 决定了还是没决定」用。
      if (process.env.DESK_PET_DEBUG_META) {
        const markerAt = String(run.text || '').indexOf(META_MARKER);
        console.log(
          '[desk-pet] META 原文：',
          markerAt >= 0 ? String(run.text).slice(markerAt) : '（这一轮没输出 <<META>>）'
        );
        console.log(
          '[desk-pet] META 解析：',
          JSON.stringify({ emotion: parsed.emotion, mood: parsed.mood, action: parsed.action, memories: parsed.memories.length })
        );
      }
      // 自发反应整轮没说一句话：模型是**故意**留空的（提示词里允许），
      // 不是失败——回退文案（「我没能完成这件事。」）在这条路上会乱说话。
      const intentionallySilent = trigger === 'ambient' && run.outcome === AGENT_OUTCOME.DONE;
      const text = parsed.text || (intentionallySilent ? '' : fallbackText(run));

      return {
        // **答复也过一遍过滤器**：提示词是第一道防线，这里是第二道。
        text: sanitizeSpeech(text, { toolNames }),
        emotion: parsed.emotion,
        mood: parsed.mood,
        action: parsed.action || '',
        memories: parsed.memories,
        baseUrl: run.baseUrl,
        steps: run.steps,
        outcome: run.outcome,
        escalated: false,
      };
    },
  };
}

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
