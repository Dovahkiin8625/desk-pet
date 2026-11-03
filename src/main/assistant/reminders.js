/**
 * 提醒（闹钟）：纯函数状态机 + 一段「把自然语言解析成时刻」的逻辑。
 *
 * 提醒记录形如 `{ id, text, at, createdAt, fired }`。
 * `fired` 是必须的：提醒到点后要播报并消失，
 * 但**不能**把它从数组里直接删掉——否则重启应用时，
 * 那些「已经到点、只是还没来得及播报」的提醒会凭空消失。
 */

let seq = 0;

export function makeReminderId(now = Date.now()) {
  seq += 1;
  return `r-${now}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

// 「2小时」「2 h」「1小时30分钟」「30分」「30m」
// 末尾的「后」必须一起吃掉：不然「30分钟后喝水」会剩下「后喝水」。
const HOURS_RE = /(\d+)\s*(?:个)?\s*(?:小时|钟头|时|h|H)(?:\s*(\d+)\s*(?:分钟|分|m|M))?\s*(?:后|以后|之后)?/;
// 「30分钟」「30分」「30m」
const MINUTES_RE = /(\d+)\s*(?:分钟|分|m|M)\s*(?:后|以后|之后)?/;
// 「14:30」「9：05」
const CLOCK_RE = /(\d{1,2})\s*[:：]\s*(\d{1,2})/;

/** 把毫秒说成人话（「30 分钟」「1 小时 30 分」）。 */
export function humanDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 时刻说成人话（「今天 14:30」「明天 09:00」）。 */
export function clockLabel(at, now = Date.now()) {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? `今天 ${hh}:${mm}` : `明天 ${hh}:${mm}`;
}

/**
 * 从一段自然语言里解析出提醒时刻。
 *
 * 支持三类写法：
 * - 相对时长：`30分钟后`、`2小时`、`1小时30分钟`、`45m`
 * - 绝对时刻：`14:30`、`9：05`
 * - 绝对时刻 + 明天：`明天 9:00`
 *
 * 解析不出时刻时返回 null——调用方据此提示「没看懂时间」，
 * 而不是**默默**按默认时间提醒：默默提醒会让用户以为提醒设错了。
 *
 * @returns {{at: number, text: string, label: string} | null}
 */
export function parseReminder(input, now = Date.now()) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const tomorrow = raw.includes('明天');

  const clockMatch = raw.match(CLOCK_RE);
  if (clockMatch) {
    const h = Number(clockMatch[1]);
    const m = Number(clockMatch[2]);
    if (h > 23 || m > 59) return null;
    const at = new Date(now);
    if (tomorrow) at.setDate(at.getDate() + 1);
    at.setHours(h, m, 0, 0);
    // 没写「明天」却已经过了点：顺延到明天，而不是立刻响。
    if (!tomorrow && at.getTime() <= now) at.setDate(at.getDate() + 1);
    return {
      at: at.getTime(),
      text: contentOf(raw, clockMatch[0]),
      label: clockLabel(at.getTime(), now),
    };
  }

  const hoursMatch = raw.match(HOURS_RE);
  if (hoursMatch) {
    const h = Number(hoursMatch[1]);
    const m = hoursMatch[2] ? Number(hoursMatch[2]) : 0;
    const ms = h * 3600000 + m * 60000;
    return {
      at: now + ms,
      text: contentOf(raw, hoursMatch[0]),
      label: `还有 ${humanDuration(ms)}`,
    };
  }

  const minutesMatch = raw.match(MINUTES_RE);
  if (minutesMatch) {
    const ms = Number(minutesMatch[1]) * 60000;
    return {
      at: now + ms,
      text: contentOf(raw, minutesMatch[0]),
      label: `还有 ${humanDuration(ms)}`,
    };
  }

  return null;
}

/**
 * 从原文里抠出「提醒的内容」。
 *
 * 去掉时间表达式与「提醒我」这类客套话之后剩下的就是内容；
 * 什么都不剩就用「提醒」兜底。
 */
function contentOf(raw, timeExpression) {
  const rest = raw.replace(timeExpression, ' ');
  const cleaned = rest
    .replace(/提醒我|提醒一下|记得|别忘了|please/gi, ' ')
    .replace(/[，,。.！!？?；;、\s]+/g, ' ')
    .trim();
  return cleaned || '提醒';
}

/** 新建一条提醒。 */
export function createReminder(text, at, now = Date.now(), id = makeReminderId(now)) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  if (!Number.isFinite(at)) return null;
  return { id, text: trimmed, at, createdAt: now, fired: false };
}

/** 加一条提醒。 */
export function addReminder(reminders, text, at, now = Date.now()) {
  const reminder = createReminder(text, at, now);
  if (!reminder) return { reminders, added: null };
  return { reminders: [...reminders, reminder], added: reminder };
}

/** 删一条提醒。 */
export function removeReminder(reminders, id) {
  return reminders.filter((r) => r.id !== id);
}

/** 已经到点、还没播报过的提醒。 */
export function dueReminders(reminders, now = Date.now()) {
  return reminders.filter((r) => !r.fired && r.at <= now);
}

/** 把到点的提醒标记为「已播报」。 */
export function markFired(reminders, ids) {
  const set = new Set(ids);
  return reminders.map((r) => (set.has(r.id) ? { ...r, fired: true } : r));
}
