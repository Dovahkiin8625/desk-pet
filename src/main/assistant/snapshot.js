import * as pomodoro from './pomodoro.js';
import * as reminders from './reminders.js';
import * as weather from './weather.js';

/**
 * 「此刻正在发生的事」。
 *
 * ## 为什么要有它
 *
 * 主动搭话时，模型能看到的只有**过去**：人设、长期记忆、最近几轮对话。
 * 没有「现在」，它就只能从历史里挖一件事出来当成现状——
 * 用户早就手动停掉的音乐，会被说成「还在播放」。
 *
 * 所以搭话之前采一份**此刻**的快照给它。
 *
 * ## 只写确实在发生的事
 *
 * 快照里只有**真的在发生**的事，没有就空着。
 *
 * 但**空着不等于否定**：宿主只知道自己手里那几样（计时、待办、提醒、天气、电源），
 * 没写进去的事只是「我不知道」，不是「它没在发生」。
 * 所以那一段的措辞是「我能看到的就这些」——不然模型会转头又说出
 * 「你没在听歌」这类反方向的假话。
 */

/** 天气缓存超过多久就不算「此刻」了（一小时）。 */
const WEATHER_FRESH_MS = 60 * 60 * 1000;

/** 待办那一行最多带多少字的标题。 */
const TODO_TEXT_MAX = 30;

/**
 * 采一份「此刻正在发生的事」。
 *
 * @param {object} options
 * @param {object} [options.state] 助理状态（计时、待办、提醒、天气）
 * @param {number} [options.now]
 * @param {boolean|null} [options.onBattery] 在用电池吗
 * @param {string} [options.thermal] 热状态（powerMonitor 的取值）
 * @returns {string[]} 一行一条
 */
export function buildSnapshotLines({
  state = {},
  now = Date.now(),
  onBattery = null,
  thermal = 'unknown',
} = {}) {
  const lines = [];

  // 计时：在跑才写。
  const timer = state?.pomodoro;
  if (timer && timer.phase && timer.phase !== pomodoro.PHASE.IDLE) {
    const left = pomodoro.formatRemaining(pomodoro.remaining(timer, now));
    if (timer.phase === pomodoro.PHASE.PAUSED) lines.push(`在专注，中途停下了，还剩 ${left}`);
    else if (timer.phase === pomodoro.PHASE.BREAK) lines.push(`在休息，还剩 ${left}`);
    else lines.push(`在专注，还剩 ${left}`);
  }

  // 待办：只数没做完的。
  const todos = (Array.isArray(state?.todos) ? state.todos : []).filter((t) => t && !t.done);
  if (todos.length > 0) {
    const first = String(todos[0].text || '').trim().slice(0, TODO_TEXT_MAX);
    lines.push(
      first
        ? `还有 ${todos.length} 件事没做完，最近一件是「${first}」`
        : `还有 ${todos.length} 件事没做完`
    );
  }

  // 提醒：最近的那一个。
  const upcoming = (Array.isArray(state?.reminders) ? state.reminders : [])
    .filter((r) => r && !r.fired && Number.isFinite(r.at) && r.at > now)
    .sort((a, b) => a.at - b.at);
  if (upcoming.length > 0) {
    const r = upcoming[0];
    const text = String(r.text || '').trim().slice(0, TODO_TEXT_MAX);
    const when = reminders.clockLabel(r.at, now);
    lines.push(text ? `${when} 有一件事要做：${text}` : `${when} 有一件事要做`);
  }

  // 天气：只认缓存里的，缓存太久了就不算「此刻」。
  const last = state?.weather?.last;
  if (
    last &&
    Number.isFinite(last.at) &&
    last.at <= now + 60_000 &&
    now - last.at <= WEATHER_FRESH_MS
  ) {
    lines.push(weather.weatherLine(last.city, last));
  }

  // 电源与温度：只有值得说的时候才写。
  if (onBattery === true) lines.push('在用电池，没插电');
  if (thermal === 'serious' || thermal === 'critical') lines.push('电脑很热，注意降温');

  return lines;
}

/**
 * 「此刻正在发生的事」那一段（提示词用）。
 *
 * **措辞很要紧**：说「我能看到的就这些」，模型才不会把「没写」当成「没在发生」。
 */
export function snapshotSection(lines) {
  const list = (Array.isArray(lines) ? lines : [])
    .map((l) => String(l || '').trim())
    .filter(Boolean);
  const head = '此刻正在发生的事（我能看到的就这些，没写到的只是我不知道）：';
  if (list.length === 0) return `${head}\n- 此刻我这边看不到什么特别的事。`;
  return [head, ...list.map((l) => `- ${l}`)].join('\n');
}
