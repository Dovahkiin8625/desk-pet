/**
 * agent 的技能表。
 *
 * ## 什么是「技能」
 *
 * 一个技能是**一个插件怎么用的说明书**。
 *
 * 插件给 agent 的工具描述（description）只够说清「这个工具干什么」，
 * 说不清「这个插件整体该怎么用」——什么时候该用、用之前要先做什么、
 * 工具之间的先后顺序是什么。那些话写进工具描述里，
 * 每个工具都背一遍，同一个插件的工具一多，提示词就翻倍。
 *
 * 技能把那些话收在一处，**按需取用**（渐进式披露）：
 *
 * 1. **第一级**：系统提示词里只有一行「名字：说明」。
 *    模型据此判断「这个插件可能有用」，但看不到正文。
 * 2. **第二级**：模型觉得要用了，调 `skill.read` 读正文，
 *    才知道具体怎么用。
 * 3. **第三级**：正文里提到的别的文件（参考资料、模板），
 *    模型可以再 `skill.read` 一次（带上路径）取。
 *
 * 与工具的区别：**工具是能力，技能是用法**。
 * 一个插件可以只有技能没有工具（那它就是给 agent 的说明书），
 * 也可以两者都有。
 */

/**
 * 技能正文最多多少字。
 *
 * 技能正文是**说明书**，不是数据：太长了模型读不完，
 * 太短了说不清用法。2000 字够写清楚一个插件了。
 */
export const MAX_SKILL_CHARS = 2000;

/**
 * 技能表。
 *
 * 与工具注册表一样是「同名先到先得」：
 * 内置技能先注册，插件后注册——插件不能覆盖别人的技能。
 *
 * @param {object} [options]
 * @param {object} [options.logger] 记日志用
 */
export function createSkillRegistry({ logger = console } = {}) {
  /** name → 技能。 */
  const entries = new Map();

  /**
   * 注册一个技能。
   *
   * @param {object} raw
   * @param {string} raw.name 技能名（全局唯一）
   * @param {string} raw.description 一句话说明（进系统提示词）
   * @param {Function} raw.read (path?) => Promise<string> 读正文
   * @param {object} [options]
   * @param {string} [options.owner] 拥有者（插件 id）：插件被关掉时按它整批摘掉
   */
  function register(raw, { owner = '' } = {}) {
    const name = String(raw?.name || '').trim();
    const description = String(raw?.description || '').trim();
    if (!name) {
      logger.warn?.('[desk-pet] 技能注册失败：没有名字');
      return null;
    }
    if (typeof raw?.read !== 'function') {
      logger.warn?.(`[desk-pet] 技能「${name}」注册失败：没有 read`);
      return null;
    }
    if (entries.has(name)) {
      const prev = entries.get(name);
      logger.warn?.(
        `[desk-pet] 技能「${name}」已经注册过了（来自${prev.owner || '内置'}），这次的不注册`
      );
      return null;
    }
    const entry = {
      name,
      description: description.slice(0, 500),
      owner: String(owner || ''),
      read: raw.read,
    };
    entries.set(name, entry);
    return entry;
  }

  return {
    register,
    /**
     * 按 owner 整批摘掉（插件被关掉时用）。
     *
     * **空 owner 不摘**：内置技能没有 owner。
     */
    unregister(owner) {
      const target = String(owner || '');
      if (!target) return 0;
      let removed = 0;
      for (const [name, entry] of [...entries.entries()]) {
        if (entry.owner === target) {
          entries.delete(name);
          removed += 1;
        }
      }
      return removed;
    },
    get(name) {
      return entries.get(String(name || '')) || null;
    },
    /**
     * 给系统提示词用的清单：**只有名字与说明**。
     *
     * 这就是渐进式披露的第一级：正文不进提示词。
     */
    list() {
      return [...entries.values()].map((e) => ({
        name: e.name,
        description: e.description,
      }));
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * 造「读技能正文」这个工具。
 *
 * **只有一个工具，够所有技能用**：参数是技能名，
 * 不给路径就是读正文，给了路径就是读插件目录里的那个文件
 * （正文里提到的参考资料、模板……）。
 *
 * 风险是 `read`：它读的是插件自己的说明文件，不动用户的东西。
 *
 * @param {object} options
 * @param {object} options.registry 技能表
 * @param {Function} [options.getDisabledTools] 被关掉的工具（名与说明）
 */
export function createSkillTools({ registry, getDisabledTools = () => [] }) {
  return [
    {
      name: 'skill.read',
      label: '读文档',
      description:
        '读某个技能的说明书正文。参数 skill 是技能名（提示词里的技能清单里写着）；' +
        '正文里如果提到别的文件，可以再带 path 读那个文件。',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名' },
          path: { type: 'string', description: '可选：插件目录里的相对路径，读正文之外的补充文件' },
        },
        required: ['skill'],
      },
      risk: 'read',
      async run(args) {
        const name = String(args?.skill || '').trim();
        if (!name) throw new Error('要读哪个技能？给个 skill');
        const entry = registry?.get?.(name);
        if (!entry) throw new Error(`没有这个技能：${name}`);
        const body = await entry.read(args?.path);
        const text = String(body ?? '');
        if (!text.trim()) throw new Error(`技能「${name}」的正文是空的`);
        const clipped =
          text.length > MAX_SKILL_CHARS ? `${text.slice(0, MAX_SKILL_CHARS)}…（已截断）` : text;
        return {
          text: appendDisabledNote(clipped, getDisabledTools()),
          data: { skill: name, path: String(args?.path || '') },
        };
      },
    },
  ];
}

/**
 * 技能正文里提到了被关掉的工具 → 在末尾补一句。
 *
 * **为什么要补**：技能正文是插件作者写的自由文本，
 * 它会写「用 `weather.get` 查天气」。那个工具被用户关掉后，
 * 模型照着说明书去调，只会被回一句「没有这个工具」——
 * 白费一步，还可能反复试。
 *
 * 补一句「这些工具已被关闭，不要用」，模型就不试了。
 * 只在正文**真的提到**那些工具时才补：没提就别添乱。
 */
export function appendDisabledNote(text, disabledTools) {
  const list = Array.isArray(disabledTools) ? disabledTools : [];
  if (!list.length) return text;
  const mentioned = list.filter((t) => {
    const name = String(t?.name || '');
    return name && mentionsTool(text, name);
  });
  if (!mentioned.length) return text;
  const names = mentioned.map((t) => String(t.name)).join('、');
  return `${text}\n\n（注意：${names} 已被用户关闭，不要调用它们。）`;
}

/**
 * 正文里是不是提到了这个工具名。
 *
 * **按整个名字算，不按子串**：`fs.read` 被关掉时，
 * 正文里的 `fs.read.bak` 不算提到它——那是另一个工具。
 */
function mentionsTool(text, name) {
  const re = new RegExp(`(?<![\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.])`);
  return re.test(text);
}
