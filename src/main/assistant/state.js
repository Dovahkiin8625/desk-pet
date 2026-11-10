import { readJson, writeJson } from '../store.js';
import {
  DEFAULT_TTS,
  DEFAULT_LLM,
  DEFAULT_AGENT,
  DEFAULT_TAP_LINES,
  POMODORO_PRESETS,
  MAX_CHAT_FACTS,
  DISPATCH_MODES,
  APPROVAL_POLICIES,
  THINK_LEVELS,
  MAX_ACK_DELAY_MS,
  hasChatKind,
} from '../../shared/assistant.js';
import { normalizeChatEntry, truncateByKind } from './chat/memory.js';
import { createPomodoroState } from './pomodoro.js';
import { DEFAULT_VOLUME } from '../../shared/volume.js';
import { MAX_TAP_LINES, MAX_TAP_LINE_LENGTH } from '../../shared/tapVoice.js';

const FILE_NAME = 'assistant.json';

/**
 * 助理状态的默认值。
 *
 * 天气与剪贴板助手**默认关闭**：它们要联网或读用户的剪贴板，
 * 不该在用户没要求的时候就开始。
 * 大模型对话同理：它要花钱、要联网。
 */
export const DEFAULT_ASSISTANT = Object.freeze({
  version: 1,
  todos: [],
  reminders: [],
  pomodoro: createPomodoroState(),
  weather: { enabled: false, city: '', last: null },
  clipboard: { enabled: false },
  chime: { enabled: true },
  greeting: { enabled: true },
  // sound.volume 是**总音量**：提示音与桌宠说话共用一个值。
  sound: { enabled: true, volume: DEFAULT_VOLUME },
  hotAlert: { enabled: true },
  // 点桌宠时说的话。
  // `modelSound` 默认**关**：模型自带的声音要用户自己点名才加进随机池。
  tapTalk: {
    enabled: true,
    modelSound: false,
    lines: [...DEFAULT_TAP_LINES],
  },
  tts: { ...DEFAULT_TTS },
  llm: structuredClone(DEFAULT_LLM),
  // agent 的设置：设置界面要到 L6 才做（T18），
  // 但工作区与工具超时现在就要用（内置工具从这儿取）。
  agent: structuredClone(DEFAULT_AGENT),
  chat: { messages: [], facts: [] },
});

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 把任意输入规整为合法的助理状态；非法值一律回退默认值，绝不抛错。
 *
 * 与 sanitizeSettings 同样的思路：磁盘上的文件是**用户与旧版本**写出来的，
 * 形状可能对不上；这里要保证内存里的状态永远是合法的。
 */
export function sanitizeAssistant(raw) {
  if (!isPlainObject(raw)) return structuredClone(DEFAULT_ASSISTANT);

  const out = structuredClone(DEFAULT_ASSISTANT);

  if (Array.isArray(raw.todos)) {
    out.todos = raw.todos
      .filter((t) => isPlainObject(t) && typeof t.id === 'string' && t.id !== '')
      .map((t) => ({
        id: t.id,
        text: str(t.text).slice(0, 200),
        done: Boolean(t.done),
        createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
      }));
  }

  if (Array.isArray(raw.reminders)) {
    out.reminders = raw.reminders
      .filter((r) => isPlainObject(r) && typeof r.id === 'string' && r.id !== '')
      .filter((r) => Number.isFinite(r.at))
      .map((r) => ({
        id: r.id,
        text: str(r.text).slice(0, 200),
        at: r.at,
        createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
        fired: Boolean(r.fired),
      }));
  }

  if (isPlainObject(raw.pomodoro)) {
    const p = raw.pomodoro;
    const phase = ['idle', 'focus', 'break', 'paused'].includes(p.phase) ? p.phase : 'idle';
    out.pomodoro = {
      phase,
      endsAt: Number.isFinite(p.endsAt) ? p.endsAt : null,
      remainingMs: clampNumber(p.remainingMs, 0, 24 * 3600 * 1000, POMODORO_PRESETS.focus),
      durationMs: clampNumber(p.durationMs, 0, 24 * 3600 * 1000, POMODORO_PRESETS.focus),
      label: str(p.label).slice(0, 100),
      // 暂停的是哪一段：暂停时记下来，继续时才知道回到专注还是休息。
      pausedPhase: ['focus', 'break'].includes(p.pausedPhase) ? p.pausedPhase : 'idle',
    };
  }

  if (isPlainObject(raw.weather)) {
    out.weather = {
      enabled: Boolean(raw.weather.enabled),
      city: str(raw.weather.city).slice(0, 60),
      last: isPlainObject(raw.weather.last) ? raw.weather.last : null,
    };
  }
  if (isPlainObject(raw.clipboard)) out.clipboard = { enabled: Boolean(raw.clipboard.enabled) };
  if (isPlainObject(raw.chime)) out.chime = { enabled: Boolean(raw.chime.enabled) };
  if (isPlainObject(raw.greeting)) out.greeting = { enabled: Boolean(raw.greeting.enabled) };
  if (isPlainObject(raw.sound)) {
    out.sound = {
      enabled: Boolean(raw.sound.enabled),
      // 总音量：提示音与语音共用。夹进 [0,1]，非法值回退默认。
      volume: clampNumber(raw.sound.volume, 0, 1, DEFAULT_ASSISTANT.sound.volume),
    };
  }
  if (isPlainObject(raw.hotAlert)) out.hotAlert = { enabled: Boolean(raw.hotAlert.enabled) };

  if (isPlainObject(raw.tapTalk)) {
    // 台词：类型不对就退回默认；太长的截断；重复的只留第一句。
    const rawLines = Array.isArray(raw.tapTalk.lines) ? raw.tapTalk.lines : null;
    const lines =
      rawLines === null
        ? [...DEFAULT_TAP_LINES]
        : rawLines
            .filter((l) => typeof l === 'string')
            .map((l) => l.trim().slice(0, MAX_TAP_LINE_LENGTH))
            .filter(Boolean)
            .filter((l, i, arr) => arr.indexOf(l) === i)
            .slice(0, MAX_TAP_LINES);
    out.tapTalk = {
      // 字段缺了（老版本写出来的文件）就沿用默认值——
      // 「点桌宠时说话」默认是**开**的，Boolean(undefined) 会把它关掉。
      enabled:
        raw.tapTalk.enabled === undefined ? out.tapTalk.enabled : Boolean(raw.tapTalk.enabled),
      modelSound: Boolean(raw.tapTalk.modelSound),
      lines,
    };
  }

  if (isPlainObject(raw.tts)) {
    out.tts = {
      enabled: Boolean(raw.tts.enabled),
      model: str(raw.tts.model, DEFAULT_TTS.model) || DEFAULT_TTS.model,
      voiceId: str(raw.tts.voiceId, DEFAULT_TTS.voiceId),
      speed: clampNumber(raw.tts.speed, 0.5, 2, DEFAULT_TTS.speed),
      vol: clampNumber(raw.tts.vol, 0.1, 10, DEFAULT_TTS.vol),
      pitch: clampNumber(raw.tts.pitch, -12, 12, DEFAULT_TTS.pitch),
      host: str(raw.tts.host),
    };
  }

  if (isPlainObject(raw.llm)) {
    const persona = isPlainObject(raw.llm.persona) ? raw.llm.persona : {};
    const proactive = isPlainObject(raw.llm.proactive) ? raw.llm.proactive : {};
    out.llm = {
      enabled: Boolean(raw.llm.enabled),
      baseUrl: str(raw.llm.baseUrl, DEFAULT_LLM.baseUrl).slice(0, 300),
      model: str(raw.llm.model, DEFAULT_LLM.model).slice(0, 100),
      temperature: clampNumber(raw.llm.temperature, 0, 2, DEFAULT_LLM.temperature),
      maxTokens: Math.round(
        clampNumber(raw.llm.maxTokens, 64, 4096, DEFAULT_LLM.maxTokens)
      ),
      // 两个字段不能同时发，所以只认这两个值。
      maxTokensField:
        raw.llm.maxTokensField === 'max_completion_tokens'
          ? 'max_completion_tokens'
          : 'max_tokens',
      // think 模式与深度：深度只认三个档位，认不出来当「中」。
      think: Boolean(raw.llm.think),
      thinkLevel: THINK_LEVELS.includes(raw.llm.thinkLevel)
        ? raw.llm.thinkLevel
        : DEFAULT_LLM.thinkLevel,
      // 「先应一声」：关掉就一直等答案；等待时长夹在 [0, 5000]。
      // 字段缺了（老版本写出来的文件）沿用默认值——
      // Boolean(undefined) 是 false，会把默认开启的应答关掉。
      ackEnabled:
        raw.llm.ackEnabled === undefined
          ? out.llm.ackEnabled
          : Boolean(raw.llm.ackEnabled),
      ackDelayMs: Math.round(
        clampNumber(raw.llm.ackDelayMs, 0, MAX_ACK_DELAY_MS, DEFAULT_LLM.ackDelayMs)
      ),
      lastWorkingBaseUrl: str(raw.llm.lastWorkingBaseUrl).slice(0, 300),
      persona: {
        name: str(persona.name, DEFAULT_LLM.persona.name).slice(0, 40),
        style: str(persona.style, DEFAULT_LLM.persona.style).slice(0, 300),
        backstory: str(persona.backstory).slice(0, 1000),
      },
      proactive: {
        enabled: Boolean(proactive.enabled),
        minIntervalMs: Math.round(
          clampNumber(
            proactive.minIntervalMs,
            5 * 60 * 1000,
            24 * 3600 * 1000,
            DEFAULT_LLM.proactive.minIntervalMs
          )
        ),
        lastAt: Number.isFinite(proactive.lastAt) ? proactive.lastAt : 0,
        nextAttemptAt: Number.isFinite(proactive.nextAttemptAt) ? proactive.nextAttemptAt : 0,
        consecutiveFailures: Number.isFinite(proactive.consecutiveFailures)
          ? Math.max(0, Math.round(proactive.consecutiveFailures))
          : 0,
      },
    };
  }

  if (isPlainObject(raw.agent)) {
    // agent 的设置：磁盘上的值可能离谱（并发 9999、超时 1 毫秒），
    // 夹一遍——这些值会直接决定「几个任务同时跑」与「工具多久算超时」。
    const approval = isPlainObject(raw.agent.approval) ? raw.agent.approval : {};
    const tools = isPlainObject(raw.agent.tools) ? raw.agent.tools : {};
    out.agent = {
      maxConcurrent: Math.round(
        clampNumber(raw.agent.maxConcurrent, 1, 8, DEFAULT_AGENT.maxConcurrent)
      ),
      maxSteps: Math.round(clampNumber(raw.agent.maxSteps, 1, 100, DEFAULT_AGENT.maxSteps)),
      workspace: str(raw.agent.workspace).slice(0, 500),
      timeoutMs: Math.round(
        clampNumber(raw.agent.timeoutMs, 1000, 30 * 60 * 1000, DEFAULT_AGENT.timeoutMs)
      ),
      maxTokensPerTask: Math.round(
        clampNumber(raw.agent.maxTokensPerTask, 0, 10_000_000, DEFAULT_AGENT.maxTokensPerTask)
      ),
      approval: {
        policy: APPROVAL_POLICIES.includes(approval.policy)
          ? approval.policy
          : DEFAULT_AGENT.approval.policy,
        // 永久放行的工具名：去重、去空。
        allowAlways: [
          ...new Set(
            (Array.isArray(approval.allowAlways) ? approval.allowAlways : []).filter(
              (name) => typeof name === 'string' && name !== ''
            )
          ),
        ],
      },
      tools: {
        // 被关掉的工具名：去重、去空。
        disabled: [
          ...new Set(
            (Array.isArray(tools.disabled) ? tools.disabled : []).filter(
              (name) => typeof name === 'string' && name !== ''
            )
          ),
        ],
      },
    };
  }

  // 派单模式：**放在 agent 那段之外**——
  // 那一段会整体替换 out.agent，放进去就被覆盖了。
  // 而且老用户可能压根没有 agent 段（那是 L3 才加的），
  // 这时候派单模式要从 llm.backend 迁过来。
  //
  // **只传 raw**：不传第二参数。
  // agent 那段刚把 out.agent 整体换掉了，里面并没有 dispatch 这个键，
  // 所以 out.agent.dispatch 此刻是 undefined——
  // 拿它当兜底，认不出来时就会写成 undefined（而不是 'auto'）。
  // migrateDispatch 自己的默认参数就是 DEFAULT_AGENT.dispatch。
  out.agent.dispatch = migrateDispatch(raw);

  if (isPlainObject(raw.chat)) {
    // 聊天记录：磁盘上的文件是用户与旧版本写出来的，形状可能对不上——
    // 这里保证内存里的状态永远是合法的、也是有限的。
    // **按分类分路截断**（user/reply 留久、step 砍自己的尾巴），
    // 砍数组尾巴会把最老的用户输入挤掉，而那正是模型最需要的。
    const messages = (Array.isArray(raw.chat.messages) ? raw.chat.messages : [])
      .filter(
        (m) =>
          isPlainObject(m) &&
          // 关卡认 **kind**（新契约），也认旧的 role：
          // 只写 kind 的新记录不能被静默丢掉，
          // 既没 kind 也没 role 的坏数据要丢掉（宁可少一条，也不要错的）。
          (hasChatKind(m) || m.role === 'user' || m.role === 'assistant') &&
          // 正文空但 meta 有内容的记录要留下：
          // 「工具调了但没有可展示的正文」是步骤记录的正常形态。
          (str(m.text) !== '' || (isPlainObject(m.meta) && Object.keys(m.meta).length > 0))
      )
      .map((m) => normalizeChatEntry({ ...m, text: str(m.text).slice(0, 2000) }));
    out.chat.messages = truncateByKind(messages);

    const facts = (Array.isArray(raw.chat.facts) ? raw.chat.facts : [])
      .filter((f) => typeof f === 'string')
      .map((f) => f.trim().slice(0, 200))
      .filter(Boolean);
    // 去重：模型很容易反复报告同一件事。
    out.chat.facts = [...new Set(facts)].slice(-MAX_CHAT_FACTS);
  }

  if (typeof raw.version === 'number') out.version = raw.version;
  return out;
}

/**
 * 把一份补丁合并进状态。
 *
 * **必须深一层**：设置窗口送来的 `tts` 只有 `{enabled, voiceId, speed}` 三个字段，
 * 浅合并会把 `model`/`vol`/`pitch`/`host` 一并抹掉——
 * 其中 `host` 是探测出来的可用域名，抹掉就得重新探测一遍。
 */
export function mergePatch(state, patch) {
  const next = { ...state };
  for (const [key, value] of Object.entries(patch || {})) {
    const current = next[key];
    const bothPlainObjects =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current);
    next[key] = bothPlainObjects ? { ...current, ...value } : value;
  }
  return next;
}

/**
 * 把一份设置补丁合并进状态。
 *
 * 与 mergePatch 的区别：**agent.approval 深一层**。
 * 审批是两组东西——档位与「永久放行的工具名单」，
 * 浅合并会把名单整个换掉（只改了个档位，名单就没了）。
 */
export function mergeAssistantPatch(state, patch) {
  const next = mergePatch(state, patch || {});
  if (patch?.agent && typeof patch.agent === 'object') {
    next.agent = {
      ...state.agent,
      ...patch.agent,
      approval: { ...(state.agent?.approval || {}), ...(patch.agent.approval || {}) },
      tools: { ...(state.agent?.tools || {}), ...(patch.agent.tools || {}) },
    };
  }
  return next;
}

export async function loadAssistant(userDataDir) {  const raw = await readJson(userDataDir, FILE_NAME, null, FILE_NAME);
  return sanitizeAssistant(raw);
}

export async function saveAssistant(userDataDir, state) {
  const clean = sanitizeAssistant(state);
  await writeJson(userDataDir, FILE_NAME, clean);
  return clean;
}

/**
 * 把老配置里的 `llm.backend` 迁成 `agent.dispatch`（规格 §10.3）。
 *
 * - `llm.backend === 'agent'` → 'auto'（以前能动手，现在能派单）；
 * - `llm.backend === 'chat'`  → 'off'（保守：不给老用户平白发一个新能力）；
 * - 整个文件里没有 llm 段（新装）→ 用默认值 'auto'。
 *
 * **已经写过 dispatch 的就认它**——那是用户自己（或新版）写下的。
 *
 * @param {object} raw 磁盘上的原始状态
 * @param {string} fallback 默认值（认不出来时用它）
 */
export function migrateDispatch(raw, fallback = DEFAULT_AGENT.dispatch) {
  if (isPlainObject(raw?.agent) && DISPATCH_MODES.includes(raw.agent.dispatch)) {
    return raw.agent.dispatch;
  }
  if (!isPlainObject(raw?.llm)) return fallback;
  const backend = raw.llm.backend;
  // **没有 backend 这个键**：这是新版写出来的文件（后端已退役），
  // 用户没选过派单模式 → 用默认值。
  if (backend === undefined) return fallback;
  // 老配置里只有 agent / chat 两种，认不出来的当 chat（保守）。
  return backend === 'agent' ? 'auto' : 'off';
}
