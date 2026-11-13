import { TOOL_RISK } from '../../../../shared/assistant.js';
import { raceAbort } from '../approval.js';

/**
 * 「问用户」这个工具。
 *
 * ## 它解决什么
 *
 * 后台任务有时拿不准：用户说「帮我打开音乐播放器」，
 * 到底是要看它的面板，还是要放首歌？自己猜就是赌——
 * 猜错了用户看到的是完全不相干的东西。
 *
 * 这个工具让后台任务**问一句**：桌宠旁边的气泡弹出一张选择卡，
 * 用户点一个，任务就知道该往哪边走了。
 *
 * ## 为什么它不是审批
 *
 * 审批问的是「这么干行不行」（要的是许可），
 * 这里问的是「你要哪个」（要的是信息）。
 * 审批有四个固定决议，这里回的是**用户选中的那个选项本身**。
 *
 * ## 它不危险
 *
 * 风险是 `read`：问一句话不动用户的东西，
 * 所以「只读自动放行」那档策略下它不会再去要一次批准。
 *
 * ## 等答复时不占并发槽
 *
 * 用户可能几分钟才回。占着槽位的话，别的后台任务全排不上队。
 * 所以这里跟审批闸门一样：先让出槽位，用户答完再拿回来。
 */

/** 一次最多给几个选项：气泡就那么大，选项多了挤成一片。 */
export const MAX_ASK_OPTIONS = 6;

/**
 * 造「问用户」这个工具。
 *
 * @param {object} options
 * @param {Function} [options.ask]
 *   ({ question, options, taskId }) → Promise<string>
 *   问用户（气泡里的选择卡）。**没有它就问不了**——
 *   宁可让模型直接告诉用户这件事它做不到，
 *   也不要让它以为问过了。
 */
export function createAskTools({ ask = null } = {}) {
  return [
    {
      name: 'ask.user',
      label: '问用户',
      description:
        '拿不准用户到底想要什么的时候，问他一句，并给几个可以选的选项。' +
        '用户会在桌宠旁边的气泡里挑一个，挑完你就知道该往哪边走了。' +
        '选项要具体（「打开音乐播放器的面板」「放一首随机歌」），' +
        '别问「你想怎么样」这种没法选的问题。' +
        '一次只问一件事；用户没回答就照实说，别反复问同一个问题。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问的话：一句话，说清你在犹豫什么' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: `给用户挑的选项（1~${MAX_ASK_OPTIONS} 个，每个是一句话）`,
          },
        },
        required: ['question', 'options'],
      },
      risk: TOOL_RISK.READ,
      async run(args, ctx = {}) {
        const question = String(args?.question || '').trim();
        if (!question) throw new Error('要问什么？给个 question');
        const options = (Array.isArray(args?.options) ? args.options : [])
          .map((o) => String(o ?? '').trim())
          .filter(Boolean)
          .slice(0, MAX_ASK_OPTIONS);
        if (!options.length) {
          throw new Error('要给用户几个能挑的选项（options），不然他没法回答');
        }
        if (typeof ask !== 'function') {
          throw new Error('现在没法问用户：请直接告诉用户这件事你做不了。');
        }

        // 先问（气泡要出来），再挂起（让出并发槽）。
        // 顺序不能反：先挂起的话，用户还没看到问题就点不到。
        const pending = Promise.resolve(
          ask({ question, options, taskId: String(ctx?.taskId || '') })
        ).catch(() => '');
        if (ctx?.hooks?.wait) {
          const waiting = ctx.hooks.wait('approval');
          pending.then(() => ctx.hooks.wake?.());
          try {
            await waiting;
          } catch {
            // 任务被取消了（挂起被中止）：下面与 abort 赛跑会给出「没人回答」。
          }
        }
        // 任务被取消时，用户可能一直不选——不能干等着。
        const answer = await raceAbort(pending, ctx?.signal, '');
        const chosen = String(answer || '');
        if (!chosen) {
          return {
            text: '用户没有回答这个问题（任务已经取消了），不要再问同一个问题。',
            data: { answered: false },
          };
        }
        return {
          text: `用户选了：${chosen}`,
          data: { answered: true, choice: chosen },
        };
      },
    },
  ];
}
