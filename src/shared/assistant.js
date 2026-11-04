/**
 * 主进程与渲染层共用的助理契约。
 *
 * 气泡消息的形状放在这里：主进程负责**造**消息，
 * 气泡窗口负责**画**它——两边对「一条消息长什么样」的理解必须一致，
 * 所以定义只有一份。
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

/** 聊天记录在磁盘上最多留多少条。 */
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
