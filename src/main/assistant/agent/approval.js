import { TOOL_RISK } from '../../../shared/assistant.js';

/**
 * 审批闸门（规格 §8）。
 *
 * 闸门回答一个问题：**这个工具要不要用户点头。**
 *
 * ## 三个按钮的语义是不对称的，这是故意的
 *
 * - **允许**：本次放行这一次调用；
 * - **拒绝**：本次不给，**把「不给」喂回模型**——
 *   模型可以换个参数再试，而不是整个任务死掉；
 * - **自动**：本任务内，后续**同风险等级**的操作全部自动放行。
 *
 * 「拒绝」不是终止任务：把它当异常抛出，
 * agent 就只会「失败」，而不会「换条路」。
 */

/** 审批决议。 */
export const APPROVAL_DECISION = Object.freeze({
  /** 本次放行。 */
  ALLOW: 'allow',
  /** 本次不给（喂回模型）。 */
  DENY: 'deny',
  /** 本任务内同风险的后续调用都放行。 */
  ALWAYS: 'always',
});

/**
 * 判定一个工具要不要用户点头。
 *
 * @param {object} options
 * @param {'auto'|'graded'|'manual'} [options.policy]
 * @param {string[]} [options.allowAlways] 永久放行的工具名
 * @param {object} [options.tool] 工具描述符（取 name 与 risk）
 * @param {string} [options.risk] 生效的风险等级（工具表里已经算过）
 * @returns {'allow'|'ask'}
 */
export function decideApproval({ policy = 'graded', allowAlways = [], tool = {}, risk = '' } = {}) {
  const name = String(tool?.name || '');
  const level = String(risk || tool?.risk || TOOL_RISK.READ);
  // 永久放行：用户点过「信任这个工具」。
  if (Array.isArray(allowAlways) && allowAlways.includes(name)) return 'allow';
  const p = String(policy || 'graded');
  if (p === 'auto') return 'allow';
  if (p === 'manual') return 'ask';
  // graded：只读自动放行，写入与执行要问。
  return level === TOOL_RISK.READ ? 'allow' : 'ask';
}

/**
 * 造一个审批闸门。
 *
 * **一个闸门管一个任务**：「自动」是任务级的，
 * 所以「自动放行的风险等级」记在闸门实例里，不记在全局。
 *
 * @param {object} options
 * @param {Function} [options.getPolicy] 当前策略
 * @param {Function} [options.getAllowAlways] 永久放行的工具名
 * @param {Function} [options.ask]
 *   ({ taskId, tool, args, risk }) → Promise<'allow'|'deny'|'always'>
 *   问用户（审批气泡）。**没有它就一律不放行**——
 *   宁可什么都不做，也不能在用户没点头的情况下动他的机器。
 * @param {object} [options.hooks] 运行时的挂起接口（wait / wake）
 * @param {string} [options.taskId]
 * @param {Function} [options.onDecision] 每次决议留一笔（给记录用）
 */
export function createApprovalGate({
  getPolicy = () => 'graded',
  getAllowAlways = () => [],
  ask = null,
  hooks = null,
  taskId = '',
  onDecision = null,
} = {}) {
  /** 本任务里被「自动」放行的风险等级。 */
  const autoRisks = new Set();

  return {
    /**
     * 问一次：这个工具要不要放行。
     *
     * @returns {Promise<{allowed: boolean, reason?: string, userReason?: string}>}
     */
    async request({ tool = {}, args = {}, risk = '', signal = null } = {}) {
      const name = String(tool?.name || '');
      const level = String(risk || tool?.risk || TOOL_RISK.READ);

      // 本任务里点过「自动」：同风险等级的直接放行。
      if (autoRisks.has(level)) {
        return { allowed: true, decision: APPROVAL_DECISION.ALWAYS };
      }

      const verdict = decideApproval({
        policy: getPolicy(),
        allowAlways: getAllowAlways(),
        tool,
        risk: level,
      });
      if (verdict === 'allow') return { allowed: true, decision: APPROVAL_DECISION.ALLOW };

      if (typeof ask !== 'function') {
        return {
          allowed: false,
          reason: `「${name}」需要用户确认，但现在没有确认的渠道：请告诉用户这件事你做不到。`,
          userReason: '有个操作需要你确认，但当前没有确认的渠道，所以我没有动它。',
        };
      }

      // 先问用户（气泡要出来），再挂起（让出并发槽）。
      //
      // 顺序不能反：先挂起的话，气泡还没弹出来用户就点不到。
      const pending = Promise.resolve(
        ask({ taskId, tool, args, risk: level })
      ).catch(() => APPROVAL_DECISION.DENY);
      if (hooks?.wait) {
        const waiting = hooks.wait('approval');
        pending.then(() => hooks.wake?.());
        try {
          await waiting;
        } catch {
          // 任务被取消了（挂起被中止）：下面与 abort 赛跑会给出「拒绝」。
        }
      }
      // 任务被取消时，用户可能一直不答复——不能干等着。
      const outcome = await raceAbort(pending, signal);
      const decision =
        outcome === APPROVAL_DECISION.ALLOW || outcome === APPROVAL_DECISION.ALWAYS
          ? outcome
          : APPROVAL_DECISION.DENY;

      if (decision === APPROVAL_DECISION.ALWAYS) autoRisks.add(level);

      onDecision?.({
        taskId,
        tool: name,
        args,
        risk: level,
        decision,
      });

      if (decision === APPROVAL_DECISION.ALLOW || decision === APPROVAL_DECISION.ALWAYS) {
        return { allowed: true, decision };
      }
      return {
        allowed: false,
        reason: `用户拒绝了「${name}」这次调用`,
        userReason: `「${name}」这次没有获准。`,
      };
    },
  };
}

/**
 * 答复与取消赛跑。
 *
 * 任务被取消时，用户可能一直不答复——不能干等着。
 */
function raceAbort(pending, signal) {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(APPROVAL_DECISION.DENY);
  return Promise.race([
    pending,
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(APPROVAL_DECISION.DENY), { once: true });
    }),
  ]);
}

/**
 * 把一次工具调用说成**给人看**的一句话。
 *
 * 审批气泡上要写清楚「到底要干什么」——
 * 只写工具名的话，用户只能凭感觉点头。
 */
export function describeToolCall(tool = {}, args = {}) {
  const label = String(tool?.label || tool?.name || '这个操作');
  const parts = [];
  const a = args && typeof args === 'object' ? args : {};
  for (const [key, value] of Object.entries(a)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
  }
  return parts.length ? `${label}：${parts.join('，')}` : label;
}
