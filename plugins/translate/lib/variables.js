// plugins/translate/lib/variables.js
/**
 * 把译文变成代码里能当变量名的样子。
 *
 * 只认 ASCII：中文、日文……都不能直接出现在标识符里，
 * 这类译文就不给命名（页面上也就不显示那一块）。
 *
 * 规则（够直觉，也够稳）：
 *
 * 1. 先去掉撇号（don't → dont），再按「非字母数字」切词——
 *    空格、连字符、下划线、标点都算分隔符；
 * 2. 词数 1–5 个，第一个词必须以字母开头；
 * 3. 所有词全小写拼起来：小驼峰首词原样小写、其余首字母大写，
 *    大驼峰每个词首字母大写；
 * 4. 拼出来撞上 JS 保留字的，不给（class、new、…）——
 *    「能当变量名」说的就是能直接粘进代码里。
 */

/** JS 保留字（常见的一批；拼出来撞上就不给）。 */
const RESERVED = new Set([
  // 关键字
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return',
  'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'let', 'static', 'get', 'set', 'async', 'await', 'of', 'yield',
  'enum', 'implements', 'interface', 'package', 'private', 'protected',
  'public', 'from', 'as',
  // 字面量与全局值
  'true', 'false', 'null', 'undefined', 'nan', 'infinity',
  'arguments', 'eval',
]);

/** 拼出来的名字最长多少——再长就不是「变量名」，是句子了。 */
const MAX_NAME_LENGTH = 48;

/** 最多几个词——变量名不是标题，三四个词顶天了。 */
const MAX_WORDS = 5;

/** 首字母大写，其余原样。 */
function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * 译文能不能当变量名？能就给出小驼峰与大驼峰两种写法。
 *
 * @param {string} text 译文
 * @returns {{ lower: string, upper: string } | null}
 *   `lower` 小驼峰（userName），`upper` 大驼峰（UserName）；不行就是 null
 */
export function variableNamesFor(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // 撇号黏着的词当一个词看（don't → dont）。
  const cleaned = raw.replace(/['’‘]/g, '');

  // 还剩非 ASCII 的东西：中文/日文/emoji……直接出局。
  if (/[^\x20-\x7E]/.test(cleaned)) return null;

  const words = cleaned.match(/[A-Za-z0-9]+/g) || [];
  if (words.length === 0 || words.length > MAX_WORDS) return null;
  // 变量名不能以数字开头。
  if (!/^[A-Za-z]/.test(words[0])) return null;

  const normalized = words.map((word) => word.toLowerCase());
  const lower = normalized[0] + normalized.slice(1).map(capitalize).join('');
  const upper = normalized.map(capitalize).join('');

  if (lower.length > MAX_NAME_LENGTH || upper.length > MAX_NAME_LENGTH) return null;
  if (RESERVED.has(lower) || RESERVED.has(upper)) return null;

  return { lower, upper };
}
