/**
 * cron 表达式：解析与「下一次什么时候」。
 *
 * 只认 5 段（分 时 日 月 周），不支持秒。
 * 每一段支持：通配、步长（每 n 个取一个）、区间 `a-b`、单值 `a`、并列 `a,b,c`，
 * 月份与星期也认英文名。
 */

/** 常用写法。 */
const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** 五段的取值范围。 */
const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dayOfMonth', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12 },
  { key: 'weekday', min: 0, max: 6 },
];

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * 解析一条 cron 表达式。
 *
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
export function parseCron(expr) {
  const text = String(expr || '').trim().toLowerCase();
  if (!text) return { ok: false, error: 'cron 表达式是空的' };
  const parts = (MACROS[text] || text).split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, error: `cron 要 5 段（分 时 日 月 周），这里只有 ${parts.length} 段` };
  }
  const sets = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const field = FIELDS[i];
    const parsed = parseField(parts[i], field);
    if (!parsed.ok) return parsed;
    sets[field.key] = parsed.value;
  }
  return {
    ok: true,
    value: {
      minute: sets.minute,
      hour: sets.hour,
      dayOfMonth: sets.dayOfMonth,
      month: sets.month,
      weekday: sets.weekday,
      // 日与周都写了具体值时，**任一**命中就算（crontab 的老规矩）。
      domRestricted: !isWildcard(parts[2]),
      dowRestricted: !isWildcard(parts[4]),
    },
  };
}

/** 这一段是不是「每一天都算」。 */
function isWildcard(part) {
  const text = String(part || '').trim();
  return text === '*' || text === '?';
}

/** 解析一段（逗号分隔的若干块）。 */
function parseField(raw, field) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: `${field.key} 那一段是空的` };
  const out = new Set();
  for (const piece of text.split(',')) {
    const part = piece.trim();
    if (!part) continue;
    const [rangePart, stepPart] = part.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) {
        return { ok: false, error: `${part} 里的步长不合法` };
      }
    }
    let start;
    let end;
    if (isWildcard(rangePart)) {
      start = field.min;
      end = field.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      const from = toNumber(a, field);
      const to = toNumber(b, field);
      if (from === null || to === null) return { ok: false, error: `${part} 里的取值不合法` };
      start = Math.min(from, to);
      end = Math.max(from, to);
    } else {
      const n = toNumber(rangePart, field);
      if (n === null) return { ok: false, error: `${part} 不是合法的取值` };
      start = n;
      // 光有步长（`5/2`）就当成「5 到这一段的最大值」。
      end = stepPart !== undefined ? field.max : n;
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  if (!out.size) return { ok: false, error: `${field.key} 那一段没有可用的取值` };
  return { ok: true, value: out };
}

/** 段里的一个取值：数字、英文名，或星期里的 7（等同周日）。 */
function toNumber(raw, field) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  let n = Number(text);
  if (!Number.isFinite(n)) {
    if (field.key === 'month') n = MONTH_NAMES[text];
    else if (field.key === 'weekday') n = DAY_NAMES[text];
    else return null;
  }
  if (field.key === 'weekday' && n === 7) n = 0;
  if (n < field.min || n > field.max) return null;
  return n;
}

/**
 * 下一次什么时候到点。
 *
 * @param {object} spec parseCron 给的那份
 * @param {Date|number} from 从什么时候往后找
 * @returns {Date|null}
 */
export function nextCronTime(spec, from) {
  if (!spec) return null;
  const start = new Date(from instanceof Date ? from.getTime() : Number(from) || Date.now());
  // 找四年：cron 里最邪门的一条（2 月 30 日）也够久了。
  const limit = new Date(start.getTime() + 4 * 366 * 24 * 60 * 60 * 1000);
  let t = new Date(start);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  while (t <= limit) {
    if (!spec.month.has(t.getMonth() + 1)) {
      t = new Date(t.getFullYear(), t.getMonth() + 1, 1, 0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(spec, t)) {
      t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(t.getHours())) {
      t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.has(t.getMinutes())) {
      t = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours(), t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

/** 这一天要不要跑。 */
function dayMatches(spec, t) {
  const domOk = spec.dayOfMonth.has(t.getDate());
  const dowOk = spec.weekday.has(t.getDay());
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}
