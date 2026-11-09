import { powerMonitor } from 'electron';
import { join } from 'node:path';
import {
  MESSAGE_KIND,
  POMODORO_PRESETS,
  TTS_HOSTS,
  LLM_BASE_URLS,
  DEFAULT_AGENT,
  TASK_STATUS,
  LAYER,
  chatKindOf,
} from '../../shared/assistant.js';
import { loadAssistant, saveAssistant, mergePatch, sanitizeAssistant } from './state.js';
import { loadApiKey, loadLlmApiKey } from '../credentials.js';
import * as clock from './clock.js';
import * as todos from './todos.js';
import * as reminders from './reminders.js';
import * as pomodoro from './pomodoro.js';
import * as systemStatus from './systemStatus.js';
import * as weather from './weather.js';
import { createClipboardWatcher, truncateClipboard } from './clipboard.js';
import { synthesizeCached } from './tts/minimax.js';
import { createTapTalk } from './tapTalk.js';
import { tapTalkNeedsPrewarm } from '../../shared/tapVoice.js';
import { createBackendRegistry } from './chat/backend.js';
import { createPlainBackend } from './chat/plain.js';
import { createAgentBackend } from './chat/agent.js';
import { createAck, ACK_HOLD_MS } from './chat/ack.js';
import { createReplyBubble } from './chat/stream.js';
import { createToolRegistry } from './agent/tools/registry.js';
import { createBuiltinTools } from './agent/tools/builtin.js';
import { createAgentFacade } from './agent/facade.js';
import { createAgentTasks } from './agent/tasks.js';
import { describeToolCall } from './agent/approval.js';
import { interruptedTasks, taskRecord } from './agent/record.js';
import { createInteractionBackend, INTERACTION_MAX_STEPS } from './layer/interaction.js';
import { createTaskTools } from './layer/taskTools.js';
import { runForeground, FALLBACK_NOTICE } from './layer/foreground.js';
import { buildSystemPrompt, buildChatMessages } from './chat/prompt.js';
import { mergeFacts } from './chat/memory.js';
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
  // 上次说「我好热」的时间：别每分钟喊一次。
  let lastHotAlertAt = 0;
  // 应用启动的时刻：主动搭话要等一段时间才开口。
  const appStartedAt = Date.now();
  // 用户最后一次说话的时刻：刚说完话就别插嘴。
  let lastUserMessageAt = 0;
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
  // （审批气泡只有一个，答复按 id 认——见 bubbleApproval.js）。
  let approvalSeq = 0;

  // 对话后端注册表。
  //
  // **前台恒定走交互层**（'interaction'，下面注册）：
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
  });
  toolRegistry.registerAll(
    createBuiltinTools({
      getWorkspace: () => state?.agent?.workspace || '',
      getTimeoutMs: () => state?.agent?.timeoutMs || DEFAULT_AGENT.timeoutMs,
      readClipboard: () => clipboardWatcher.readNow(),
      // 剪贴板助手默认关着：工具不能绕过用户这个开关。
      isClipboardEnabled: () => Boolean(state?.clipboard?.enabled),
      getAppIndex: () => getAppIndex?.() || null,
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
    getGate: () => null,
    getWorkspace: () => state?.agent?.workspace || '',
    getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
    getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
    getMaxSteps: () => state?.agent?.maxSteps || DEFAULT_AGENT.maxSteps,
    getPersona: () => state?.llm?.persona || {},
    getFacts: () => state?.chat?.facts || [],
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
      history: () => chatHistoryView().messages,
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
    // 问用户：审批气泡。气泡只有一只，挂着的审批会互相顶——
    // 所以每一次请求都要有自己的 id（inbox 按 id 认，见 bubbleApproval.js）。
    ask: ({ taskId, tool, args, risk }) =>
      bubble.showApproval({
        id: `${taskId}-${++approvalSeq}`,
        title: '需要你点头',
        text: describeToolCall(tool, args),
        risk,
      }),
    getMessages: (prompt) =>
      buildChatMessages({
        history: state?.chat?.messages || [],
        userText: prompt,
        trigger: 'user',
        // **执行层看不见派单记录**：它只管自己那件事，
        // 知道用户还派了别的任务反而分心（规格 §6）。
        layer: LAYER.EXECUTION,
      }),
    appendRecord: appendChatRecord,
    notify: ({ text, ok, taskId }) => {
      // 完成通知也是**桌宠说的话**：记成 reply，
      // 交互层下一轮要记得「刚才那件事做完了」（规格 §7.3）。
      //
      // **带上任务号**：页面要靠它把结果归回发起它的那一块——
      // 没有它，完成的答复就成了没来由的一句话。
      appendChatRecord({
        role: 'assistant',
        text: String(text || ''),
        at: Date.now(),
        proactive: false,
        meta: { taskId: String(taskId || ''), layer: LAYER.EXECUTION },
      });
      // **不带 interrupt**：用户正在说话或正在做决定时，完成通知要排队，
      // 不能把气泡顶掉（规格 §5.3）。
      //
      // **前台还在说话时更要等一等**：此刻答复气泡还没开（它在这一轮
      // 说完时才开），通知要是现在就冒出来，答复气泡一开就把正文清空，
      // 用户只看到「我去看看」，结果那句没了——白跑一趟。
      // 所以前台正在说话时先攒着，等这一轮说完了再交出去。
      const options = { emotion: ok ? 'happy' : 'sad', sound: ok ? 'success' : '' };
      if (chatBusy) {
        pendingNotices.push({ text, options });
        return;
      }
      say(text, options);
    },
    getMaxConcurrent: () => state?.agent?.maxConcurrent || DEFAULT_AGENT.maxConcurrent,
    getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
    getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
    logger: console,
  });

  // ------------------------------------------------------------------
  // 交互层：前台唯一跟用户说话的那一层（规格 §3）。
  //
  // **它不经过任务运行时**：交互层要秒级回应，
  // 排队等槽位会把「你好」变成「你好（排第 3 位）」。
  //
  // 耗时的事由它 `task.submit` 派成后台任务，
  // 由上面的 agentTasks 在后台跑（那是执行层）。
  // ------------------------------------------------------------------
  const interactionBackend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => toolRegistry,
    // 任务管理工具**每轮新建**：它们绑着这一轮的历史与配置。
    getTaskTools: (turn) =>
      createTaskTools({
        tasks: agentTasks,
        turn,
        dispatchEnabled: dispatchEnabled(),
        appendRecord: appendChatRecord,
        now: () => Date.now(),
      }),
    getDispatchEnabled: () => dispatchEnabled(),
    getPersona: () => state?.llm?.persona || {},
    getFacts: () => state?.chat?.facts || [],
    getNow: () => new Date(),
    getTaskCounts: () => agentTasks.counts(),
    getMaxSteps: () => INTERACTION_MAX_STEPS,
    // **这一回合的过程要落盘**：模型说了什么、调了什么快工具——
    // 聊天历史页靠它们还原过程。不接这一行，交互层在生产上一条记录都不写。
    appendRecord: appendChatRecord,
    logger: console,
  });
  backends.register('interaction', interactionBackend);

  /**
   * 能不能派单。
   *
   * **这里先一律返回 true**：设置里的「桌宠能做什么」是 Task 6 才接上的，
   * 那时再改成读 `state.agent.dispatch`。
   * （`state.agent.dispatch` 这个键在 Task 6 之前根本存不住——
   * 状态的清洗会把 `agent` 整块换掉，所以这时候读它只会读到 undefined。）
   */
  function dispatchEnabled() {
    return true;
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
      // 气泡优先摆哪边（'top' / 'bottom' / 'left' / 'right'）。
      // 点桌宠时用它把气泡摆在脚下——面板在头顶，两者不重叠。
      side = '',
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
        cacheDir,
      });
      while (pendingMessages.length > MAX_PENDING_MESSAGES) pendingMessages.shift();
      return;
    }
    if (showBubble) {
      bubble.show({ kind: MESSAGE_KIND.SAY, text: content, emotion, ttlMs, interrupt, side });
    }
    // 情绪与心情增量一起发过去：任务完成让桌宠也开心一点。
    if (emotion) onEmotion?.(emotion, mood);
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

  function startPomodoro(phase) {
    const isBreak = phase === pomodoro.PHASE.BREAK;
    const ms = isBreak ? POMODORO_PRESETS.break : POMODORO_PRESETS.focus;
    state.pomodoro = pomodoro.start(
      state.pomodoro,
      isBreak ? pomodoro.PHASE.BREAK : pomodoro.PHASE.FOCUS,
      ms
    );
    scheduleSave();
    return act({
      emotion: 'happy',
      sound: 'success',
      message: isBreak ? '开始休息，5 分钟' : '开始专注，25 分钟',
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
    return {
      phase: p.phase,
      text: pomodoro.pomodoroText(p, now),
      running: p.phase === pomodoro.PHASE.FOCUS || p.phase === pomodoro.PHASE.BREAK,
      paused: p.phase === pomodoro.PHASE.PAUSED,
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
    const thermal = safeThermalState();
    const onBattery = safeOnBattery();
    return {
      text: systemStatus.formatStatus({ cpu, memory, thermal, onBattery }),
      cpu,
      memory,
      thermal,
      thermalText: systemStatus.thermalText(thermal),
      onBattery,
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

    // 前台**恒定**走交互层（规格 §3）：
    // 它能调工具、能派单，而且模型不支持工具调用时会自动退回普通对话。
    const backend = backends.get('interaction');
    if (!backend) return { ok: false, message: '没有可用的对话后端' };

    const token = ++chatSeq;
    chatBusy = true;

    // 上下文要用**还没加上这句话**的历史：
    // buildChatMessages 自己会把当前这句话放到最后，
    // 历史里再带一遍的话，模型会看到同一句话出现两次。
    const history = state.chat.messages;
    const system = buildSystemPrompt({
      persona: state.llm.persona,
      facts: state.chat.facts,
    });
    const messages = buildChatMessages({
      history,
      userText: content,
      trigger,
      // 上下文按**交互层**过滤：它看得见自己派过什么（dispatch），
      // 看不见任务与步骤那些「给人看的」记录（规格 §6）。
      layer: LAYER.INTERACTION,
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
        interaction: backend,
        plain: backends.get('chat'),
        ctx: {
          system,
          messages,
          // 这一句的原话：派单时执行层要拿到「派单那一刻的对话」。
          prompt: content,
          trigger,
          config,
          // **这一轮的历史快照**（还没追加当前这句话的那份）：
          // 派单时执行层要读最近几条 user/reply。
          turn: { history, userText: content, config },
          onDelta: (delta) => {
            if (!delta) return;
            // 有可见正文了：不必再应一声。
            ack.noteText();
            reply?.push(delta);
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

    // 答案好了：应答要么还没轮到（那就不必应了），要么正在念（那就等它念完）。
    ack.release();
    await ack.whenReady();
    if (token !== chatSeq) return { ok: false, message: '这一轮被新的对话取代了' };
    reply?.open();
    reply?.finish({ text: result.text, emotion: result.emotion });

    // 这一轮说完了：**这时才把攒着的完成通知交出去**。
    // （答复气泡开着，气泡自己会把通知排上队——用户先读答复，再看结果。）
    // 清标记也挪到这里：答复还没上屏的时候，主动搭话别插进来。
    chatBusy = false;
    flushPendingNotices();

    // 记下这一轮。
    appendChatRecord({
      role: 'assistant',
      text: result.text,
      at: Date.now(),
      proactive: trigger === 'proactive',
      // **轮数与模型名**：页面上那行「问模型 X · N 轮」读的是它。
      // 轮数取后端返回的步数——数 model 记录条数会把「退回普通对话」那种轮算漏。
      meta: {
        rounds: Number(result.steps) || 0,
        model: String(config.model || ''),
      },
    });
    if (result.memories?.length) {
      state.chat.facts = mergeFacts(state.chat.facts, result.memories);
    }
    // 探测出来的可用地址记下来：下次先用它（照 tts.host 的做法）。
    if (result.baseUrl && result.baseUrl !== state.llm.lastWorkingBaseUrl) {
      state.llm.lastWorkingBaseUrl = result.baseUrl;
    }
    scheduleSave();

    // 情绪**立刻**生效（哪怕桌宠藏着——回复是刚刚发生的）。
    onEmotion?.(result.emotion, result.mood);
    // 念出来，但**不要**再弹一个气泡（回复已经流式显示在气泡里了），
    // 也不重复施加情绪（say() 会再施加一次，那会把心情加两遍）。
    say(result.text, { speak: true, showBubble: false });

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

  // ------------------------------------------------------------------
  // 主循环
  // ------------------------------------------------------------------

  function tick() {
    const now = Date.now();

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

    // 主动搭话：条件最多、优先级最低——它只是「锦上添花」，
    // 绝不能挤掉提醒和报时。
    maybeProactive(now);
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
      const next = mergePatch(state, patch || {});
      // `llm` 里的 persona / proactive 要**深一层**合并：
      // 设置窗口只会送来用户能改的那几个字段，
      // 浅合并会把「上次搭话时间」「连续失败次数」这些内部状态抹掉。
      if (patch?.llm && typeof patch.llm === 'object') {
        next.llm = {
          ...state.llm,
          ...patch.llm,
          persona: { ...state.llm.persona, ...(patch.llm.persona || {}) },
          proactive: { ...state.llm.proactive, ...(patch.llm.proactive || {}) },
        };
      }
      state = sanitizeAssistant(next);
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
     * agent 的对外接口（插件用它反向提交任务、读历史、订阅事件）。
     *
     * 与 `agentTools` 是两回事：那是**工具表**（agent 用的），
     * 这是**接口**（插件用的）。
     */
    agent: agentFacade,
    // —— 对话 ——
    /** 和桌宠聊天（用户发起的）。 */
    chat,
    /** 聊天记录与长期记忆（插件界面用）。 */
    chatHistoryView,
    /** 清空聊天记录与长期记忆。 */
    clearChatHistory,
  };
}
