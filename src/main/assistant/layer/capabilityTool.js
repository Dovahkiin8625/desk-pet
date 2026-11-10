import { TOOL_RISK } from '../../../shared/assistant.js';

/**
 * 交互层的「能力清单」工具（规格 §4.1）。
 *
 * 用户问「你有哪些插件 / 技能 / 工具」时，交互层靠它回答。
 *
 * **清单是当场读注册表拼出来的**，不是写死的一段话：
 * 插件被关掉、工具被禁用、插件被摘掉，清单就跟着变——
 * 写死的清单总有一天会骗人。
 *
 * **只列名字，不列内容**：技能正文、工具的调用参数都不在这里。
 * 那是执行层干活的细节；用户问「有哪些」不是问「怎么用」。
 */

/** 一段清单最多列几个。 */
const MAX_ITEMS = 40;

/** 一句话说明最多几个字。 */
const MAX_DESC = 40;

/**
 * 造「能力清单」工具。
 *
 * @param {object} options
 * @param {Function} [options.getSkills] 技能清单：[{name, description}]
 * @param {Function} [options.getPlugins] 插件清单：[{name, description}]
 * @param {Function} [options.getTools] 工具清单：[{name}]
 * @returns {Array} 一个工具的数组（与其它工具组同一个形状）
 */
export function createCapabilityTool({
  getSkills = () => [],
  getPlugins = () => [],
  getTools = () => [],
} = {}) {
  return [
    {
      name: 'capability.list',
      label: '看我有什么本事',
      description:
        '列出你现在有的技能、插件和工具（只列名字与一句话说明，不含用法与参数）。' +
        '用户问「你有哪些插件 / 技能 / 工具」「你会干什么」时先调它，别凭印象说。',
      parameters: { type: 'object', properties: {}, required: [] },
      risk: TOOL_RISK.READ,
      async run() {
        const skills = pick(getSkills(), (s) => s?.description);
        const plugins = pick(getPlugins(), (p) => describePlugin(p));
        const tools = pick(getTools(), () => '');
        return {
          text: buildText({ skills, plugins, tools }),
          data: {
            skills: skills.map((s) => s.name),
            plugins: plugins.map((p) => p.name),
            tools: tools.map((t) => t.name),
          },
        };
      },
    },
  ];
}

/**
 * 插件的一句话说明。
 *
 * **插件开着但没接给后台任务时要说清楚**：那个插件的工具不在工具表里，
 * 模型要是说「我可以帮你查天气」，用户叫它做，它做不到。
 */
function describePlugin(plugin) {
  const desc = String(plugin?.description || '').trim();
  const off = plugin?.agentEnabled === false;
  if (!off) return desc;
  return `${desc ? desc + ' ' : ''}（没接给后台任务）`;
}

/** 取清单里说得清名字的项，顺手截断说明。 */
function pick(list, getDesc) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw?.name || '').trim();
    if (!name) continue;
    out.push({ name, desc: String(getDesc(raw) || '').trim().slice(0, MAX_DESC) });
  }
  return out;
}

/**
 * 拼清单正文。
 *
 * **插件与技能带一句话说明**：光有名字用户看不懂「天气」是干什么的。
 * **工具只列名字**：工具的用法是执行层的事，用户问的是「有哪些」。
 */
function buildText({ skills, plugins, tools }) {
  const shown = tools.slice(0, MAX_ITEMS);
  const rest = tools.length - shown.length;
  return [
    section('技能', skills),
    section('插件', plugins),
    tools.length
      ? `工具（${tools.length} 个）：${shown.map((t) => t.name).join('、')}` +
        (rest > 0 ? `…还有 ${rest} 个` : '')
      : '工具：现在没有可用的工具',
  ].join('\n');
}

/** 拼一段带说明的清单。 */
function section(title, items) {
  if (!items.length) return `${title}：现在没有`;
  const shown = items.slice(0, MAX_ITEMS);
  const body = shown.map((i) => (i.desc ? `- ${i.name}：${i.desc}` : `- ${i.name}`)).join('\n');
  const rest = items.length - shown.length;
  return `${title}（${items.length} 个）：\n${body}${rest > 0 ? `\n…还有 ${rest} 个` : ''}`;
}
