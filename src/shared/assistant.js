/**
 * 主进程与渲染层共用的助理契约。
 *
 * 气泡消息的形状放在这里：主进程负责**造**消息，
 * 气泡窗口负责**画**它——两边对「一条消息长什么样」的理解必须一致，
 * 所以定义只有一份。
 *
 * 聊天记录的**分类**也放在这里：它同样是「主进程写、界面读」的东西，
 * 定义只有一份，两边才不会各认一套 kind。
 */

/**
 * 气泡消息的形态。
 *
 * `say` 是普通的一句话；`chat` 是 AI 对话的回复——
 * 它会**流式增长**（逐字冒出来），所以气泡要能在流式期间反复改变尺寸。
 */
export const MESSAGE_KIND = Object.freeze({
  /** 一句话：显示若干秒后自动消失。 */
  SAY: 'say',
  /** 对话回复：流式显示，定稿后才开始计时自动消失。 */
  CHAT: 'chat',
});

/** 气泡消息的默认显示时长（毫秒）。 */
export const DEFAULT_TTL_MS = 6000;

/**
 * MiniMax TTS 的接口域名探测顺序。
 *
 * `minimaxi` = 中国大陆，`minimax` = 国际；`.chat` 是旧版平台
 * （旧版要 GroupId，当前平台只认 Bearer）。
 * 不写死一个域名：同一个 key 在不同账号下能用的域名不一定相同，
 * 探测一次、把能用的那个记下来，下次直接用。
 */
export const TTS_HOSTS = Object.freeze([
  'https://api.minimaxi.com',
  'https://api.minimax.io',
  'https://api.minimaxi.chat',
  'https://api.minimax.chat',
]);

/**
 * 大模型（OpenAI 兼容协议）的接口地址探测顺序。
 *
 * **只列现代平台**：`.chat` 是旧平台，它的对话接口要 GroupId，
 * 与 OpenAI 兼容协议不是一回事——混用正是 401/1004 的头号成因。
 *
 * 地址末尾的 `/v1` 是 OpenAI 兼容的惯例：`base_url` 指向 `/v1`，
 * 客户端自己拼 `/chat/completions`。
 *
 * key 是**分区域**的：大陆的 key 在国际域名上会鉴权失败。
 * 所以这里必须探测，不能写死一个。
 */
export const LLM_BASE_URLS = Object.freeze([
  'https://api.minimaxi.com/v1',
  'https://api.minimax.io/v1',
]);

/**
 * 可选的大模型对话后端。
 *
 * 'chat' 是普通对话（一次调用、一段回复，见 src/main/assistant/chat/plain.js）；
 * 'agent' 是多步循环（会调工具，见 src/main/assistant/chat/agent.js）。
 *
 * **定义只有一份**：状态清洗、后端注册、设置界面都从这儿取——
 * 两边各认一套的话，用户改了设置却没生效，是最难查的那种 bug。
 */
export const LLM_BACKENDS = Object.freeze(['chat', 'agent']);

/** TTS 的默认偏好。 */
export const DEFAULT_TTS = Object.freeze({
  enabled: false,
  model: 'speech-02-hd',
  voiceId: 'female-shaonv',
  speed: 1,
  vol: 1,
  pitch: 0,
  // 探测到的可用域名；空表示还没探测过。
  host: '',
});

/**
 * 点桌宠时桌宠默认念的台词。
 *
 * 用户可以在设置窗口里改（每行一句），这里是出厂的那几句——
 * 选的都是**短句**：太长的句子合成出来慢，念完也拖沓。
 */
export const DEFAULT_TAP_LINES = Object.freeze([
  '今天也要加油哦～',
  '在的在的，有什么事吗？',
  '嘿嘿，被你发现啦',
  '摸摸头，充电完成！',
  '别一直点我啦，痒痒的',
  '我在这里陪着你呢',
  '要休息一下吗？',
  '工作顺利的话，夸夸我～',
]);

/**
 * 大模型对话的默认配置。
 *
 * `enabled` 默认关：它要花钱、要联网，
 * 不该在用户没要求的时候就开始（与天气、剪贴板助手一个道理）。
 */
export const DEFAULT_LLM = Object.freeze({
  enabled: false,
  baseUrl: 'https://api.minimaxi.com/v1',
  // 模型名以 MiniMax 控制台的模型列表为准——它变得很快，
  // 而且「模型名写错」与「这个模型没给本账号开通」返回的是同一个错。
  model: 'MiniMax-Text-01',
  temperature: 0.7,
  maxTokens: 800,
  // `max_tokens` 与 `max_completion_tokens` **不能同时发**
  // （有的服务端遇到不认识的字段直接 400），所以做成可配置。
  maxTokensField: 'max_tokens',
  // 用哪个后端（见 src/main/assistant/chat/backend.js 的注册表）。
  // 将来加 agent 后端时，这里换一个 id 就行。
  backend: 'chat',
  // 探测出来的可用地址；空表示还没探测过。
  lastWorkingBaseUrl: '',
  /** 人设：写进系统提示词。 */
  persona: {
    name: '小桌',
    style: '活泼、亲切，偶尔犯困',
    backstory: '',
  },
  /** 主动搭话：默认关（会花钱，而且太频繁会被立刻关掉）。 */
  proactive: {
    enabled: false,
    minIntervalMs: 30 * 60 * 1000,
    lastAt: 0,
    nextAttemptAt: 0,
    consecutiveFailures: 0,
  },
});

/**
 * agent 的默认配置（规格 §11）。
 *
 * 这些字段是 L1 先落地的**状态**——设置界面要到 L6 才做（T18），
 * 但工具（工作区、单次工具超时）现在就要用它们。
 *
 * `workspace` 空 = 用户主目录：agent 总得有个起点。
 */
export const DEFAULT_AGENT = Object.freeze({
  /** 同时跑几个后台任务。 */
  maxConcurrent: 1,
  /** 一个任务最多走几步。 */
  maxSteps: 20,
  /** 工作目录（空 = 用户主目录）。 */
  workspace: '',
  /** 单个工具调用的超时（毫秒）。 */
  timeoutMs: 120000,
  /** 单任务 token 上限（0 = 不限）。 */
  maxTokensPerTask: 0,
  /** 审批闸门。 */
  approval: {
    /** auto（全部放行）/ graded（只读放行）/ manual（全部要确认）。 */
    policy: 'graded',
    /** 永久放行的工具名。 */
    allowAlways: [],
  },
});

/**
 * 渲染层接受的情绪**标签**。
 *
 * 与 `src/renderer/pet/emotion.js` 的 `EMOTION_EXPRESSION` 的键一致——
 * 注意这是**标签**（`neutral`）而不是清单里的语义键（`normal`）：
 * 主进程发错一个词，表情就会**静默地**不生效（decisions.md #49）。
 */
export const EMOTIONS = Object.freeze([
  'neutral',
  'happy',
  'shy',
  'surprised',
  'sad',
  'angry',
  'tired',
]);

/**
 * 磁盘上 user / reply **每一路**最多留多少条。
 *
 * 不是「总共留多少条」——磁盘上的总条数是分路各算的
 * （见 `CHAT_KIND_LIMITS`：user/reply 各 40，step 200，task/approval 各 100）。
 */
export const MAX_CHAT_MESSAGES = 40;

/** 长期记忆（模型抽取的「事实」）最多留多少条。 */
export const MAX_CHAT_FACTS = 50;

/** 每次发给模型的上下文最多带多少条消息。 */
export const PROMPT_HISTORY_MESSAGES = 12;

/** 番茄钟的两种时长（毫秒）。 */
export const POMODORO_PRESETS = Object.freeze({
  focus: 25 * 60 * 1000,
  break: 5 * 60 * 1000,
});

/**
 * 聊天记录的分类。
 *
 * agent 之后，记录里会混进工具调用日志、审批请求、任务状态——
 * 它们是**给人看的**，绝不能进模型的上下文。
 * 所以每条记录都要带一个 `kind`，把「给人看的」与「给模型看的」分开。
 *
 * 规格见 docs/superpowers/specs/2026-11-07-agent-runtime-design.md §4.2。
 */
export const CHAT_KIND = Object.freeze({
  /** 用户说的话。 */
  USER: 'user',
  /** 桌宠的回复（普通对话的结论，或 agent 的最终答复）。 */
  REPLY: 'reply',
  /** 任务状态变化：排队 / 开始 / 完成 / 失败 / 取消。 */
  TASK: 'task',
  /** 任务中的一次步骤：模型决定、工具调用、工具结果。 */
  STEP: 'step',
  /** 审批请求与用户的选择。 */
  APPROVAL: 'approval',
});

/**
 * 每类记录在磁盘上最多留多少条。
 *
 * **按类分路，不是一个总上限**：user/reply 要留得久（模型要看），
 * step 增长极快（几步就几条）——一个总上限会让一条新步骤把最老的用户输入挤掉，
 * 而模型恰恰最需要那几条用户输入。
 */
export const CHAT_KIND_LIMITS = Object.freeze({
  user: MAX_CHAT_MESSAGES,
  reply: MAX_CHAT_MESSAGES,
  step: 200,
  task: 100,
  approval: 100,
});

/** 哪些分类会进模型的上下文（其它一律不进）。 */
export const CHAT_KIND_FOR_MODEL = Object.freeze([CHAT_KIND.USER, CHAT_KIND.REPLY]);

/**
 * 取一条记录的分类。
 *
 * **旧记录没有 `kind`**（用户升级前的数据），按 `role` 兜底：
 * `user` → user，其余 → reply。判断不了的一律当 reply（宁可多给模型一点，
 * 也不要凭空丢掉用户说过的话）。
 */
export function chatKindOf(entry) {
  const kind = String(entry?.kind || '').trim();
  if (Object.values(CHAT_KIND).includes(kind)) return kind;
  return entry?.role === 'user' ? CHAT_KIND.USER : CHAT_KIND.REPLY;
}

/**
 * 工具的风险等级。
 *
 * 风险等级决定「要不要用户点头」：
 * 只读自动放行，写与执行要确认（规格 §8.1 的 graded 策略）。
 *
 * 放在 shared 里是因为**插件清单也要用它**——
 * 插件在清单里声明 `risk: 'read'`，宿主与插件作者得认同一套取值。
 */
export const TOOL_RISK = Object.freeze({
  /** 只读：读文件、列目录、搜索、读剪贴板、查状态。 */
  READ: 'read',
  /** 写入：写文件、改配置。 */
  WRITE: 'write',
  /** 执行：跑命令、启动程序、启动外部进程。 */
  EXEC: 'exec',
});

/** 风险从轻到重的顺序：取「更严格者」时用它比较。 */
export const TOOL_RISK_ORDER = Object.freeze([TOOL_RISK.READ, TOOL_RISK.WRITE, TOOL_RISK.EXEC]);

/**
 * 工具名的形状：小写字母数字，点号分段。
 *
 * 工具名是**全局唯一**的标识（`fs.read` / `shell.exec` / `weather.get`），
 * 段之间用点：谁提供的不写在名字里（插件的工具也可能叫 `weather.get`），
 * 但前缀能让人一眼看出这是哪一类能力。
 */
export const TOOL_NAME_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

/**
 * 一条记录有没有**明确的**分类。
 *
 * 与 `chatKindOf` 的区别：后者永远给出一个合法 kind（按 role 兜底），
 * 这个回答的是「这条数据自己说了自己是哪一类吗」——
 * 写盘关口用它区分「形状不对」与「合法但没写 role」。
 */
export function hasChatKind(entry) {
  const kind = String(entry?.kind || '').trim();
  return Object.values(CHAT_KIND).includes(kind);
}
