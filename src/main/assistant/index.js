import { powerMonitor } from 'electron';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  MESSAGE_KIND,
  POMODORO_PRESETS,
  TTS_HOSTS,
  LLM_BASE_URLS,
  DEFAULT_AGENT,
  TASK_STATUS,
  LAYER,
  APPROVAL_DECISION,
  chatKindOf,
  DEFAULT_AMBIENT_INTERVAL_MS,
} from '../../shared/assistant.js';
import { loadAssistant, saveAssistant, mergeAssistantPatch, sanitizeAssistant } from './state.js';
import { loadApiKey, loadLlmApiKey } from '../credentials.js';
import * as clock from './clock.js';
import * as todos from './todos.js';
import * as reminders from './reminders.js';
import * as pomodoro from './pomodoro.js';
import * as systemStatus from './systemStatus.js';
import { buildSnapshotLines } from './snapshot.js';
import * as gpu from './gpu.js';
import * as network from './network.js';
import * as weather from './weather.js';
import * as weatherFx from '../../shared/weatherEffect.js';
import { weatherIconName } from '../../shared/weatherIcon.js';
import { createClipboardWatcher, truncateClipboard } from './clipboard.js';
import { synthesizeCached } from './tts/minimax.js';
import { createTapTalk } from './tapTalk.js';
import { tapTalkNeedsPrewarm } from '../../shared/tapVoice.js';
import { createBackendRegistry } from './chat/backend.js';
import { createPlainBackend } from './chat/plain.js';
import { createAgentBackend, FOREGROUND_MAX_STEPS } from './chat/agent.js';
import { createAck, ACK_HOLD_MS } from './chat/ack.js';
import { createReplyBubble } from './chat/stream.js';
import { createToolRegistry } from './agent/tools/registry.js';
import { createBuiltinTools, killProcessTree } from './agent/tools/builtin.js';
import { createAskTools } from './agent/tools/ask.js';
import { createTaskTools } from './agent/tools/tasks.js';
import { safeConvo } from './agent/loop.js';
import { createSkillRegistry, createSkillTools } from './agent/skills.js';
import { createHarnessRunner } from './agent/harness.js';
import { createAgentFacade } from './agent/facade.js';
import { createAgentTasks } from './agent/tasks.js';
import { createApprovalGate, describeToolCall } from './agent/approval.js';
import { buildResult, isNotable, resultLine, userReason } from './agent/result.js';
import {
  approvalRecord,
  dispatchRecord,
  interruptedTasks,
  modelRecord,
  stepRecord,
  taskRecord,
} from './agent/record.js';
import { runForeground, FALLBACK_NOTICE } from './layer/foreground.js';
import { buildSystemPrompt, buildChatMessages } from './chat/prompt.js';
import { mergeFacts, pickMemories } from './chat/memory.js';
import { createRecordSink } from './chat/recordSink.js';

/**
 * 桌面助理的总控。
 *
 * 主进程是**唯一的时间与状态来源**：定时器、剪贴板、屏幕 API 都在这边，
 * 渲染层只负责「表演」（表情、动作、口型）。
 * 这么做有个直接的好处：桌宠窗口被隐藏时，提醒照样会响。
 *
 * 定时器只有一个（每秒一跳），不搞一堆 setTimeout：
 * 多定时器意味着「状态变了要重新武装每一个」，
 * 漏掉一个就会留下一个再也不响的提醒——而那种 bug 极难发现。
 */

/** 主循环的间隔。 */
const TICK_MS = 1000;

/** 天气刷新的间隔：半小时一次够了。 */
const WEATHER_REFRESH_MS = 30 * 60 * 1000;

/** 热状态检查的间隔。 */
const THERMAL_CHECK_MS = 60 * 1000;

/** 问候语的延迟：等模型加载完再说。 */
const GREETING_DELAY_MS = 3000;

/** 桌宠被隐藏时最多排几条消息。 */
const MAX_PENDING_MESSAGES = 5;

/** 主动搭话：用户至少这么久没说话，才插嘴。 */
const PROACTIVE_IDLE_MS = 5 * 60 * 1000;

/** 自发反应：用户刚说过话这么久之内不插手（不抢对话）。 */
const AMBIENT_IDLE_MS = 90 * 1000;

/** 主动搭话：启动后多久之内不搭话（刚开机就搭话很怪）。 */
const PROACTIVE_STARTUP_DELAY_MS = 10 * 60 * 1000;

/** 主动搭话：连续失败后的退避上限。 */
const PROACTIVE_BACKOFF_MAX_MS = 6 * 3600 * 1000;

/** 台词语音预生成的防抖（毫秒）。 */
const PREWARM_DEBOUNCE_MS = 800;

/** 深夜不搭话：[开始小时, 结束小时)。 */
const QUIET_HOURS = [23, 8];

/**
 * 语音播完的最长等待（毫秒）。
 *
 * 渲染层播完会回报一个 id；回报不来（窗口没了、解码失败）就到这里为止，
 * 免得界面一直等下去。
 */
const SPEECH_WAIT_TIMEOUT_MS = 10000;

/** 等一会儿。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 把一份补丁合并进状态。
 *
 * **必须深一层**：设置窗口送来的 `tts` 只有
 * `{enabled, voiceId, speed}` 三个字段，
 * 浅合并会把 `model`/`vol`/`pitch`/`host` 一并抹掉——
 * 其中 `host` 是探测出来的可用域名，抹掉就得重新探测一遍。
 */
export function createAssistant({  userDataDir,
  rootDir,
  bubble,
  onEmotion,
  onSpeak,
  onSound,
  isPetVisible,
  fetchImpl = fetch,
  /**
   * 本机程序索引（`app.launch` 工具要用）。
   *
   * **注入的是取值函数而不是索引本身**：程序索引在主进程里比助理晚一步建好
   * （它要扫盘），这里晚一点拿到也没关系——
   * 传索引本身的话，建好之前那个引用会是空的。
   */
  getAppIndex = null,
  /**
   * 已启用的插件清单（能力清单工具与提示词用）。
   *
   * **注入的是取值函数**：插件宿主比助理晚一步建好，
   * 这里晚一点拿到也没关系。
   */
  getPlugins = null,
  /**
   * 把一次天气特效推给渲染层（偶尔随机 / 插件里点预览）。
   *
   * 助理只负责「决定播什么时候播」，怎么演是渲染层的事。
   */
  onWeatherEffect = null,
  /**
   * 天气插件的「桌宠天气效果」配置（{ effectEnabled, effect }）。
   *
   * **注入的是取值函数**：插件宿主比助理晚一步建好。
   * 没开 / 拿不到时当成没开这个功能。
   */
  getWeatherEffectConfig = null,
  /**
   * 形象有哪些 clip（id + label + 分类）：提示词「你能做出的动作」按它列。
   *
   * **注入的是取值函数**：渲染层上报上来，助理建好之后才有——
   * 传函数就不用管创建顺序。
   */
  getClips = null,
  /**
   * 插件上报的状态行（「音乐播放器：在听：《…》」这种），
   * 合并进「此刻正在发生的事」。同样是取值函数。
   */
  getPluginStatus = null,
}) {
  let state = null;
  // 桌宠被隐藏时排队的消息（最多 5 条）。
  const pendingMessages = [];
  let tickTimer = null;
  let greetingTimer = null;
  let saveTimer = null;
  let pendingWrite = null;
  // 台词语音预生成的防抖计时器。
  let prewarmTimer = null;

  // 上一次报时的分钟键：整点那一分钟只报一次。
  let lastChimeKey = '';
  // 上一次检查热状态/天气的时间。
  let lastThermalCheck = 0;
  let lastWeatherCheck = 0;
  // 天气特效：上一次掷骰子的时刻，与上一次真的播出去的时刻。
  // 后者从启动时记起——刚开机不该立刻来一阵。
  let lastFxCheck = 0;
  let lastFxAt = Date.now();
  // 上次说「我好热」的时间：别每分钟喊一次。
  let lastHotAlertAt = 0;
  // 应用启动的时刻：主动搭话要等一段时间才开口。
  const appStartedAt = Date.now();
  // 用户最后一次说话的时刻：刚说完话就别插嘴。
  let lastUserMessageAt = 0;
  // 自发反应：上一次看四周的时刻，以及有没有正在进行的一次。
  let lastAmbientAt = 0;
  let ambientInFlight = false;
  // 正在进行的对话轮次序号：只有最后一次允许写进历史。
  let chatSeq = 0;
  // 有对话正在进行吗：主动搭话要避开。
  let chatBusy = false;
  // **等着说的完成通知**：前台这一轮还没说完时，后台任务做完了，
  // 通知先攒在这儿（见 notify 的注释）。
  const pendingNotices = [];
  // 语音序号：发出去时带上 id，渲染层播完回报同一个 id。
  let speechSeq = 0;
  // 等着「播完了」回报的语音。
  const pendingSpeech = new Map();
  // **不认 think 参数的模型**：同一个模型再问一次时就不发那些参数了，
  // 免得每轮都先撞一次 400。
  const thinkUnsupportedModels = new Set();
  // 这一轮是不是已经告诉过用户「这个模型不支持 think」了：
  // 告诉过了就别再应一声——刚说过的话不用再说一遍。
  let thinkNoticeShown = false;
  // 审批请求的序号：每一次审批都要有自己的 id
  // （挂着的审批会排队，答复按 id 认——见 bubbleAsk.js）。
  let approvalSeq = 0;
  // 选择卡的序号：每一次问用户都要有自己的 id（同一个道理）。
  let askSeq = 0;

  // 对话后端注册表。
  //
  // **前台恒定走 agent 后端**（下面注册）：
  // 普通对话（'chat'）不再是一个「前台后端」，它只是
  // 「模型不支持工具调用」时的退路（见 layer/foreground.js）。
  const backends = createBackendRegistry();
  backends.register('chat', createPlainBackend({ fetchImpl }));

  const clipboardWatcher = createClipboardWatcher({
    onText: (text) => {
      const preview = truncateClipboard(text);
      say(`你复制了：${preview}`, { emotion: 'neutral', sound: 'tap' });
    },
  });

  // ------------------------------------------------------------------
  // agent 的工具表
  //
  // **内置工具先注册，插件后注册**——注册表同名先到先得，
  // 所以插件抢不走 `shell.exec` 这类内置名字。
  //
  // 工具要用的东西（工作区、超时、剪贴板、程序索引）全是**取值函数**：
  // 状态是异步加载的，工具被创建时那些值还不存在。
  // ------------------------------------------------------------------
  const toolRegistry = createToolRegistry({
    // 用户永久放行过的工具（规格 §8.1）按它声明的风险算——
    // 插件提供的工具默认按「要确认」算，见注册表里的说明。
    getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
    // 用户关掉的工具（设置页的「工具」页）：不进工具表，模型看不见。
    getDisabled: () => state?.agent?.tools?.disabled || [],
  });
  toolRegistry.registerAll(
    createBuiltinTools({
      getWorkspace: () => state?.agent?.workspace || '',
      getTimeoutMs: () => state?.agent?.timeoutMs || DEFAULT_AGENT.timeoutMs,
      getAppIndex: () => getAppIndex?.() || null,
      // 外部助手（claude code）：日志落在 userData/agent-logs 下。
      harness: createHarnessRunner({
        spawn: nodeSpawn,
        // **杀进程树，不只是杀自己**：Windows 上子进程会留下。
        killTree: (child) => killProcessTree(child, { spawn: nodeSpawn }),
        logDir: join(userDataDir, 'agent-logs'),
      }),
      // 审批档位决定外部助手的权限模式（headless 里没人能回答它的提问）。
      getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
    })
  );

  // ------------------------------------------------------------------
  // agent 的技能表
  //
  // 技能是**插件怎么用的说明书**（渐进式披露）：
  // 提示词里只有「名字：说明」一行，正文等模型要用了再读。
  // ------------------------------------------------------------------
  const skillRegistry = createSkillRegistry({ logger: console });
  // 读技能正文的工具：内置的，所有技能共用一个。
  //
  // **它自己也可能被关掉**：关掉之后模型没有读技能的入口，
  // 提示词里就不该再列技能清单（列了模型也读不了）。
  toolRegistry.registerAll(
    createSkillTools({
      registry: skillRegistry,
      getDisabledTools: () =>
        (state?.agent?.tools?.disabled || []).map((name) => ({ name })),
    })
  );

  // ------------------------------------------------------------------
  // 「问用户」这个工具
  //
  // 拿不准的时候问一句：气泡里弹一张选择卡，
  // 用户点一个，就知道该往哪边走了。
  //
  // 前台与后台都有这个工具——它只有一个例外：
  // 前台拿不准时多半是把事交出去，而不是问用户。
  // ------------------------------------------------------------------
  toolRegistry.registerAll(
    createAskTools({
      ask: ({ question, options, taskId }) =>
        bubble.showChoice({
          id: `${taskId || 'task'}-ask-${++askSeq}`,
          taskId,
          title: '要你定一下',
          question,
          options,
        }),
    })
  );

  // ------------------------------------------------------------------
  // agent 后端：多步循环，会调工具。
  //
  // 状态是异步加载的（start() 之后才有），所以这里全是**取值函数**。
  // ------------------------------------------------------------------
  const agentBackend = createAgentBackend({
    fetchImpl,
    getTools: () => toolRegistry,
    // 技能清单进系统提示词（只有名字与说明，正文按需读）。
    //
    // **`skill.read` 被关掉时就不列技能**：模型没有读正文的入口，
    // 列了也只是让它去调一个调不通的工具。
    getSkills: () => (toolRegistry.get('skill.read') ? skillRegistry.list() : []),
    // 能打开界面的插件：模型要知道「系统状态」这样的界面自己能开。
    // 只要名字——提示词里要的是「这类界面有哪些」，不是整条插件记录。
    getPlugins: () =>
      (getPlugins?.() || [])
        .filter((p) => p && p.enabled !== false)
        .map((p) => String(p.name || ''))
        .filter(Boolean),
    getGate: () => null,
    getWorkspace: () => state?.agent?.workspace || '',
    getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
    getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
    getMaxSteps: () => state?.agent?.maxSteps || DEFAULT_AGENT.maxSteps,
    getPersona: () => state?.llm?.persona || {},
    getFacts: () => state?.chat?.facts || [],
    // **此刻正在发生的事**：每轮现采一次。
    getSnapshot: () => snapshotLines(),
    // **手头在做的事**：用户问「那个怎么样了」时，模型看一眼就能答。
    getTaskStates: () => agentTasks.list(),
    // **形象有哪些 clip**：模型想做哪个动作，就在 <<META>> 里点名编号。
    getClips: () => getClips?.() || [],
    // 工具出错时留一行主进程日志（不进气泡）。
    logger: console,
  });

  /**
   * agent 的对外接口：插件通过 `ctx.agent` 用它（规格 §5.5）。
   *
   * 运行时在下面（agentTasks）才建好，所以这里的 runtime 是个**接缝**：
   * 里面的方法转手调中枢，中枢什么时候建好不影响插件调用。
   */
  const agentFacade = createAgentFacade({
    tools: toolRegistry,
    runtime: {
      run: async (prompt, opts) => {
        const task = agentTasks.submit({
          prompt,
          title: opts?.title || '',
        });
        return { ok: true, taskId: task.taskId };
      },
      cancel: async (taskId) => agentTasks.cancel(taskId),
      // 插件的界面要给人看整个过程：看板视图（带步骤时间线）。
      board: () => agentTasks.board(),
      steer: (taskId, note) => agentTasks.steer(taskId, note),
      archive: (taskId) => agentTasks.archive(taskId),
      history: () => chatHistoryView().messages,
    },
    // 待答的审批住在气泡那边（气泡才是给人看的地方）。
    approvals: {
      list: () => bubble.pendingApprovals(),
      answer: (id, decision) => bubble.answerApproval({ id, decision }),
    },
    getHistory: () => chatHistoryView().messages,
  });

  /**
   * 写聊天记录的收口：追加 + 按分类截断 + 通知订阅者。
   *
   * **为什么收口**：「记录什么时候多了一条」只有一个地方知道，
   * 就是写记录的地方。散着写，插件的界面就只能轮询。
   */
  const recordSink = createRecordSink({
    getMessages: () => state.chat.messages,
    setMessages: (messages) => {
      state.chat.messages = messages;
      scheduleSave();
    },
    onEntry: (entry) => agentFacade.emit(entry),
  });

  /**
   * 写一条聊天记录。
   *
   * **所有写入都走它**——写一条就通知一次订阅者，
   * 插件的聊天记录界面要实时更新（规格 §10.2）。
   */
  const appendChatRecord = (entry) => {
    // 状态还没读出来时（启动前）：没地方可写，也不通知。
    if (!state) return null;
    return recordSink(entry);
  };

  // ------------------------------------------------------------------
  // agent 的任务中枢（L3）
  //
  // agent 模式下**每句话都是一个任务**：排队、并发、取消都在运行时里。
  // 审批也是任务级的事——所以闸门由中枢按任务造。
  // ------------------------------------------------------------------
  const agentTasks = createAgentTasks({
    backend: agentBackend,
    // 问用户：审批气泡。挂着的审批可以有好几个（排队），
    // 所以每一次请求都要有自己的 id（inbox 按 id 认，见 bubbleAsk.js）。
    ask: ({ taskId, tool, args, risk }) =>
      bubble.showApproval({
        id: `${taskId}-${++approvalSeq}`,
        taskId,
        title: '需要你点头',
        text: describeToolCall(tool, args),
        risk,
      }),
    getMessages: (prompt) =>
      buildChatMessages({
        history: state?.chat?.messages || [],
        userText: prompt,
        trigger: 'user',
        // **后台看不见派单记录**：它只管自己那件事，
        // 知道用户还派了别的任务反而分心（规格 §6）。
        layer: LAYER.EXECUTION,
      }),
    appendRecord: appendChatRecord,
    notify: ({ title = '', ok = true, summary = '', reason = '', taskId = '', emotion = '', mood = 0, memories = [], action = '' }) => {
      // **送达走模板**：结果先变成一句话（结论或失败原因）——
      // 这句用户看得见，模型下一轮也会读到自己说过的话。
      const result = buildResult({ ok, title, summary, reason, taskId });
      const safe = resultLine(result);
      //
      // **带上任务号**：页面要靠它把结果归回发起它的那一块——
      // 没有它，完成的答复就成了没来由的一句话。
      appendChatRecord({
        role: 'assistant',
        text: safe,
        at: Date.now(),
        proactive: false,
        meta: { taskId: String(taskId || ''), layer: LAYER.EXECUTION, ok: result.ok },
      });
      // **记忆并进长期记忆**：后台任务学到的东西，桌宠自己也该记住。
      const picked = pickMemories(Array.isArray(memories) ? memories : [], { userText: '' });
      if (picked.length) {
        state.chat.facts = mergeFacts(state.chat.facts, picked);
        scheduleSave();
      }
      // **情绪只施加一次**：agent 的 META 情绪优先，没有就用成败推一个。
      const options = {
        emotion: String(emotion || '') || (ok ? 'happy' : 'sad'),
        mood: Number(mood) || 0,
        action: String(action || ''),
        sound: ok ? 'success' : '',
      };
      // **不值得打扰的结果不弹气泡**：做完了但没什么可说的，
      // 只写进记录，桌宠自己知道就行。
      //
      // **值得打扰的结果常驻**：它可能等用户回来才看得到——
      // 六秒就没了的结果，等于没送到。
      const notable = isNotable(result);
      if (chatBusy) {
        pendingNotices.push({
          text: safe,
          options: { ...options, showBubble: notable, speak: notable, sticky: notable },
        });
        return;
      }
      say(safe, { ...options, showBubble: notable, speak: notable, sticky: notable });
    },
    getMaxConcurrent: () => state?.agent?.maxConcurrent || DEFAULT_AGENT.maxConcurrent,
    getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
    getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
    logger: console,
  });

  // ------------------------------------------------------------------
  // **只有一个 agent**：前台与后台跑的是同一个后端。
  //
  // 前台：用户在等，秒级回应，步数少；
  // 后台：耗时的事，步数多，做完了按模板送达。
  //
  // 前台那轮要是发现步数不够用，它会**带着当前这段对话**
  // 交给后台继续做（见 runChat 里的 escalate）——
  // 交出去的是对话本身，不是重写的一段说明。
  // ------------------------------------------------------------------
  backends.register('agent', agentBackend);

  /**
   * 能不能动手（设置里的「桌宠能做什么」）。
   *
   * 读不到就当能：新装的用户什么也没配过，
   * 不该先给他一个残废的桌宠。
   */
  function dispatchEnabled() {
    return (state?.agent?.dispatch || 'auto') === 'auto';
  }

  // ------------------------------------------------------------------
  // 持久化
  // ------------------------------------------------------------------

  /** 改动状态后调用：防抖落盘。 */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void writeNow();
    }, 300);
  }

  /** 真正写一次盘（串行化，避免两次写入重叠时旧内容后落盘）。 */
  function writeNow() {
    const p = (pendingWrite || Promise.resolve())
      .catch(() => {})
      .then(() => saveAssistant(userDataDir, state))
      .catch((err) => {
        // 写失败必须留痕：用户「加了待办却没了」却既没有现象也没有日志。
        console.warn('[desk-pet] assistant.json 保存失败：', err?.message);
      })
      .finally(() => {
        if (pendingWrite === p) pendingWrite = null;
      });
    pendingWrite = p;
    return p;
  }

  /**
   * 退出前落盘。
   *
   * **没有待写内容时返回 null**——这一点很关键：
   * 主进程的 before-quit 靠「有没有东西要等」来决定要不要拦住退出，
   * 若这里总是返回一个 promise，退出就会被无限重复：
   * 拦住 → 等 → 再退出 → 又拦住 → …
   * 应用永远退不出去（E2E 会整个挂住）。
   */
  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      return writeNow();
    }
    return pendingWrite;
  }

  // ------------------------------------------------------------------
  // 说话
  // ------------------------------------------------------------------

  /**
   * 让桌宠说一句话。
   *
   * **桌宠被隐藏时不弹气泡**：桌面上凭空浮一个窗口很怪，
   * 而且那个窗口里的角色不在，用户会不知道是谁在说话。
   * 这时消息进队列，桌宠重新显示时依次播报。
   *
   * 合成失败（没配 key / 断网 / 音色不对）时**静默降级**成纯文字：
   * 用户已经看到气泡里的字了，再弹一个「语音合成失败」只会更烦。
   *
   * `showBubble: false` 可以只要声音不要气泡——插件面板开着的时候用：
   * 气泡横在面板上会挡住内容（面板就在桌宠旁边，气泡也在）。
   *
   * 注意选项名**不能**叫 `bubble`：那会把外层的「气泡控制器」变量遮住，
   * `bubble.show()` 就变成了 `true.show()`——每句话都会炸。
   *
   * `interrupt: true` 表示这条消息**打断**正在进行的流式回复
   * （提醒、闹钟比聊天重要）。
   */
  function say(
    text,
    {
      emotion = '',
      sound = '',
      ttlMs,
      speak = true,
      mood = 0,
      showBubble = true,
      interrupt = false,
      // 模型点名的 clip id（「你能做出的动作」表里的那个）：空 = 不做动作。
      action = '',
      // 气泡优先摆哪边（'top' / 'bottom' / 'left' / 'right'）。
      // 点桌宠时用它把气泡摆在脚下——面板在头顶，两者不重叠。
      side = '',
      // **常驻**：不自动消失。任务结果这种「用户可能晚点才看」的东西用它。
      sticky = false,
      // 语音缓存目录：台词音频单独放一个目录（见 assistant/tapTalk.js）。
      cacheDir = '',
    } = {}
  ) {
    const content = String(text ?? '').trim();
    if (!content) return;
    if (isPetVisible && !isPetVisible()) {
      // 队列满了就把最旧的丢掉：与其让一条三小时前的提醒堵在队首，
      // 不如丢掉它——用户要的是「现在发生的事」。
      pendingMessages.push({
        text: content,
        emotion,
        sound,
        ttlMs,
        speak,
        mood,
        // 这两个也要一起排队：不然「不要气泡」的消息
        // 在桌宠回来后会变成一个气泡，横在插件面板上。
        showBubble,
        interrupt,
        side,
        sticky,
        cacheDir,
        action,
      });
      while (pendingMessages.length > MAX_PENDING_MESSAGES) pendingMessages.shift();
      return;
    }
    if (showBubble) {
      bubble.show({
        kind: MESSAGE_KIND.SAY,
        text: content,
        emotion,
        ttlMs,
        interrupt,
        side,
        sticky,
      });
    }
    // 情绪与心情增量、模型点名的动作一起发过去。
    if (emotion || action) onEmotion?.(emotion, mood, action);
    if (sound) onSound?.(sound);
    if (speak && state?.tts?.enabled) {
      void speakNow(content, { cacheDir });
    }
  }

  /** 桌宠重新显示了：把排队的消息依次播报。 */
  function flushPendingMessages() {
    while (pendingMessages.length > 0) {
      const message = pendingMessages.shift();
      say(message.text, message);
    }
  }

  /**
   * 前台这一轮说完了：把攒着的完成通知交出去。
   *
   * **交出去的时机**：答复气泡已经开着了，所以气泡会自己把通知排上队
   * （用户先读完「我去看看」，再看到结果）——不用我们自己排。
   */
  function flushPendingNotices() {
    while (pendingNotices.length > 0) {
      const notice = pendingNotices.shift();
      say(notice.text, notice.options);
    }
  }

  /**
   * TTS 的域名顺序：上次探测成功的那个排最前。
   *
   * DESK_PET_TTS_HOSTS 是**测试与开发用的覆盖口**：
   * E2E 把它指向本地桩服务，就绝不会打到真实接口上去
   * （桩服务答不上来时也不该去打真的——那会让测试又慢又不确定）。
   */
  function resolveHosts(tts) {
    const override = process.env.DESK_PET_TTS_HOSTS;
    if (override) return override.split(',').map((h) => h.trim()).filter(Boolean);
    return tts?.host ? [tts.host, ...TTS_HOSTS] : TTS_HOSTS;
  }

  /**
   * 「点桌宠时念台词」这件事本身。
   *
   * 逻辑在 assistant/tapTalk.js 里——那边不引 electron，才能脱离
   * Electron 单测（这个文件引了剪贴板与电源事件）。
   */
  const tapTalker = createTapTalk({
    getState: () => state,
    say,
    userDataDir,
    loadApiKey: () => loadApiKey(userDataDir, rootDir),
    resolveHosts,
    fetchImpl,
    onError: (err, text) => {
      console.warn(
        `[desk-pet] 台词${text ? `「${text}」` : ''}预生成失败：`,
        err?.message || err
      );
    },
  });

  /** 预先把台词合成好（后台，不阻塞启动）。 */
  function prewarmTapLines() {
    return tapTalker.prewarm();
  }

  /**
   * 预生成的防抖。
   *
   * 拖动语速滑块时每一格都会改一次设置，每改一次就重新生成全部台词——
   * 那是一连串接口调用。停手 800 毫秒后再生成，只生成一次。
   */
  function schedulePrewarm() {
    if (prewarmTimer) clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null;
      void prewarmTapLines();
    }, PREWARM_DEBOUNCE_MS);
  }

  /** 点桌宠：念一句台词。 */
  function tapTalk() {
    return tapTalker.tapTalk();
  }

  /**
   * 合成语音并交给渲染层播放。
   *
   * `wait: true` 时**等它播完**才 resolve——
   * 「先应一声」要用这个：应答念完，答案才能顶上。
   */
  async function speakNow(text, { cacheDir = '', wait = false } = {}) {
    // id 先发后用：这一声从头到尾归它，播完了渲染层拿它回报。
    const id = ++speechSeq;
    let played = null;
    if (wait) {
      played = new Promise((resolve) => pendingSpeech.set(id, resolve));
    }
    try {
      const apiKey = await loadApiKey(userDataDir, rootDir);
      if (!apiKey) return;
      const tts = state.tts;
      const hosts = resolveHosts(tts);
      const result = await synthesizeCached(
        {
          text,
          apiKey,
          voiceId: tts.voiceId,
          model: tts.model,
          speed: tts.speed,
          vol: tts.vol,
          pitch: tts.pitch,
        },
        {
          cacheDir: cacheDir || join(userDataDir, 'tts-cache'),
          fetchImpl,
          hosts,
        }
      );
      // 探测到的可用域名记下来，下次先用它。
      if (result.host && result.host !== state.tts.host) {
        state.tts.host = result.host;
        scheduleSave();
      }
      onSpeak?.(result.audio, result.mime || 'mp3', id);
      if (played) {
        // 渲染层可能永远不回报（窗口没了）：兜底超时，别把界面卡住。
        await Promise.race([played, sleep(SPEECH_WAIT_TIMEOUT_MS)]);
      }
    } catch (err) {
      // 留一行痕就够了：终端里能看到，用户界面里不必再打扰。
      console.warn('[desk-pet] 语音合成失败：', err?.message || err);
    } finally {
      // 这一声不管成没成，都不再等了：不留着占位。
      pendingSpeech.delete(id);
    }
  }

  /**
   * 渲染层回报「这段语音播完了」。
   *
   * 播完才知道这一声念到哪了——「先应一声」要靠它决定
   * 什么时候把答案气泡放出来。
   */
  function notifySpeechEnded(id) {
    const resolve = pendingSpeech.get(id);
    if (!resolve) return;
    pendingSpeech.delete(id);
    resolve();
  }

  /**
   * 应答：弹**一只单独的气泡**，并念出来。
   *
   * **单独一只**是因为答案气泡要等这一声念完才出现——
   * 两句挤在同一个气泡里，用户会以为前半句是答案的一部分。
   *
   * **要插队**（interrupt）：上一轮的回答还挂在气泡上时，
   * 不插队的话这句应答会排到它后面——用户先看到的是上一轮的旧回答，
   * 等它自己消失才轮到应答，那就白等了。
   *
   * 没开语音时没有「念完」这个信号：让应答气泡露一会儿脸，
   * 再把位置让给答案。
   */
  async function speakAck(line) {
    bubble.show({ kind: MESSAGE_KIND.SAY, text: line, interrupt: true });
    if (!state?.tts?.enabled) {
      await sleep(ACK_HOLD_MS);
      return;
    }
    await speakNow(line, { wait: true });
  }

  // ------------------------------------------------------------------
  // 插件接口
  //
  // 插件面板要「读」状态（显示清单）与「改」状态（勾掉一条待办）——
  // 这两件事以前是混在「改完顺便弹个气泡」里的。
  // 面板开着的时候冒一只气泡横在上面，输入与反馈都该留在面板里，
  // 所以这里只改状态、只给桌宠一个情绪反应，结果文字交给插件页面显示。
  // ------------------------------------------------------------------

  /**
   * 一个插件动作的结果。
   *
   * `message` 是给用户看的一句话（插件页面底部那行提示）。
   * `ok: false` 表示没做成（时间没看懂、路径打不开……），
   * 那时 `message` 是解释，不是确认。
   */
  function act({ emotion = '', sound = '', mood = 0, message = '', ok = true } = {}) {
    if (emotion) onEmotion?.(emotion, mood);
    if (sound) onSound?.(sound);
    return { ok, message };
  }

  // ------------------------------------------------------------------
  // 待办
  // ------------------------------------------------------------------

  /** 待办清单（插件界面用）。 */
  function todosView() {
    const items = state.todos.map((t) => ({ id: t.id, label: t.text, done: t.done }));
    return {
      items,
      pending: items.filter((t) => !t.done).length,
      total: items.length,
    };
  }

  /** 加一条待办。 */
  function addTodo(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, message: '没写要做什么' };
    const r = todos.addTodo(state.todos, trimmed);
    state.todos = r.todos;
    scheduleSave();
    return act({ emotion: 'happy', sound: 'success', message: `加好了：${r.added.text}` });
  }

  /** 勾选 / 取消勾选一条待办。 */
  function toggleTodo(id) {
    const before = state.todos.find((t) => t.id === id);
    if (!before) return { ok: false, message: '这条待办不在了' };
    state.todos = todos.toggleTodo(state.todos, id);
    scheduleSave();
    if (!before.done) {
      return act({
        emotion: 'happy',
        sound: 'success',
        mood: 10,
        message: `完成啦：${before.text}`,
      });
    }
    return act({ message: `取消完成：${before.text}` });
  }

  /** 清掉已完成的待办。 */
  function clearDoneTodos() {
    const n = state.todos.filter((t) => t.done).length;
    if (n === 0) return { ok: false, message: '还没有已完成的事项' };
    state.todos = todos.clearDone(state.todos);
    scheduleSave();
    return act({ message: `清掉了 ${n} 条已完成的` });
  }

  // ------------------------------------------------------------------
  // 提醒
  // ------------------------------------------------------------------

  /** 提醒清单（插件界面用；只列还没响的，按时间排）。 */
  function remindersView() {
    const items = state.reminders
      .filter((r) => !r.fired)
      .sort((a, b) => a.at - b.at)
      .map((r) => ({ id: r.id, label: r.text, at: r.at, hint: reminders.clockLabel(r.at) }));
    return { items, total: items.length };
  }

  /** 加一条提醒；时间解析不出来时**明确**告诉用户，不默默按默认时间提醒。 */
  function addReminder(text) {
    const parsed = reminders.parseReminder(text);
    if (!parsed) {
      return {
        ok: false,
        message: '没看懂时间。可以写「30分钟后」「2小时后」或者「14:30」',
      };
    }
    const r = reminders.addReminder(state.reminders, parsed.text, parsed.at);
    state.reminders = r.reminders;
    scheduleSave();
    return act({
      emotion: 'happy',
      sound: 'success',
      message: `好的，${parsed.label}提醒你「${r.added.text}」`,
    });
  }

  /** 删一条提醒。 */
  function removeReminder(id) {
    const target = state.reminders.find((r) => r.id === id);
    if (!target) return { ok: false, message: '这条提醒不在了' };
    state.reminders = reminders.removeReminder(state.reminders, id);
    scheduleSave();
    return act({ message: `删掉了提醒：${target.text}` });
  }

  // ------------------------------------------------------------------
  // 番茄钟
  // ------------------------------------------------------------------

  /**
   * 开始一段计时。
   *
   * `minutes` 不给就用预设（专注 25 分钟、休息 5 分钟）；
   * 给了就按它来——插件的时长设置与 agent 的工具都走这一条路。
   */
  function startPomodoro(phase, minutes) {
    const isBreak = phase === pomodoro.PHASE.BREAK;
    const preset = isBreak ? POMODORO_PRESETS.break : POMODORO_PRESETS.focus;
    const ms =
      Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60 * 1000) : preset;
    state.pomodoro = pomodoro.start(
      state.pomodoro,
      isBreak ? pomodoro.PHASE.BREAK : pomodoro.PHASE.FOCUS,
      ms
    );
    scheduleSave();
    const label = isBreak ? '休息' : '专注';
    return act({
      emotion: 'happy',
      sound: 'success',
      message: `开始${label}，${Math.round(ms / 60000)} 分钟`,
    });
  }

  function pausePomodoro() {
    if (state.pomodoro.phase !== pomodoro.PHASE.FOCUS && state.pomodoro.phase !== pomodoro.PHASE.BREAK) {
      return { ok: false, message: '番茄钟没有在跑' };
    }
    state.pomodoro = pomodoro.pause(state.pomodoro);
    scheduleSave();
    return act({ message: '暂停了' });
  }

  function resumePomodoro() {
    // 注意是 PHASE.PAUSED：原来这里写的是 pomodoro.PAUSED（不存在，恒为 undefined），
    // 于是这个判断恒为真，「继续」按钮从来没生效过。
    if (state.pomodoro.phase !== pomodoro.PHASE.PAUSED) {
      return { ok: false, message: '番茄钟没有在跑' };
    }
    state.pomodoro = pomodoro.resume(state.pomodoro);
    scheduleSave();
    return act({ emotion: 'happy', message: '继续' });
  }

  function resetPomodoro() {
    state.pomodoro = pomodoro.reset();
    scheduleSave();
    return act({ message: '番茄钟重置了' });
  }

  /** 番茄钟当前状态（插件界面用）。 */
  function pomodoroView(now = Date.now()) {
    const p = state.pomodoro;
    const remain = pomodoro.remaining(p, now);
    const duration = Number.isFinite(p.durationMs) && p.durationMs > 0 ? p.durationMs : 1;
    return {
      phase: p.phase,
      text: pomodoro.pomodoroText(p, now),
      running: p.phase === pomodoro.PHASE.FOCUS || p.phase === pomodoro.PHASE.BREAK,
      paused: p.phase === pomodoro.PHASE.PAUSED,
      // 给倒计时圆环用：还剩多少、整段多长、走了几成。
      remainingMs: remain,
      remainingText: pomodoro.formatRemaining(remain),
      durationMs: duration,
      progress: Math.max(0, Math.min(1, 1 - remain / duration)),
    };
  }

  // ------------------------------------------------------------------
  // 天气
  // ------------------------------------------------------------------

  /** 天气：城市、开关与最近一次的结果（插件界面用）。 */
  function weatherView() {
    const last = state.weather.last;
    return {
      city: state.weather.city,
      enabled: Boolean(state.weather.enabled),
      text: last ? weather.weatherLine(last.city, last) : '',
      // 结构化的数值：天气面板要画图标与大字，只能给数字/代码。
      // 磁盘上的旧数据可能缺字段——给，但**缺多少认多少**（界面按有没有画）。
      code: Number.isFinite(last?.code) ? last.code : null,
      temperature: Number.isFinite(last?.temperature) ? last.temperature : null,
      humidity: Number.isFinite(last?.humidity) ? last.humidity : null,
      wind: Number.isFinite(last?.wind) ? last.wind : null,
      // 给天气主卡的条件文字（「晴」「小雨」……）：整句 text 里还带着城市/温度，
      // 主卡自己排版，不直接用整句。
      condition: Number.isFinite(last?.code) ? weather.weatherText(last.code) : '',
      at: Number.isFinite(last?.at) ? last.at : 0,
      // 主卡图标名：WMO 代码 → 图标集里的名字（渲染层只照着画）。
      icon: weatherIconName(Number.isFinite(last?.code) ? last.code : null),
    };
  }

  /**
   * 查一次天气并记进状态；**不说话**。
   *
   * 插件界面要自己显示结果，所以这里只返回文字。
   * 定时播报走 reportWeather（那边要说话）。
   */
  async function fetchWeather(city) {
    const name = city || state.weather.city;
    if (!name) return { ok: false, message: '还没设置城市' };
    try {
      const place = await weather.geocode(name, fetchImpl);
      if (!place) return { ok: false, message: `没找到「${name}」这个地方` };
      const current = await weather.fetchWeather(place.latitude, place.longitude, fetchImpl);
      state.weather.last = { city: name, ...current, at: Date.now() };
      scheduleSave();
      return { ok: true, message: weather.weatherLine(name, current) };
    } catch (err) {
      // 断网/接口挂了就安静降级：不重试、不刷屏。
      console.warn('[desk-pet] 天气查询失败：', err?.message || err);
      return { ok: false, message: '天气暂时查不到' };
    }
  }

  /** 定时播报用的天气查询：查完顺便说一声。 */
  async function reportWeather(city) {
    const r = await fetchWeather(city);
    say(r.message, { emotion: r.ok ? 'neutral' : 'sad' });
  }

  /** 设置城市。 */
  function setWeatherCity(city) {
    const name = String(city || '').trim();
    if (!name) return { ok: false, message: '城市名不能空' };
    state.weather.city = name;
    scheduleSave();
    return act({ message: `城市改成「${name}」了` });
  }

  /** 定时播报的开关。 */
  function setWeatherEnabled(on) {
    const next = Boolean(on);
    if (next === state.weather.enabled) {
      return act({ message: next ? '天气播报已经开着了' : '天气播报已经关着了' });
    }
    state.weather.enabled = next;
    scheduleSave();
    if (!next) return act({ message: '天气播报关掉了' });
    if (!state.weather.city) {
      return act({ emotion: 'happy', message: '天气开好了，先设置一个城市吧' });
    }
    return act({ emotion: 'happy', message: '天气播报开好了' });
  }

  // ------------------------------------------------------------------
  // 桌宠天气效果
  // ------------------------------------------------------------------

  /** 「自动」抽效果要用的当前情况：最近一次天气 + 季节（0-based 月份）。 */
  function weatherFxConditions() {
    const last = state?.weather?.last;
    return {
      code: last?.code,
      wind: last?.wind,
      month: new Date().getMonth(),
    };
  }

  /**
   * 桌宠天气效果选择器的数据（天气插件正文用）。
   *
   * 效果开关与效果选择**不画在设置抽屉里**：清单里那两项标了 `hidden`，
   * 配置读写照旧走宿主那一套（`settings:effectEnabled` / `settings:effect`），
   * 界面由天气插件自己拼（小方框预览需要画布，设置抽屉画不了）。
   */
  function weatherEffectView() {
    const cfg = getWeatherEffectConfig?.() || null;
    const choice = String(cfg?.effect ?? '自动');
    const conditions = weatherFxConditions();
    const autoPick = weatherFx.resolveAutoEffect(conditions);
    const options = weatherFx.WEATHER_EFFECT_OPTIONS.map((value) => {
      const key = weatherFx.normalizeEffectChoice(value);
      return {
        value,
        label: value,
        icon: weatherFx.WEATHER_EFFECT_ICON[key] || 'sparkles',
        effect: key,
        // 「自动」写清楚它现在会播哪一种——不看预览猜不出来。
        sub: key === 'auto' ? `播${weatherFx.effectLabel(autoPick)}` : '',
      };
    });
    return {
      enabled: cfg?.effectEnabled === true,
      // 清单里存的就是中文选项名（「自动」「下雪」……）：直接对齐。
      choice: weatherFx.WEATHER_EFFECT_OPTIONS.includes(choice) ? choice : '自动',
      hint: '开着时桌宠会根据当前天气与季节，随机偶尔播一阵雨 / 风 / 雪 / 晴 / 落叶。',
      options,
    };
  }

  /**
   * 预览一种效果（天气插件里的「预览效果」按钮）。
   *
   * **不管开关开着没**：预览是用户点名要看的，不是自动播放。
   * 选择是「自动」时按当前天气与季节抽。
   */
  function previewWeatherEffect(selection) {
    if (isPetVisible && !isPetVisible()) {
      return { ok: false, message: '桌宠不在屏幕上，先叫它出来吧' };
    }
    const effect = weatherFx.resolveEffectChoice(selection, weatherFxConditions());
    onWeatherEffect?.(effect);
    return { ok: true, message: `正在预览「${weatherFx.effectLabel(effect)}」`, effect };
  }

  /** 「随机偶尔」的一阵：每隔几分钟掷一次骰子，掷中了才播。 */
  function maybePlayWeatherEffect(now) {
    if (now - lastFxCheck < weatherFx.EFFECT_CHECK_MS) return;
    lastFxCheck = now;
    const cfg = getWeatherEffectConfig?.();
    if (!cfg || cfg.effectEnabled !== true) return;
    if (now - lastFxAt < weatherFx.EFFECT_MIN_GAP_MS) return;
    if (isPetVisible && !isPetVisible()) return;
    if (Math.random() >= weatherFx.EFFECT_TRIGGER_CHANCE) return;
    const effect = weatherFx.resolveEffectChoice(cfg.effect, weatherFxConditions());
    lastFxAt = now;
    onWeatherEffect?.(effect);
  }

  // ------------------------------------------------------------------
  // 系统状态
  // ------------------------------------------------------------------

  /**
   * 系统状态（插件界面用）。
   *
   * `text` 是给人看的一段话；`cpu` / `memory` / `thermal` / `onBattery`
   * 是给**图**用的原始数值——桌面小部件要画进度条，只能用数字。
   */
  function statusView() {
    const cpu = systemStatus.sampleCpuPercent();
    const memory = systemStatus.sampleMemoryPercent();
    const mem = systemStatus.memoryUsage();
    const thermal = safeThermalState();
    const onBattery = safeOnBattery();
    // GPU 是异步采的：这里读的是最近一次的结果，采不到就是 null。
    const gpuInfo = gpu.gpuStatus();
    // 网络也是异步采的：速率是两次采样的差值。
    const netInfo = network.networkStatus();
    return {
      text: systemStatus.formatStatus({ cpu, memory, thermal, onBattery, gpu: gpuInfo, network: netInfo }),
      cpu,
      memory,
      // 内存多少G（界面里画「15.9 / 26.1 GB」用的）。
      memoryText: systemStatus.formatMemory(mem.total, mem.free),
      thermal,
      thermalText: systemStatus.thermalText(thermal),
      onBattery,
      gpu: gpuInfo,
      network: netInfo,
      hotAlert: Boolean(state.hotAlert.enabled),
    };
  }

  function safeThermalState() {
    try {
      return powerMonitor.getCurrentThermalState();
    } catch {
      return 'unknown';
    }
  }

  function safeOnBattery() {
    try {
      return powerMonitor.isOnBatteryPower();
    } catch {
      return null;
    }
  }

  /**
   * 「此刻正在发生的事」——提示词里给模型看的一段实时状态。
   *
   * **主动搭话全靠它**：没有这一段，模型只能从历史里挖一件早就结束的事
   * 当成现状（用户早就手动停掉的音乐，被说成「还在播放」）。
   */
  function snapshotLines(now = Date.now()) {
    const tasks = (agentTasks?.list?.() || []).filter((t) => t && t.status === TASK_STATUS.RUNNING);
    const pluginLines = typeof getPluginStatus === 'function' ? getPluginStatus() : [];
    return buildSnapshotLines({
      state: state || {},
      now,
      onBattery: safeOnBattery(),
      thermal: safeThermalState(),
      pluginLines,
      runningTasks: tasks.map((t) => String(t.title || '')).filter(Boolean),
    });
  }

  /** 过热提醒的开关。 */
  function setHotAlertEnabled(on) {
    const next = Boolean(on);
    state.hotAlert.enabled = next;
    scheduleSave();
    return act({
      message: next ? '太热的时候我会提醒你' : '不再提醒温度了',
    });
  }

  // ------------------------------------------------------------------
  // 剪贴板
  // ------------------------------------------------------------------

  /** 剪贴板助手开关。 */
  function setClipboardEnabled(on) {
    const next = Boolean(on);
    state.clipboard.enabled = next;
    scheduleSave();
    if (next) clipboardWatcher.start();
    else clipboardWatcher.stop();
    return act({
      message: next ? '剪贴板助手开好了' : '剪贴板助手关掉了',
    });
  }

  /** 剪贴板助手开没开（插件界面用）。 */
  function clipboardView() {
    return { enabled: Boolean(state.clipboard.enabled) };
  }

  /** 读一次剪贴板（插件界面用）。内容**只留在内存里**。 */
  async function readClipboard() {
    // Electron 45 的剪贴板读取是异步的。
    const text = await clipboardWatcher.readNow();
    if (!text || !text.trim()) return { ok: false, text: '' };
    return { ok: true, text: truncateClipboard(text) };
  }

  // ------------------------------------------------------------------
  // 对话
  //
  // 一次调用同时拿三样：回复正文、这一轮的情绪、值得记住的事。
  // 回复在桌宠旁边的气泡里**流式**显示；情绪直接驱动桌宠的表情。
  // ------------------------------------------------------------------

  /** 要试的接口地址：配置的优先、上次成功的其次、再是默认那批。 */
  function llmBaseUrls() {
    // 测试与开发用的覆盖口：指向本地桩服务就绝不会打到真实接口。
    const override = process.env.DESK_PET_LLM_BASE_URL;
    if (override) {
      return override
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
    }
    const list = [state.llm.baseUrl, state.llm.lastWorkingBaseUrl, ...LLM_BASE_URLS].filter(Boolean);
    return [...new Set(list)];
  }

  /**
   * think 模式的请求参数。
   *
   * **不认这些参数的模型要记住**：同一个模型再问一次时就不发了，
   * 免得每轮都先撞一次 400。
   */
  function buildThinkConfig() {
    const think = {
      mode: state.llm.think ? 'on' : 'off',
      level: state.llm.thinkLevel,
      // 接口不认这些参数时会调它：去掉参数重试，并告诉用户一声。
      onUnsupported: ({ model, mode }) => {
        think.mode = 'none';
        if (!model || thinkUnsupportedModels.has(model)) return;
        thinkUnsupportedModels.add(model);
        thinkNoticeShown = true;
        // 要插队：不然这句提醒会排在上一轮的回答后面，用户看不到。
        // 关着的时候语气不一样：用户本来就不要 think，没什么可惊讶的。
        say(
          mode === 'off'
            ? '这个模型不认 think 的开关，普通模式也一样～'
            : '这个模型好像不支持 think 模式，我先按普通模式来啦',
          { speak: false, interrupt: true }
        );
      },
    };
    if (thinkUnsupportedModels.has(state.llm.model)) think.mode = 'none';
    return think;
  }

  /**
   * 跑一轮对话。
   *
   * @param {object} options
   * @param {string} options.text 用户说的话（主动搭话时为空）
   * @param {'user'|'proactive'} options.trigger 谁发起的
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function runChat({ text = '', trigger = 'user' }) {
    const content = String(text || '').trim();
    if (trigger === 'user' && !content) return { ok: false, message: '没说要什么' };
    if (!state.llm.enabled) return { ok: false, message: '对话还没打开（去设置里启用）' };

    // 前台走**同一个 agent**（规格 §3）：
    // 它能调工具、能交出去继续做，而且模型不支持工具调用时会自动退回普通对话。
    const backend = backends.get('agent');
    if (!backend) return { ok: false, message: '没有可用的对话后端' };

    const token = ++chatSeq;
    chatBusy = true;

    // 上下文要用**还没加上这句话**的历史：
    // buildChatMessages 自己会把当前这句话放到最后，
    // 历史里再带一遍的话，模型会看到同一句话出现两次。
    const history = state.chat.messages;
    // **这一轮的「此刻」**：搭话时全靠它，
    // 历史里的旧事不再被当成正在发生。
    const now = Date.now();
    const system = buildSystemPrompt({
      persona: state.llm.persona,
      facts: state.chat.facts,
      snapshot: snapshotLines(now),
    });
    const messages = buildChatMessages({
      history,
      userText: content,
      trigger,
      // 上下文按**前台**过滤：它看得见自己派过什么（dispatch），
      // 看不见任务与步骤那些「给人看的」记录（规格 §6）。
      layer: LAYER.INTERACTION,
      now,
    });

    // 把用户说的话记下来：说过就是说过，
    // 哪怕模型没回（没配 key、断网），这句话也不该丢。
    if (trigger === 'user') {
      appendChatRecord({
        role: 'user',
        text: content,
        at: Date.now(),
        proactive: false,
      });
      lastUserMessageAt = Date.now();
    }

    const apiKey = await loadLlmApiKey(userDataDir, rootDir);
    const config = {
      apiKey,
      baseUrls: llmBaseUrls(),
      model: state.llm.model,
      temperature: state.llm.temperature,
      maxTokens: state.llm.maxTokens,
      maxTokensField: state.llm.maxTokensField,
      think: buildThinkConfig(),
    };

    // 桌宠不在屏幕上时不要凭空浮一个气泡（没有角色在说话）。
    const petVisible = !isPetVisible || isPetVisible();

    // 上一轮的气泡先收掉：新一轮要重新开流。
    // 不收的话旧流还占着气泡，「先应一声」那句话会排进队里
    // （气泡控制器不打断正在进行的流），等旧流结束才显示——那就白应了。
    bubble.cancelStream();

    // 「先应一声」：模型还在忙的时候，先给用户一个回应。
    // 这一轮的开头：先假设「还没告诉过用户 think 不支持」。
    thinkNoticeShown = false;
    const ack = createAck({
      // 等多久没人说话就先应一声——用户在设置页里改的。
      delayMs: state.llm.ackDelayMs,
      speak: (line) => (thinkNoticeShown ? undefined : speakAck(line)),
      logger: console,
    });
    // 关掉「先应一声」就不上计时器：一声不吭地等答案。
    if (trigger === 'user' && petVisible && state.llm.ackEnabled) ack.arm();

    // 答案气泡：应答让位之后才开（见 chat/stream.js）。
    const reply = petVisible ? createReplyBubble({ bubble }) : null;

    let result;
    try {
      result = await runForeground({
        agent: backend,
        plain: backends.get('chat'),
        ctx: {
          system,
          messages,
          // 这一句的原话：交出去的时候后台要拿到「那一刻的对话」。
          prompt: content,
          trigger,
          config,
          onDelta: (delta) => {
            if (!delta) return;
            // 有可见正文了：不必再应一声。
            ack.noteText();
            reply?.push(delta);
          },

          // ------------------------------------------------------------------
          // 前台这一轮的设置
          // ------------------------------------------------------------------

          // **步数少**：前台等的是秒级回应，三步够「查、做、答」。
          maxSteps: FOREGROUND_MAX_STEPS,
          // 步数用尽时**不总结**：前台要的是把事交出去，不是就地停下。
          summarize: false,
          // **工具带回的话就是这一轮的答复**（交出去时模型写的那句）。
          answerFromTool: true,
          // 能不能把这件事交出去继续做。
          canEscalate: dispatchEnabled(),
          // **「只聊天」模式**：前台一个工具都不给——
          // 不查本机、不翻文件、不跑命令，什么都不替用户做。
          includeRegistryTools: dispatchEnabled(),

          // **审批闸门是这一轮一个**：用户点「自动放行」只管这一轮，
          // 不会顺手动到下一轮的事上去。
          gate: createApprovalGate({
            getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
            getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
            ask: ({ tool, args, risk }) =>
              bubble.showApproval({
                id: `fg-${++approvalSeq}`,
                taskId: 'foreground',
                title: '需要你点头',
                text: describeToolCall(tool, args),
                risk,
              }),
            taskId: 'foreground',
            // 审批也要留一笔：记录里要看得见「它停在这儿等你点头」。
            onRequest: (info) =>
              appendChatRecord(approvalRecord({ ...info, decision: APPROVAL_DECISION.PENDING })),
            onDecision: (decision) => appendChatRecord(approvalRecord(decision)),
          }),

          // **这一轮多带的工具**：管后台那些事（交出去、取消、追加要求）。
          //
          // 传函数是因为「交出去」要拿到**当前这段对话**——
          // 带着对话继续，不是重写一遍。
          //
          // **「只聊天」模式一个都不给**：那时候没有后台任务可管
          // （切过去的时候活儿都停掉了）。
          tools: (getConvo) =>
            dispatchEnabled()
              ? createTaskTools({
                  tasks: agentTasks,
                  getConvo,
                  config,
                  canEscalate: true,
                  appendRecord: appendChatRecord,
                })
              : [],

          // **交出去**：带着这段对话进后台。
          escalate: async ({ convo }) => {
            // **交底用用户那句原话**：模型自己没写目标（它连工具都没调），
            // 用户那句就是唯一说清「要什么」的东西。
            const goal = content || '把刚才那件事做完';
            // **看板上写短名**：长句截断了才看得懂。
            const name = goal.length > 24 ? `${goal.slice(0, 24)}…` : goal;
            const task = agentTasks.submit({
              prompt: goal,
              title: name,
              // **交出去的是对话本身**：用户说的原话、已经查到的结果都在里面。
              messages: convo,
              config,
            });
            if (!task?.ok) return { ok: false };
            appendChatRecord(
              dispatchRecord({
                tool: 'task.run',
                taskId: task.taskId,
                title: name,
                action: `开始做：${name}`,
                brief: goal,
              })
            );
            return { ok: true, taskId: task.taskId, answer: '' };
          },

          // **这一回合的过程写进记录**（聊天历史页要显示）。
          onRound: (round) => {
            const text = String(round?.text || '').trim();
            if (!text) return;
            appendChatRecord(
              modelRecord({ index: round?.index, text, model: String(config.model || '') })
            );
          },
          onEvent: (event) => {
            if (event?.type !== 'step') return;
            appendChatRecord(
              stepRecord({
                index: event.index,
                tool: event.tool,
                args: event.args,
                result: event.result,
                error: event.error,
                label: event.label,
                layer: LAYER.INTERACTION,
              })
            );
          },
        },
        onFallback: () => {
          // 这个模型不支持工具调用：明说，别让用户对着英文报错发呆。
          say(FALLBACK_NOTICE, { speak: false, interrupt: true });
        },
      });
    } catch (err) {
      ack.cancel();
      reply?.cancel();
      // 只有**这一轮**还在跑的时候才清标记：
      // 被后一轮取代时提前清掉，主动搭话会以为「没人说话」而插进来。
      if (token === chatSeq) {
        chatBusy = false;
        // 这一轮没答上来，但后台任务做完了还是要说——不然结果就丢了。
        flushPendingNotices();
      }
      throw err;
    }
    // 被后一轮对话取代了：这一轮不写进历史，也不动气泡。
    if (token !== chatSeq) {
      ack.cancel();
      reply?.cancel();
      return { ok: false, message: '这一轮被新的对话取代了' };
    }

    // 自发反应整轮没说一句（模型决定沉默）：不开气泡、不进历史、不记记忆——
    // 只把情绪/动作施加出去。历史里不该有空答复。
    const spoke = Boolean(result.text);

    // 答案好了：应答要么还没轮到（那就不必应了），要么正在念（那就等它念完）。
    ack.release();
    await ack.whenReady();
    if (token !== chatSeq) return { ok: false, message: '这一轮被新的对话取代了' };
    if (spoke) {
      reply?.open();
      reply?.finish({ text: result.text, emotion: result.emotion });
    }

    // 这一轮说完了：**这时才把攒着的完成通知交出去**。
    // （答复气泡开着，气泡自己会把通知排上队——用户先读答复，再看结果。）
    // 清标记也挪到这里：答复还没上屏的时候，主动搭话别插进来。
    chatBusy = false;
    flushPendingNotices();

    // 记下这一轮。
    if (spoke) {
      appendChatRecord({
        role: 'assistant',
        text: result.text,
        at: Date.now(),
        proactive: trigger !== 'user',
        // **轮数与模型名**：页面上那行「问模型 X · N 轮」读的是它。
        // 轮数取后端返回的步数——数 model 记录条数会把「退回普通对话」那种轮算漏。
        meta: {
          rounds: Number(result.steps) || 0,
          model: String(config.model || ''),
        },
      });
      // 只记「重要的事」：临时的一律不记，用户明确要求记住的必须记上。
      const memories = pickMemories(result.memories, { userText: content });
      if (memories.length) {
        state.chat.facts = mergeFacts(state.chat.facts, memories);
      }
    }
    // 探测出来的可用地址记下来：下次先用它（照 tts.host 的做法）。
    if (result.baseUrl && result.baseUrl !== state.llm.lastWorkingBaseUrl) {
      state.llm.lastWorkingBaseUrl = result.baseUrl;
    }
    scheduleSave();

    // 情绪与模型点名的动作**立刻**生效（哪怕桌宠藏着——回复是刚刚发生的）。
    onEmotion?.(result.emotion, result.mood, result.action);
    // 念出来，但**不要**再弹一个气泡（回复已经流式显示在气泡里了），
    // 也不重复施加情绪（say() 会再施加一次，那会把心情加两遍）。
    if (spoke) say(result.text, { speak: true, showBubble: false });

    return { ok: true, message: result.text };
  }

  /**
   * 和桌宠聊天（用户发起的）。
   *
   * 失败时把原因说清楚——用户要看得懂「没配 key」「模型没开通」这类错误。
   */
  async function chat(text) {
    try {
      const result = await runChat({ text, trigger: 'user' });
      if (!result.ok) {
        // 没做成要说清楚：用户发了一句话却毫无反应，会以为程序坏了。
        say(result.message, { emotion: 'sad', speak: false, interrupt: true });
      }
      return result;
    } catch (err) {
      const message = chatErrorText(err);
      console.warn('[desk-pet] 对话失败：', err?.message || err);
      say(message, { emotion: 'sad', speak: false, interrupt: true });
      return { ok: false, message };
    }
  }

  /** 把接口的错误变成用户看得懂的一句话。 */
  function chatErrorText(err) {
    const detail = String(err?.body || '').slice(0, 200);
    const base = String(err?.message || err || '对话失败');
    return detail ? `${base}（${detail}）` : base;
  }

  /**
   * 一次性的模型调用（插件用）。
   *
   * 与 `chat` 差在哪儿：**不进聊天记录、不弹气泡、不出声**——
   * 插件要的是一段结果（翻译、摘要、改写），不是一次对话。
   * 桌宠不该知道你插件在背后让它干了什么。
   *
   * 失败时回 `{ ok: false, message }`：**不抛**——
   * 抛出去的话，插件那边得自己接住，而它多半只是想显示一句失败原因。
   */
  async function complete(prompt, { system = '', temperature = 0.2 } = {}) {
    const content = String(prompt || '').trim();
    if (!content) return { ok: false, message: '没内容' };
    const backend = backends.get('chat');
    if (!backend) return { ok: false, message: '没有可用的对话后端' };
    try {
      const apiKey = await loadLlmApiKey(userDataDir, rootDir);
      if (!apiKey) return { ok: false, message: '还没配 API Key（去设置里填）' };
      const result = await backend.chat({
        system: String(system || ''),
        messages: [{ role: 'user', content }],
        config: {
          apiKey,
          baseUrls: llmBaseUrls(),
          model: state.llm.model,
          temperature: Number(temperature) || 0,
          maxTokens: state.llm.maxTokens,
          maxTokensField: state.llm.maxTokensField,
        },
        onDelta: () => {},
      });
      const text = String(result?.text || '').trim();
      if (!text) return { ok: false, message: '模型没有回内容' };
      return { ok: true, text };
    } catch (err) {
      console.warn('[desk-pet] 模型调用失败：', err?.message || err);
      return { ok: false, message: chatErrorText(err) };
    }
  }

  /**
   * 聊天记录（插件界面用）。
   *
   * **带上 kind**：以后记录里会混进任务、步骤、审批，
   * 界面要按分类分区显示；不带 kind 的话界面只能靠 role 猜。
   */
  function chatHistoryView() {
    const messages = (state.chat.messages || []).map((m) => ({
      id: m.id,
      kind: chatKindOf(m),
      role: m.role,
      text: m.text,
      at: m.at,
      proactive: Boolean(m.proactive),
      ...(m.meta ? { meta: m.meta } : {}),
    }));
    return { messages, total: messages.length, facts: [...(state.chat.facts || [])] };
  }

  /** 清空聊天记录与长期记忆。 */
  function clearChatHistory() {
    state.chat.messages = [];
    state.chat.facts = [];
    scheduleSave();
    return { ok: true, message: '记录清空了' };
  }

  /**
   * 主动搭话：条件全过了才开口。
   *
   * 这是 tick 里优先级最低的一件事——提醒和报时比它重要得多。
   */
  function maybeProactive(now) {
    const p = state.llm.proactive;
    if (!state.llm.enabled || !p.enabled) return;
    if (chatBusy) return; // 不和正在进行的对话抢气泡
    if (isPetVisible && !isPetVisible()) return; // 桌宠不在屏幕上时不该凭空说话
    if (now - appStartedAt < PROACTIVE_STARTUP_DELAY_MS) return;
    if (p.nextAttemptAt && now < p.nextAttemptAt) return; // 失败退避中
    if (now - p.lastAt < p.minIntervalMs) return; // 频率上限
    if (lastUserMessageAt && now - lastUserMessageAt < PROACTIVE_IDLE_MS) return; // 用户刚说过话
    const hour = new Date(now).getHours();
    if (hour >= QUIET_HOURS[0] || hour < QUIET_HOURS[1]) return; // 深夜不搭话

    // 条件都过了：先记下时间，别在同一个 tick 里重复触发。
    p.lastAt = now;
    scheduleSave();
    void proactiveChat(now);
  }

  /** 真的去搭一句话。失败只写日志，不弹错误气泡（失败的搭话不该在桌面上留提示）。 */
  async function proactiveChat(now) {
    try {
      await runChat({ trigger: 'proactive' });
      state.llm.proactive.consecutiveFailures = 0;
      state.llm.proactive.nextAttemptAt = 0;
      scheduleSave();
    } catch (err) {
      const p = state.llm.proactive;
      p.consecutiveFailures += 1;
      // 指数退避：间隔 × 2^失败次数，封顶 6 小时。
      const backoff = Math.min(
        PROACTIVE_BACKOFF_MAX_MS,
        p.minIntervalMs * 2 ** Math.min(p.consecutiveFailures, 6)
      );
      p.nextAttemptAt = now + backoff;
      scheduleSave();
      console.warn('[desk-pet] 主动搭话失败：', err?.message || err);
    }
  }

  /**
   * 自发反应（ambient）：桌宠「看了看四周」的一眼。
   *
   * 与主动搭话的区别：搭话一定开口、要等用户很久没说话；
   * 自发反应**大部分时候沉默**——它让模型看一眼「此刻正在发生的事」，
   * 值得说/值得做就说一句或做个动作，不值得就什么都不做。
   *
   * **此刻没有任何值得看的内容时压根不叫醒模型**：
   * 快照是空的时候，这一轮只会白花一个请求。
   */
  function maybeAmbient(now) {
    const a = state.llm.ambient;
    if (!state.llm.enabled || !a?.enabled) return;
    if (chatBusy || ambientInFlight) return;
    if (isPetVisible && !isPetVisible()) return;
    const hour = new Date(now).getHours();
    if (hour >= QUIET_HOURS[0] || hour < QUIET_HOURS[1]) return;
    if (lastUserMessageAt && now - lastUserMessageAt < AMBIENT_IDLE_MS) return;
    if (now - lastAmbientAt < (a?.minIntervalMs ?? DEFAULT_AMBIENT_INTERVAL_MS)) return;
    // 此刻看得见的事为空：没什么可反应的，别白叫醒模型。
    if (snapshotLines(now).length === 0) return;

    lastAmbientAt = now;
    ambientInFlight = true;
    void ambientChat().finally(() => {
      ambientInFlight = false;
    });
  }

  /** 真的看一眼。失败只写日志，不打扰用户。 */
  async function ambientChat() {
    try {
      await runChat({ trigger: 'ambient' });
    } catch (err) {
      console.warn('[desk-pet] 自发反应失败：', err?.message || err);
    }
  }

  // ------------------------------------------------------------------
  // 主循环
  // ------------------------------------------------------------------

  function tick() {
    const now = Date.now();

    // GPU：自己会限流（两秒一次），这里只是叫醒它。
    void gpu.refreshGpu();
    // 网络：自己也会限流（两秒一次）。
    void network.refreshNetwork();

    // 整点报时
    if (state.chime.enabled) {
      const d = new Date(now);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
      if (clock.isOnTheHour(d) && key !== lastChimeKey) {
        lastChimeKey = key;
        say(clock.chimeText(d), { emotion: 'happy' });
      }
    }

    // 到点的提醒
    const due = reminders.dueReminders(state.reminders, now);
    if (due.length > 0) {
      state.reminders = reminders.markFired(state.reminders, due.map((r) => r.id));
      scheduleSave();
      for (const r of due) {
        // 打断：提醒比正在进行的聊天重要。
        say(`提醒你：${r.text}`, { emotion: 'surprised', sound: 'alarm', mood: 5, interrupt: true });
      }
    }

    // 番茄钟到点
    if (pomodoro.isFinished(state.pomodoro, now)) {
      const wasFocus = state.pomodoro.phase === pomodoro.PHASE.FOCUS;
      state.pomodoro = pomodoro.reset();
      scheduleSave();
      say(wasFocus ? '专注结束啦，休息一下吧' : '休息结束，继续加油', {
        emotion: 'happy',
        sound: 'alarm',
        mood: 8,
      });
    }

    // 热状态
    if (now - lastThermalCheck >= THERMAL_CHECK_MS) {
      lastThermalCheck = now;
      if (state.hotAlert.enabled) {
        const thermal = safeThermalState();
        if (systemStatus.isTooHot(thermal) && now - lastHotAlertAt > 10 * 60 * 1000) {
          lastHotAlertAt = now;
          say('我好热…你也别让它太热哦', { emotion: 'sad', mood: -8 });
        }
      }
    }

    // 天气刷新
    if (state.weather.enabled && state.weather.city && now - lastWeatherCheck >= WEATHER_REFRESH_MS) {
      lastWeatherCheck = now;
      void reportWeather(state.weather.city);
    }

    // 桌宠天气效果：偶尔随机来一阵
    maybePlayWeatherEffect(now);

    // 主动搭话：条件最多、优先级最低——它只是「锦上添花」，
    // 绝不能挤掉提醒和报时。
    maybeProactive(now);
    // 自发反应：比搭话更轻——大部分时候什么都不发生。
    maybeAmbient(now);
  }

  // ------------------------------------------------------------------
  // 对外
  // ------------------------------------------------------------------

  return {
    /** 启动：读状态、起定时器。 */
    async start() {
      state = await loadAssistant(userDataDir);
      // 上次退出时还在跑的任务：在记录里标一句「已中断」。
      //
      // **不尝试恢复**：跑着的 shell 子进程早就死了，
      // 假装能恢复是自欺欺人。
      const interrupted = interruptedTasks(state.chat.messages);
      for (const task of interrupted) {
        appendChatRecord(
          taskRecord({
            taskId: task.taskId,
            status: TASK_STATUS.INTERRUPTED,
            title: task.title,
          })
        );
      }
      if (state.clipboard.enabled) clipboardWatcher.start();
      // 台词语音预先合成好（后台）：点桌宠时要立刻出声。
      void prewarmTapLines();
      // 先取一次 CPU 采样当基准：占用率是**两次采样的差值**，
      // 没有基准就只有一个「不知道」。启动时取一次，
      // 用户第一次看系统状态时就已经有数字了。
      systemStatus.sampleCpuPercent();
      // GPU 也先采一次：第一次看系统状态就该有 GPU 的数。
      void gpu.refreshGpu();
      // 网络同理：先采一次，速率要等下一轮才有差值。
      void network.refreshNetwork();
      tickTimer = setInterval(tick, TICK_MS);
      // 问候语：等模型加载完再说。
      greetingTimer = setTimeout(() => {
        greetingTimer = null;
        if (state.greeting.enabled) {
          const g = clock.greetingFor(new Date());
          say(g.text, { emotion: g.emotion });
        }
      }, GREETING_DELAY_MS);
    },

    stop() {
      if (tickTimer) clearInterval(tickTimer);
      if (greetingTimer) clearTimeout(greetingTimer);
      if (saveTimer) clearTimeout(saveTimer);
      if (prewarmTimer) clearTimeout(prewarmTimer);
      saveTimer = null;
      tickTimer = null;
      greetingTimer = null;
      prewarmTimer = null;
      clipboardWatcher.stop();
      // 退出前取消所有任务：跑着的命令留着不管，
      // 应用退出后它还在动用户的机器。
      agentTasks.runtime.stop();
    },

    /** 退出前落盘。 */
    flush: flushSave,

    getState: () => state,

    /** 桌宠重新显示了：把排队的消息依次播报。 */
    onPetVisible: flushPendingMessages,

    /** 设置窗口改了偏好。 */
    update(patch) {
      // 状态还没加载完（start() 还在等磁盘）时收到偏好：
      // 直接丢掉，别让 `state.llm.persona` 之类炸掉。
      if (!state) return state;
      // 改之前的值：拿来判断缓存有没有作废。
      const before = state;
      // 合并之后**必须**过一遍 sanitizeAssistant：
      // 否则内存里可能留着越界的值（比如语速 0），
      // 而落盘的那份被夹紧过——内存与磁盘不一致，
      // 越界的值还会被直接发给接口。
      // agent.approval 要**深一层**合并：
      // 只带 policy 的补丁会把「永久放行的工具名单」整个换掉。
      const next = mergeAssistantPatch(state, patch);
      // `llm` 里的 persona / proactive / ambient 要**深一层**合并：
      // 设置窗口只会送来用户能改的那几个字段，
      // 浅合并会把「上次搭话时间」「连续失败次数」这些内部状态抹掉。
      if (patch?.llm && typeof patch.llm === 'object') {
        next.llm = {
          ...state.llm,
          ...patch.llm,
          persona: { ...state.llm.persona, ...(patch.llm.persona || {}) },
          proactive: { ...state.llm.proactive, ...(patch.llm.proactive || {}) },
          ambient: { ...state.llm.ambient, ...(patch.llm.ambient || {}) },
        };
      }
      state = sanitizeAssistant(next);
      // 切到「只聊天」：手上有活就停掉。
      // 这是唯一的收口——不管这个改动从哪条路来（设置页、插件、代码），都会停。
      if (state?.agent?.dispatch === 'off' && before?.agent?.dispatch !== 'off') {
        agentTasks.cancelAll();
      }
      scheduleSave();
      if (patch?.clipboard?.enabled !== undefined) {
        if (patch.clipboard.enabled) clipboardWatcher.start();
        else clipboardWatcher.stop();
      }
      // 改了音色/语速/台词 → 缓存键变了，重新预生成一遍。
      // 刚把语音打开 → 之前根本没生成过，这时也要生成。
      const ttsJustOn = before.tts?.enabled !== state.tts?.enabled && state.tts?.enabled;
      if (ttsJustOn || tapTalkNeedsPrewarm(before, state)) schedulePrewarm();
      return state;
    },

    // 重新预生成台词语音（设置窗口存了 Key 之后要调）。
    prewarmTapLines,

    // 点桌宠时念一句台词（渲染层点到了桌宠）。
    tapTalk,

    /**
     * 渲染层回报「这段语音播完了」。
     *
     * 「先应一声」要靠它决定什么时候把答案气泡放出来。
     */
    notifySpeechEnded,

    // —— 插件接口 ——
    // 「读」是给插件界面显示的，「改」是用户动了之后要落地的；
    // 两者都**不弹气泡**：面板开着的时候，气泡横在上面会挡住内容。
    say,
    // 读
    todosView,
    remindersView,
    pomodoroView,
    weatherView,
    // 桌宠天气效果选择器的数据（天气面板正文用；开关与选择不画在设置抽屉里）。
    weatherEffectView,
    // 查一次天气。天气插件的「查一下天气」按钮与 agent 的天气工具都靠它。
    fetchWeather,
    statusView,
    clipboardView,
    readClipboard,
    // 改
    addTodo,
    toggleTodo,
    clearDoneTodos,
    addReminder,
    removeReminder,
    startPomodoro,
    pausePomodoro,
    resumePomodoro,
    resetPomodoro,
    setWeatherCity,
    setWeatherEnabled,
    // 预览一阵桌宠天气特效（天气插件的「预览效果」按钮）。
    previewWeatherEffect,
    setHotAlertEnabled,
    setClipboardEnabled,
    // —— agent ——
    /**
     * agent 的工具表。
     *
     * 插件宿主用它注册**插件提供的工具**（规格 §5.4）：
     * 插件的清单声明一个工具、实例给出同名实现，宿主就把它挂进这张表。
     * 插件没开的，它声明的工具就不在表里——提示词里也就看不见。
     */
    agentTools: toolRegistry,
    /**
     * agent 的技能表。
     *
     * 插件宿主用它挂进**插件的技能说明**（渐进式披露）：
     * 插件的清单声明一个技能、正文在插件目录的 markdown 文件里，
     * 宿主就把它挂进这张表。系统提示词里只有名字与说明。
     */
    agentSkills: skillRegistry,
    /**
     * agent 的对外接口（插件用它反向提交任务、读历史、订阅事件）。
     *
     * 与 `agentTools` 是两回事：那是**工具表**（agent 用的），
     * 这是**接口**（插件用的）。
     */
    agent: agentFacade,
    // —— 对话 ——
    /** 和桌宠聊天（用户发起的）。 */
    chat,
    /** 一次性的模型调用（插件用：不进记录、不弹气泡、不出声）。 */
    complete,
    /** 聊天记录与长期记忆（插件界面用）。 */
    chatHistoryView,
    /** 清空聊天记录与长期记忆。 */
    clearChatHistory,
  };
}
