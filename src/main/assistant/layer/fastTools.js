import { TOOL_RISK } from '../../../shared/assistant.js';

/**
 * 交互层的快工具（规格 §4.1、§4.2）。
 *
 * 「快」= 瞬时、只读、毫秒级——这是交互层能保持秒级的**唯一原因**。
 * 「最多一次」由这里的执行器强制，**不靠提示词自觉**：
 * 提示词只是提醒，执行器才是保证。
 */

/** 快工具白名单：只读、瞬时。 */
export const FAST_TOOL_NAMES = Object.freeze([
  'clock.now',
  'fs.read',
  'fs.list',
]);

/** 一轮对话里快工具合计能用几次。 */
export const FAST_TOOL_LIMIT = 1;

/** 配额用完时给模型的话。 */
const QUOTA_REFUSAL =
  '这一轮只能用一次快工具，请直接给出答复；' +
  '要动手就派一个后台任务（task.submit）。';

/** 把时间格式化成人看得懂的一行。 */
function formatNow(when) {
  const d = when instanceof Date ? when : new Date(when);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * 造这一轮的快工具集。
 *
 * **配额按尝试计数，失败也算用掉**：失败之后的唯一出路是转派后台任务，
 * 不是重试（规格 §4.2）。所以计数在**调用之前**加。
 *
 * 计数是**每轮重置**的：`createFastToolSet` 每轮调一次，
 * 计数器就是那一轮一个。
 *
 * @param {object} options
 * @param {object} [options.registry] 工具表（取 fs.read / fs.list）
 * @param {number} [options.limit] 整轮配额
 * @param {Function} [options.now] 取当前时刻
 */
export function createFastToolSet({
  registry = null,
  limit = FAST_TOOL_LIMIT,
  now = () => new Date(),
} = {}) {
  /** 这一轮已经试过几次快工具（所有快工具合计，不分工具）。 */
  let attempts = 0;

  /** 时钟工具：内置工具表里没有，这里就地造一个。 */
  const clockTool = {
    name: 'clock.now',
    label: '当前时间',
    description: '取当前时间（精确到分钟）。',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: TOOL_RISK.READ,
    async run() {
      const when = now();
      return { text: formatNow(when), data: { at: new Date(when).toISOString() } };
    },
  };

  const tools = [];
  for (const name of FAST_TOOL_NAMES) {
    const tool = name === 'clock.now' ? clockTool : registry?.get?.(name) || null;
    if (!tool) continue;
    tools.push({
      ...tool,
      run: async (args, ctx) => {
        attempts += 1;
        if (attempts > limit) throw new Error(QUOTA_REFUSAL);
        return tool.run(args, ctx);
      },
    });
  }
  return tools;
}
