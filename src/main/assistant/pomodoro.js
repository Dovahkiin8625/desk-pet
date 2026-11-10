/**
 * 番茄钟：纯函数状态机。
 *
 * 状态形如
 * `{ phase, endsAt, remainingMs, durationMs, label }`。
 *
 * `endsAt` 是**绝对时刻**而不是「还剩多少」：
 * 只存剩余毫秒的话，进程被挂起（笔记本合盖、系统休眠）之后
 * 计时就停了——番茄钟在用户不在的时候本该继续走。
 */

export const PHASE = Object.freeze({
  IDLE: 'idle',
  FOCUS: 'focus',
  BREAK: 'break',
  PAUSED: 'paused',
});

/** 默认时长：专注 25 分钟、休息 5 分钟。 */
export const DEFAULT_FOCUS_MS = 25 * 60 * 1000;
export const DEFAULT_BREAK_MS = 5 * 60 * 1000;

export function createPomodoroState() {
  return {
    phase: PHASE.IDLE,
    endsAt: null,
    remainingMs: DEFAULT_FOCUS_MS,
    durationMs: DEFAULT_FOCUS_MS,
    label: '',
    pausedPhase: PHASE.IDLE,
  };
}

/** 开始一段计时。 */
export function start(state, phase, durationMs, now = Date.now(), label = '') {
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_FOCUS_MS;
  return {
    phase,
    endsAt: now + ms,
    remainingMs: ms,
    durationMs: ms,
    label,
    pausedPhase: PHASE.IDLE,
  };
}

/** 暂停：把剩余时间冻结下来。 */
export function pause(state, now = Date.now()) {
  if (state.phase !== PHASE.FOCUS && state.phase !== PHASE.BREAK) return { ...state };
  return {
    ...state,
    phase: PHASE.PAUSED,
    // 暂停的是哪一段：**记下来**，继续时才知道该回到专注还是休息。
    // 时长不能拿来反推——时长是用户配的，专注 30 分钟与休息 30 分钟长得一样。
    pausedPhase: state.phase,
    endsAt: null,
    remainingMs: remaining(state, now),
  };
}

/** 继续：从冻结的剩余时间接着走。 */
export function resume(state, now = Date.now()) {
  if (state.phase !== PHASE.PAUSED) return { ...state };
  const ms = state.remainingMs > 0 ? state.remainingMs : state.durationMs;
  const phase = state.pausedPhase === PHASE.BREAK ? PHASE.BREAK : PHASE.FOCUS;
  return {
    ...state,
    phase,
    endsAt: now + ms,
    remainingMs: ms,
  };
}

/** 重置：回到空闲。 */
export function reset() {
  return createPomodoroState();
}

/** 还剩多少毫秒。 */
export function remaining(state, now = Date.now()) {
  if (state.phase === PHASE.FOCUS || state.phase === PHASE.BREAK) {
    return Math.max(0, state.endsAt - now);
  }
  return Math.max(0, state.remainingMs || 0);
}

/** 计时是否已经走完。 */
export function isFinished(state, now = Date.now()) {
  if (state.phase !== PHASE.FOCUS && state.phase !== PHASE.BREAK) return false;
  return state.endsAt !== null && state.endsAt <= now;
}

/** 把剩余毫秒说成人话（「18:24」）。 */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 番茄钟当前状态的文本（给气泡显示）。 */
export function pomodoroText(state, now = Date.now()) {
  if (state.phase === PHASE.IDLE) return '番茄钟没有在跑';
  if (state.phase === PHASE.PAUSED) {
    return `番茄钟已暂停（还剩 ${formatRemaining(remaining(state, now))}）`;
  }
  const what = state.phase === PHASE.BREAK ? '休息' : '专注';
  return `${what}中，还剩 ${formatRemaining(remaining(state, now))}`;
}
