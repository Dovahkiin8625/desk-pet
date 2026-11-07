import { readJson, writeJson } from '../store.js';
import {
  DEFAULT_TTS,
  DEFAULT_LLM,
  DEFAULT_TAP_LINES,
  POMODORO_PRESETS,
  MAX_CHAT_FACTS,
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
      backend: str(raw.llm.backend, DEFAULT_LLM.backend).slice(0, 40),
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

  if (isPlainObject(raw.chat)) {
    // 聊天记录：磁盘上的文件是用户与旧版本写出来的，形状可能对不上——
    // 这里保证内存里的状态永远是合法的、也是有限的。
    // **按分类分路截断**（user/reply 留久、step 砍自己的尾巴），
    // 砍数组尾巴会把最老的用户输入挤掉，而那正是模型最需要的。
    const messages = (Array.isArray(raw.chat.messages) ? raw.chat.messages : [])
      .filter(
        (m) =>
          isPlainObject(m) &&
          (m.role === 'user' || m.role === 'assistant') &&
          str(m.text) !== ''
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

export async function loadAssistant(userDataDir) {  const raw = await readJson(userDataDir, FILE_NAME, null, FILE_NAME);
  return sanitizeAssistant(raw);
}

export async function saveAssistant(userDataDir, state) {
  const clean = sanitizeAssistant(state);
  await writeJson(userDataDir, FILE_NAME, clean);
  return clean;
}
