/**
 * 定时方式：规整、说人话、算出下一次什么时候。
 *
 * 三种：
 * - `interval`：每隔 N 分钟；
 * - `daily`：每天 HH:MM；
 * - `cron`：5 段表达式（高级用法）。
 *
 * 「说人话」的那一份（parseScheduleText）是给 agent 用的——
 * 用户嘴里说的是「每天早上八点」，不是 `0 8 * * *`。
 */

import { nextCronTime, parseCron } from './cron.js';

/** 定时方式的取值。 */
export const SCHEDULE_KINDS = Object.freeze(['interval', 'daily', 'cron']);

/** 间隔最长七天：再长就该用 cron 了。 */
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** cron 解析结果的缓存：同一份表达式不用反复解析。 */
const cronCache = new Map();

/**
 * 规整一份定时方式。
 *
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
export function normalizeSchedule(raw) {
  const kind = String(raw?.kind || '').trim();
  if (kind === 'interval') {
    const minutes = Number(raw?.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      return { ok: false, error: '间隔要写多少分钟（至少 1 分钟）' };
    }
    if (minutes > MAX_INTERVAL_MINUTES) return { ok: false, error: '间隔最长 7 天' };
    return { ok: true, value: { kind: 'interval', everyMinutes: Math.round(minutes) } };
  }
  if (kind === 'daily') {
    const at = parseTimeOfDay(raw?.at);
    if (!at) return { ok: false, error: '时间要写成 HH:MM（09:30）' };
    return { ok: true, value: { kind: 'daily', at } };
  }
  if (kind === 'cron') {
    const parsed = parseCron(raw?.expr);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { kind: 'cron', expr: String(raw?.expr).trim() } };
  }
  return { ok: false, error: '定时方式不认识' };
}

/** 说人话：给人看的。 */
export function describeSchedule(schedule) {
  const kind = String(schedule?.kind || '');
  if (kind === 'interval') return `每隔 ${schedule.everyMinutes} 分钟`;
  if (kind === 'daily') return `每天 ${schedule.at}`;
  if (kind === 'cron') return `cron ${schedule.expr}`;
  return '没定';
}

/**
 * 下一次什么时候到点。
 *
 * @param {object} schedule 已经规整过的定时方式
 * @param {Date|number} from 从什么时候算起
 * @returns {number|null} 时刻（毫秒），算不出来就是 null
 */
export function nextRunAt(schedule, from) {
  const base = from instanceof Date ? from.getTime() : Number(from) || Date.now();
  const kind = String(schedule?.kind || '');
  if (kind === 'interval') {
    const minutes = Number(schedule.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) return null;
    return base + minutes * 60 * 1000;
  }
  if (kind === 'daily') {
    const at = parseTimeOfDay(schedule?.at);
    if (!at) return null;
    return nextDailyAt(at, base);
  }
  if (kind === 'cron') {
    const spec = cronSpec(schedule.expr);
    if (!spec) return null;
    const t = nextCronTime(spec, base);
    return t ? t.getTime() : null;
  }
  return null;
}

/** 解析并缓存一份 cron。 */
function cronSpec(expr) {
  const key = String(expr || '').trim();
  if (cronCache.has(key)) return cronCache.get(key);
  const parsed = parseCron(key);
  const spec = parsed.ok ? parsed.value : null;
  cronCache.set(key, spec);
  return spec;
}

/** 下一次「每天 HH:MM」的时刻。 */
function nextDailyAt(at, from) {
  const [hour, minute] = at.split(':').map(Number);
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setHours(hour, minute, 0, 0);
  if (t.getTime() <= from) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/**
 * 把一个时刻写成人话（界面上用）。
 *
 * 今天、明天、后天分开说：只写「09:00」的话，
 * 用户看不出那是今天还是明天。
 */
export function formatTime(at, now = Date.now()) {
  if (!at) return '';
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / 86400000);
  if (days === 0) return `今天 ${hhmm}`;
  if (days === 1) return `明天 ${hhmm}`;
  if (days === 2) return `后天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

/** 那一天的开头。 */
function startOfDay(d) {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t.getTime();
}

/**
 * 把「每天早上八点」这种话解析成定时方式。
 *
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
export function parseScheduleText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '没写定时方式' };

  // cron：五段用空格隔开。
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(raw)) {
    const parsed = parseCron(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, value: { kind: 'cron', expr: raw } };
  }

  // 每周几：「每周一三五 09:00」。
  const weekly = raw.match(/每\s*周\s*([一二三四五六日天]+)/);
  if (weekly) {
    const days = [...weekly[1]].map(chineseWeekday).filter((n) => n !== null);
    if (!days.length) return { ok: false, error: '没看懂是周几' };
    const at = parseTimeOfDay(raw.replace(weekly[0], '')) || '09:00';
    const [hour, minute] = at.split(':');
    return {
      ok: true,
      value: { kind: 'cron', expr: `${Number(minute)} ${Number(hour)} * * ${days.join(',')}` },
    };
  }

  // 每隔 N 分钟/小时/天（「每 30 分钟」「每隔 30 分钟」都认）。
  const interval = raw.match(/每\s*隔?\s*(\d+)\s*(分钟|分|小时|个小时|钟头|天|日)/);
  if (interval) {
    const minutes = toMinutes(Number(interval[1]), interval[2]);
    return normalizeSchedule({ kind: 'interval', everyMinutes: minutes });
  }
  // 「30 分钟一次」也是同一个意思。
  const once = raw.match(/(\d+)\s*(分钟|分|小时|个小时|钟头|天|日)\s*(一次|一遍)/);
  if (once) {
    const minutes = toMinutes(Number(once[1]), once[2]);
    return normalizeSchedule({ kind: 'interval', everyMinutes: minutes });
  }

  // 每天几点。
  if (/每\s*天|每日|daily/i.test(raw)) {
    const at = parseTimeOfDay(raw.replace(/每\s*天|每日|daily/gi, ''));
    if (!at) return { ok: false, error: '每天几点？没看懂时间' };
    return { ok: true, value: { kind: 'daily', at } };
  }

  return { ok: false, error: '没看懂定时方式（可以说「每隔 30 分钟」「每天 09:00」或 cron 表达式）' };
}

/** 「3 小时」折成多少分钟。 */
function toMinutes(count, unit) {
  const text = String(unit || '');
  if (text.includes('小时') || text.includes('钟头')) return count * 60;
  if (text.includes('天') || text.includes('日')) return count * 60 * 24;
  return count;
}

/** 中文星期 → 数字（0 是周日，与 cron 一致）。 */
function chineseWeekday(ch) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  return map[ch] ?? null;
}

/**
 * 把「9:30」「09：30」「9点30分」「十点半」写成一个 HH:MM。
 *
 * @returns {string|null}
 */
export function parseTimeOfDay(text) {
  const raw = cnToArabic(String(text || '').trim());
  if (!raw) return null;
  let m = raw.match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!m) m = raw.match(/^(\d{1,2})\s*[点时]\s*(\d{1,2})?\s*分?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 中文数字。 */
const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * 中文数字换成阿拉伯数字。
 *
 * 只处理时间里用得上的那些：「十点半」这种。
 */
function cnToArabic(text) {
  let s = String(text || '');
  s = s.replace(/点半/g, '点30');
  s = s.replace(/十([一二三四五六七八九])/g, (_, d) => String(10 + CN_DIGITS[d]));
  s = s.replace(/([一二三四五六七八九])十/g, (_, d) => String(CN_DIGITS[d] * 10));
  s = s.replace(/十/g, '10');
  s = s.replace(/[零〇一二三四五六七八九两]/g, (ch) => String(CN_DIGITS[ch] ?? 0));
  return s;
}
