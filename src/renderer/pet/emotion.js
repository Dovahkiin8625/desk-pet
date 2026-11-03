import { resolveExpressionName } from './manifest.js';

/**
 * 情绪系统：心情值 → 语义情绪 → 模型自己的表情名。
 *
 * 这一层是**叠加**在 spec §5.1 的交互反应之上的，不是替换：
 * 摸头仍然是「表情 happy + 动作 tapHead」（既有 e2e 依赖这一点），
 * 情绪系统只负责「持续的心情」与「没有区域反应时该摆什么脸」。
 *
 * 语义键一律走清单（pet.json）解析：**没有映射就不套表情**（spec §4.4）。
 * 这里绝不按序号猜、也不按可用表情列表取第一个——
 * Natori 的表情表第一项是 Angry，猜错的后果是「摸头挂着一张生气的脸」。
 */

/** 心情值的取值范围。 */
export const MOOD_RANGE = Object.freeze({ min: -100, max: 100 });

/** 语义情绪 → 清单里的表情语义键。 */
export const EMOTION_EXPRESSION = Object.freeze({
  neutral: 'normal',
  happy: 'happy',
  shy: 'shy',
  surprised: 'surprised',
  sad: 'sad',
  angry: 'angry',
  tired: 'tired',
});

/** 应用会触发的事件。 */
export const EVENT = Object.freeze({
  TAP_HEAD: 'tap-head',
  TAP_BODY: 'tap-body',
  DRAG_START: 'drag-start',
  DRAG_END: 'drag-end',
  PRAISE: 'praise',
  SPEAK: 'speak',
  TODO_DONE: 'todo-done',
  REMINDER: 'reminder',
  ALARM: 'alarm',
  OVERHEAT: 'overheat',
  SPAM: 'spam',
  IDLE_LONG: 'idle-long',
  TIMEOUT: 'timeout',
});

/**
 * 每个事件怎么改心情、摆什么脸。
 *
 * `express` 表示「这个事件**现在**就把表情换上」。
 * 点击头/身不设 express：spec §5.1 已经给这两个动作指定了表情
 * （摸头 happy、点击身体 smile），情绪系统不该去覆盖它——
 * 情绪系统只在这两个动作之外接管表情。
 *
 * `mood` 是心情值的增量：正数更开心，负数更糟。
 */
const RULES = {
  [EVENT.TAP_HEAD]: { mood: 12, emotion: 'happy', express: false },
  [EVENT.TAP_BODY]: { mood: 6, emotion: 'shy', express: false },
  // 被拎起来是不开心的事：心情掉，但脸是惊讶而不是生气。
  [EVENT.DRAG_START]: { mood: -8, emotion: 'surprised', express: true },
  // 落地之后回到平常脸，别一直挂着惊讶。
  [EVENT.DRAG_END]: { mood: 2, emotion: 'neutral', express: true },
  [EVENT.PRAISE]: { mood: 20, emotion: 'shy', express: true },
  [EVENT.SPEAK]: { mood: 4, emotion: 'happy', express: false },
  [EVENT.TODO_DONE]: { mood: 15, emotion: 'happy', express: true },
  [EVENT.REMINDER]: { mood: 5, emotion: 'surprised', express: true },
  [EVENT.ALARM]: { mood: 3, emotion: 'surprised', express: true },
  [EVENT.OVERHEAT]: { mood: -12, emotion: 'sad', express: true },
  // 被连续猛点：生气。
  [EVENT.SPAM]: { mood: -25, emotion: 'angry', express: true },
  // 长时间没人理：有点难过。
  [EVENT.IDLE_LONG]: { mood: -8, emotion: 'sad', express: true },
  // 更久之后：困了。
  [EVENT.TIMEOUT]: { mood: 0, emotion: 'tired', express: true },
};

/** 某个事件的规则（心情增量、情绪、是否立刻换表情）；未知事件返回 null。 */
export function eventRule(event) {
  return RULES[event] || null;
}

/** 心情每分钟自然回落的点数：宠物的情绪会淡。 */
const MOOD_DECAY_PER_MINUTE = 6;

/** 多久没有任何互动算「困倦」。 */
export const TIRED_AFTER_MS = 3 * 60 * 1000;

/** 多久没有任何互动算「有点难过」（比困倦短）。 */
export const LONELY_AFTER_MS = 60 * 1000;

export function clampMood(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(MOOD_RANGE.max, Math.max(MOOD_RANGE.min, Math.round(n)));
}

/** 新建一份情绪状态。 */
export function createEmotionState(now = Date.now()) {
  return { mood: 0, emotion: 'neutral', lastInteractionAt: now, lastEventAt: now };
}

/**
 * 施加一个事件，返回**新的**状态（不改原对象，便于单测与回放）。
 *
 * 未知事件原样返回：事件表是这里的唯一真相，
 * 上层传错事件名不该让整条链路崩掉。
 */
export function applyEvent(state, event, now = Date.now()) {
  const rule = RULES[event];
  if (!rule) return { ...state };
  return {
    ...state,
    mood: clampMood(state.mood + rule.mood),
    emotion: rule.emotion,
    lastEventAt: now,
  };
}

/** 记录一次「用户还在」：鼠标动、点了、拖了都算。 */
export function touch(state, now = Date.now()) {
  return { ...state, lastInteractionAt: now };
}

/**
 * 心情随时间自然回落。
 *
 * 只朝 0 回落，不越过 0：心情从 +80 掉到 0 就停，不会掉成 -80。
 */
export function decayMood(mood, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return mood;
  const minutes = elapsedMs / 60000;
  const step = MOOD_DECAY_PER_MINUTE * minutes;
  const target = 0;
  const next = mood > 0 ? Math.max(target, mood - step) : Math.min(target, mood + step);
  return clampMood(next);
}

/**
 * 距离「困倦」还差多久；差得远返回 null。
 *
 * 分两档：超过 LONELY_AFTER_MS 是「有点难过」，超过 TIRED_AFTER_MS 是「困了」。
 * 难过先来——一上来就犯困太突兀。
 */
export function boredomLevel(state, now = Date.now()) {
  const idle = now - state.lastInteractionAt;
  if (!Number.isFinite(idle) || idle < 0) return null;
  if (idle >= TIRED_AFTER_MS) return EVENT.TIMEOUT;
  if (idle >= LONELY_AFTER_MS) return EVENT.IDLE_LONG;
  return null;
}

/**
 * 语义情绪 → 模型自己的表情名；清单里没映射就返回 null。
 *
 * 返回 null 是**有意的**：spec §4.4 的降级表写着「语义缺失 → 退化为播放对应动作；
 * 仍缺失 → 仅播动作」。上层拿到 null 就只播动作、不套表情。
 */
export function expressionNameFor(manifest, emotion) {
  const semantic = EMOTION_EXPRESSION[emotion];
  if (!semantic) return null;
  return resolveExpressionName(manifest, semantic);
}
