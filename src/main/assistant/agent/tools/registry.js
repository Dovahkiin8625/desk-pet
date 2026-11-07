import { TOOL_RISK, TOOL_RISK_ORDER, TOOL_NAME_RE } from '../../../../shared/assistant.js';

/**
 * agent 的工具注册表。
 *
 * 一个工具是一个描述符：
 *
 * ```js
 * { name, label, description, parameters, risk, run }
 * ```
 *
 * - `description` 与 `parameters` 是**给模型看的**（会进提示词）；
 * - `label` 是**给人看的**；
 * - `risk` 决定要不要用户点头；
 * - `run(args, ctx)` 是干活的那一口，返回 `{ text, data }`：
 *   `text` 给模型（会被截断后进上下文），`data` 给界面（不进上下文）。
 *
 * **注册表只管「有哪些工具」，不管「怎么执行」**——
 * 怎么执行是 agent 循环（L2）的事，怎么审批是 L3 的事。
 */

/**
 * 宿主给已知危险工具名兜底的风险下限。
 *
 * **插件不能靠声明 `read` 蒙混过关**：风险等级是工具自己声明的，
 * 但声明值只当「请求」，这里给硬下限。
 * 少了这张表，一个插件声明 `shell.exec` 是 `read`，
 * 「只读自动放行」就会替用户批准一次命令执行。
 */
export const TOOL_RISK_FLOOR = Object.freeze({
  'shell.exec': TOOL_RISK.EXEC,
  'app.launch': TOOL_RISK.EXEC,
  'fs.write': TOOL_RISK.WRITE,
});

/**
 * 插件来源的工具的**来源下限**。
 *
 * 按名字兜底只挡得住那几个同名工具：插件换个名字（`weather.get`、
 * `backup.do`）就绕过去了，而规格 §5.2 写的是「插件不能通过声明 read
 * 来绕过检查」——所以插件给的工具一律按「要确认」算。
 *
 * 用户永久放行过的工具除外（规格 §8.1 的 allowAlways）：
 * 用户点了「信任这个工具」，那就是信任过了。
 */
export const PLUGIN_SOURCE_FLOOR = TOOL_RISK.WRITE;

/**
 * 取两个风险里更严格的那个。
 *
 * 读不懂的值（不在 TOOL_RISK_ORDER 里）按**最严格**算：
 * 宁可多问用户一次，也不要因为一个拼错的风险等级就自动放行。
 */
export function stricterRisk(a, b) {
  const rank = (value) => {
    const i = TOOL_RISK_ORDER.indexOf(value);
    return i >= 0 ? i : TOOL_RISK_ORDER.length;
  };
  return TOOL_RISK_ORDER[Math.max(rank(a), rank(b))] ?? TOOL_RISK.EXEC;
}

/**
 * 一个工具**实际生效**的风险等级。
 *
 * 声明值与宿主下限里取更严格的那个。
 *
 * @param {object} tool 工具（只取 name 与 risk）
 * @param {object} [options]
 * @param {'builtin'|'plugin'} [options.source] 工具的来源
 * @param {string[]} [options.allowAlways] 用户永久放行的工具名
 */
export function effectiveRisk(tool, { source = 'builtin', allowAlways = [] } = {}) {
  const declared = String(tool?.risk || '').trim();
  const name = tool?.name;
  // 用户永久放行的工具就按它声明的来——他点过「信任」了。
  const trusted = Array.isArray(allowAlways) && allowAlways.includes(name);
  let floor = TOOL_RISK_FLOOR[name] || TOOL_RISK.READ;
  if (!trusted && source === 'plugin') {
    floor = stricterRisk(floor, PLUGIN_SOURCE_FLOOR);
  }
  return stricterRisk(declared, floor);
}

/**
 * 把任意输入规整成一个工具描述符；不合法就返回 null。
 *
 * `parameters` 必须是对象：模型是按 JSON Schema 读它的，
 * 传成别的形状的话，有的服务端会直接 400。
 *
 * @param {object} raw 原始描述符
 * @param {object} [options]
 * @param {'builtin'|'plugin'} [options.source] 来源（决定要不要按插件算风险）
 * @param {string[]} [options.allowAlways] 用户永久放行的工具名
 */
export function normalizeTool(raw, { source = 'builtin', allowAlways = [] } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!TOOL_NAME_RE.test(name)) return null;
  if (typeof raw.run !== 'function') return null;
  const parameters =
    raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters)
      ? raw.parameters
      : { type: 'object', properties: {} };
  return {
    name,
    label: String(raw.label || name),
    description: String(raw.description || '').slice(0, 2000),
    parameters,
    // **盖掉声明值**：调用方拿到的就是生效值，绕不过去。
    risk: effectiveRisk({ name, risk: raw.risk }, { source, allowAlways }),
    source,
    run: raw.run,
  };
}

/**
 * 工具注册表。
 *
 * **同名先到先得**：内置工具先注册，插件后注册——
 * 插件要是能覆盖 `shell.exec`，它就能把用户批准的「执行命令」换成别的东西。
 * 所以后来的同名注册一律拒绝，并留一行日志。
 *
 * @param {object} [options]
 * @param {object} [options.logger] 记日志用
 * @param {Function} [options.getAllowAlways] 用户永久放行的工具名（规格 §8.1）
 *
 * **风险在注册那一刻定下来**：用户后来把某个插件工具加进 allowAlways，
 * 要等下次注册（插件开关一拨、或重启）才生效——不为一个列表重注册整个表。
 */
export function createToolRegistry({ logger = console, getAllowAlways = () => [] } = {}) {
  /** name → 描述符。 */
  const entries = new Map();

  function register(raw, { owner = '', source = '' } = {}) {
    // 有 owner 的就是插件给的：插件来源的工具要按插件的规矩算风险。
    const src = source || (owner ? 'plugin' : 'builtin');
    const tool = normalizeTool(raw, { source: src, allowAlways: getAllowAlways() || [] });
    if (!tool) {
      logger.warn?.('[desk-pet] 工具注册失败：描述符不合法');
      return null;
    }
    if (entries.has(tool.name)) {
      const prev = entries.get(tool.name);
      logger.warn?.(
        `[desk-pet] 工具「${tool.name}」已经注册过了（来自${prev.owner || '内置'}），这次的不注册`
      );
      return null;
    }
    // owner 记在描述符上：插件被关掉时按它整批摘掉。
    const withOwner = owner ? { ...tool, owner: String(owner) } : tool;
    entries.set(withOwner.name, withOwner);
    return withOwner;
  }

  return {
    register,
    registerAll(tools, options) {
      const out = [];
      for (const raw of Array.isArray(tools) ? tools : []) {
        const tool = register(raw, options);
        if (tool) out.push(tool);
      }
      return out;
    },
    get(name) {
      return entries.get(String(name || '')) || null;
    },
    has(name) {
      return entries.has(String(name || ''));
    },
    list() {
      return [...entries.values()];
    },
    names() {
      return [...entries.keys()];
    },
    /**
     * 按 owner 整批摘掉（插件被关掉时用）。返回摘掉几个。
     *
     * **空 owner 不摘**：内置工具没有 owner，
     * 要是把空串当成「谁都不是」，一次误调用就能把内置工具全清掉。
     */
    unregister(owner) {
      const target = String(owner || '');
      if (!target) return 0;
      let removed = 0;
      for (const [name, tool] of [...entries.entries()]) {
        if (tool.owner === target) {
          entries.delete(name);
          removed += 1;
        }
      }
      return removed;
    },
    get size() {
      return entries.size;
    },
  };
}
