// external-plugins/batch-rename/lib/plan.js
/**
 * 批量重命名的规则与预览计划。
 *
 * 纯函数模块（不碰磁盘、不碰 Electron）：给它文件清单和规则，
 * 它算出每一行的新名字、以及哪一行有问题。界面预览与真正
 * 动手之前的校验，走的是同一份实现——两边不会漂。
 *
 * 「重新命名为」与「查找/替换」是两个互斥的模式（界面上是 tab）：
 * - rename：主文件名整个由模板说了算（留空 = 不改主文件名），其余链路跳过；
 * - replace：查找/替换 → 大小写 → 前缀/后缀。
 * 两种模式都统一收尾：编号（如启用）+ 扩展名规则。
 * 除扩展名规则外，所有规则都作用于文件名的**主体**（扩展名之前那一截）。
 */

export const CASE_MODES = ['none', 'lower', 'upper'];
export const MODES = ['rename', 'replace'];

export const DEFAULT_RULES = Object.freeze({
  /** 'replace'（查找/替换）| 'rename'（重新命名为）。两者互斥。 */
  mode: 'replace',
  find: '',
  replace: '',
  /** find 按正则来理解（默认按原文字面处理）。 */
  regex: false,
  ignoreCase: false,
  prefix: '',
  suffix: '',
  /** 'none' | 'lower' | 'upper' */
  caseMode: 'none',
  /** 重新命名为模板，如 `度假`。rename 模式下主文件名整个由它说了算；留空 = 不改主文件名。 */
  renameTo: '',
  /** 原扩展名（不带点）。空串 = 匹配所有。 */
  extFind: '',
  /** 新扩展名（不带点）。空串 = 删除扩展名。两者都空 = 这条规则不启用。 */
  extReplace: '',
  numbering: {
    enabled: false,
    start: 1,
    /** 位数（1–8）。 */
    width: 2,
    /** 'prefix' | 'suffix' */
    position: 'prefix',
    separator: '-',
  },
});

const ILLEGAL_CHARS = /[\\/:*?"<>|]/;
const CONTROL_CHARS = /[\u0000-\u001f]/;
/** Windows 设备保留名（con、prn、aux、nul、com1–9、lpt1–9）——文件系统不接受。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function normalizeInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 去掉用户多写的前导点与空白：「.jpeg」「 .jpeg 」都当 jpeg。 */
function trimDots(value) {
  return value.trim().replace(/^\.+/, '');
}

/** 规整一份规则：坏值一律退回默认，不让脏数据流进重命名。 */
export function normalizeRules(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = src.numbering && typeof src.numbering === 'object' ? src.numbering : {};
  const caseMode = CASE_MODES.includes(src.caseMode) ? src.caseMode : DEFAULT_RULES.caseMode;
  const mode = MODES.includes(src.mode) ? src.mode : DEFAULT_RULES.mode;
  return {
    mode,
    find: typeof src.find === 'string' ? src.find : DEFAULT_RULES.find,
    replace: typeof src.replace === 'string' ? src.replace : DEFAULT_RULES.replace,
    regex: Boolean(src.regex),
    ignoreCase: Boolean(src.ignoreCase),
    renameTo: typeof src.renameTo === 'string' ? src.renameTo : DEFAULT_RULES.renameTo,
    prefix: typeof src.prefix === 'string' ? src.prefix : DEFAULT_RULES.prefix,
    suffix: typeof src.suffix === 'string' ? src.suffix : DEFAULT_RULES.suffix,
    caseMode,
    extFind: trimDots(typeof src.extFind === 'string' ? src.extFind : ''),
    extReplace: trimDots(typeof src.extReplace === 'string' ? src.extReplace : ''),
    numbering: {
      enabled: Boolean(num.enabled),
      start: normalizeInt(num.start, -999999, 999999, DEFAULT_RULES.numbering.start),
      width: normalizeInt(num.width, 1, 8, DEFAULT_RULES.numbering.width),
      position: num.position === 'suffix' ? 'suffix' : 'prefix',
      separator: typeof num.separator === 'string' ? num.separator : DEFAULT_RULES.numbering.separator,
    },
  };
}

/** 把一个文件名拆成主体与扩展名（不带点）。`.gitignore` 这种算主体。 */
export function splitName(fileName) {
  const i = fileName.lastIndexOf('.');
  if (i <= 0) return { stem: fileName, ext: '' };
  return { stem: fileName.slice(0, i), ext: fileName.slice(i + 1) };
}

/** 查找/替换作用于主体。返回 { ok, value, error? }。 */
function applyReplace(stem, find, replace, { regex, ignoreCase }) {
  if (!find) return { ok: true, value: stem };
  let pattern;
  if (regex) {
    try {
      pattern = new RegExp(find, `g${ignoreCase ? 'i' : ''}`);
    } catch (err) {
      return { ok: false, error: `正则表达式无效：${err?.message ?? err}` };
    }
  } else {
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(escape(find), `g${ignoreCase ? 'i' : ''}`);
  }
  return { ok: true, value: stem.replace(pattern, replace) };
}

/**
 * 算出一个文件的新文件名。
 *
 * @returns {{ ok: boolean, newName?: string, error?: string }}
 *   ok=false 表示这条规则本身就无效（目前只有正则编译不过）。
 */
export function renameName(fileName, rules, index) {
  const normalized = normalizeRules(rules);
  const { stem, ext } = splitName(fileName);

  // 主文件名：
  // - rename 模式：「重新命名为」模板全权说了算（留空 = 不改主文件名，其余链路跳过）；
  // - replace 模式：①查找/替换 → ②大小写 → ③前缀/后缀 这条链。
  let next = stem;
  if (normalized.mode === 'rename') {
    next = normalized.renameTo || stem;
  } else {
    // ① 查找 / 替换
    const replaced = applyReplace(stem, normalized.find, normalized.replace, normalized);
    if (!replaced.ok) return { ok: false, error: replaced.error };
    next = replaced.value;

    // ② 大小写
    if (normalized.caseMode === 'lower') next = next.toLowerCase();
    else if (normalized.caseMode === 'upper') next = next.toUpperCase();

    // ③ 前缀 / 后缀
    next = `${normalized.prefix}${next}${normalized.suffix}`;
  }

  // ④ 扩展名
  let nextExt = ext;
  const extRuleOn = normalized.extFind !== '' || normalized.extReplace !== '';
  if (extRuleOn) {
    const matches = normalized.extFind === '' || ext.toLowerCase() === normalized.extFind.toLowerCase();
    if (matches) nextExt = normalized.extReplace;
  }

  // ⑤ 编号（两种模式都适用：rename 模式的序号也由「编号」说了算。
  //    rename 模式模板留空时什么都不改——否则空模板 + 默认勾上的编号会把文件凭空加上号）
  const renameBlank = normalized.mode === 'rename' && !normalized.renameTo;
  if (normalized.numbering.enabled && !renameBlank) {
    const { start, width, position, separator } = normalized.numbering;
    const num = String(start + index).padStart(width, '0');
    next = position === 'prefix' ? `${num}${separator}${next}` : `${next}${separator}${num}`;
  }

  const newName = nextExt === '' ? next : `${next}.${nextExt}`;
  return { ok: true, newName };
}

/** Windows 对文件名的硬性要求：这几个字符不许出现，结尾不许是点或空格。 */
export function findNameProblem(name) {
  if (!name) return '文件名变空了';
  if (name.length > 255) return '文件名超过 255 个字符';
  if (ILLEGAL_CHARS.test(name)) {
    const ch = name.match(ILLEGAL_CHARS)[0];
    return `文件名里不能有「${ch}」`;
  }
  if (CONTROL_CHARS.test(name)) return '文件名里不能有控制字符';
  if (/[. ]$/.test(name)) return '文件名不能用点或空格结尾（Windows 不认）';
  const { stem } = splitName(name);
  if (WINDOWS_RESERVED.test(stem)) return `Windows 不认「${stem.toUpperCase()}」这个文件名（设备保留名）`;
  return '';
}

function keyOf(dir, name) {
  // 用 \u0001 分隔：路径里可能有空格，不能用空格当分隔符。
  return `${dir}\u0001${name}`.toLowerCase();
}

/** join 而不 import node:path——这个文件也要能被浏览器侧的页面 import。 */
export function joinPath(dir, name) {
  if (!dir) return name;
  const last = Math.max(dir.lastIndexOf('\\'), dir.lastIndexOf('/'));
  if (last === dir.length - 1) return dir + name; // 已经以分隔符结尾
  return dir + (dir.includes('/') ? '/' : '\\') + name;
}

function emptyCounts(total) {
  return { total, changed: 0, unchanged: 0, invalid: 0, collision: 0 };
}

function countRows(rows) {
  const counts = emptyCounts(rows.length);
  for (const row of rows) {
    if (row.status === 'ok') counts.changed += 1;
    else if (row.status === 'unchanged') counts.unchanged += 1;
    else if (row.status === 'invalid') counts.invalid += 1;
    else if (row.status === 'collision') counts.collision += 1;
  }
  return counts;
}

/**
 * 给整份文件清单算一份预览计划。
 *
 * @param {Array<{ path: string }>} files 文件清单（如用户选的那些）。
 * @param {object} rules 规则（会先规整一遍）。
 * @param {object} [options]
 * @param {(fullPath: string) => boolean} [options.exists]
 *   磁盘上某路径在不在（用来查「目标名是不是被批次外的文件占着」）。
 *   默认当作「都不存在」（纯算预览时用不上）。
 * @returns {{ error?: string, rows: Array<object>, counts: object }}
 *   error 只在「规则无效」（比如正则编译不过）时出现，此时 rows 为空。
 */
export function buildPlan(files, rules, { exists = () => false } = {}) {
  const normalized = normalizeRules(rules);
  const list = Array.isArray(files) ? files : [];

  // 先算一遍每行会变成什么（index 用于编号）。
  const planned = list.map((file, index) => {
    const path = String(file?.path ?? '');
    const seg = path.split(/[\\/]/).filter(Boolean);
    const oldName = seg[seg.length - 1] ?? '';
    const dir = path.slice(0, path.length - oldName.length);
    const result = renameName(oldName, normalized, index);
    return { path, dir, oldName, ...(result.ok ? { newName: result.newName } : { error: result.error }), index };
  });

  const fatal = planned.find((p) => p.error);
  if (fatal) return { error: fatal.error, rows: [], counts: emptyCounts(list.length) };

  // 每个源名被哪一行占着（判定目标名是不是「指到批次里某个文件」）。
  const bySource = new Map(planned.map((p) => [keyOf(p.dir, p.oldName), p]));

  // 两处指到同一个目标：凡是要真正落盘的行，目标不能重复。
  const changedCount = new Map();
  for (const p of planned) {
    if (p.newName === p.oldName) continue; // 不落盘的行不占名额
    const key = keyOf(p.dir, p.newName);
    changedCount.set(key, (changedCount.get(key) ?? 0) + 1);
  }

  const rows = [];
  for (const p of planned) {
    const problem = findNameProblem(p.newName);
    if (problem) {
      rows.push({ ...p, status: 'invalid', message: problem });
      continue;
    }
    if (p.newName === p.oldName) {
      rows.push({ ...p, status: 'unchanged', message: '' });
      continue;
    }
    const targetKey = keyOf(p.dir, p.newName);
    if ((changedCount.get(targetKey) ?? 0) > 1) {
      rows.push({ ...p, status: 'collision', message: '两处会改成同一个名字' });
      continue;
    }
    const owner = bySource.get(targetKey);
    const ownerStays = owner && owner !== p && owner.newName === owner.oldName;
    if (ownerStays) {
      // 目标是批次里另一个**不改名**的文件：它会一直占着这个名。
      rows.push({ ...p, status: 'collision', message: '同批次里有个文件不改名，占着这个名' });
      continue;
    }
    const isOwnSource = targetKey === keyOf(p.dir, p.oldName);
    if (!isOwnSource && !owner && exists(joinPath(p.dir, p.newName))) {
      rows.push({ ...p, status: 'collision', message: '目标文件已存在' });
      continue;
    }
    rows.push({ ...p, status: 'ok', message: '' });
  }

  return { rows, counts: countRows(rows) };
}
