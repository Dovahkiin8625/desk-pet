import { countInterrupted, countTasks } from './pages/format.js';

/**
 * 后台任务板。
 *
 * ## 数据从哪儿来
 *
 * 一份**全量快照**（每秒一份）：
 * - `ctx.agent.tasks()`：当前的任务（不含归档）；
 * - `ctx.agent.approvals()`：等着用户点头的审批——它与桌宠气泡
 *   是**同一份队列**，两边都能答，先答的算数；
 * - `ctx.agent.history()`：从记录里数出「上次被中断了几个」。
 *
 * **不引事件流**：界面上要的是「现在怎么样」，一秒一份快照够用。
 */
export default function createTasksPlugin(ctx) {
  const agent = ctx.agent;

  /** 一份全量快照。 */
  async function snapshot() {
    const tasks = await agent.tasks();
    const approvals = await agent.approvals();
    return {
      tasks,
      approvals,
      counts: countTasks(tasks),
      interrupted: countInterrupted(agent.history()),
    };
  }

  return {
    /** 打开时给的第一份。 */
    data: () => snapshot(),

    /** 每秒一份（清单里的 refreshMs）。 */
    tick: () => snapshot(),

    /** 面板上显示的那几个字。 */
    meta: async () => {
      const { counts } = await snapshot();
      return {
        title: '后台任务',
        subtitle: `${counts.running} 在跑 · ${counts.queued} 排队`,
      };
    },

    /**
     * 界面上的四个动作。
     *
     * **失败要如实说**：运行时给的那句话原样带回去
     * （比如归档一个还在跑的任务：「这个任务还在跑，先停掉它再归档」）。
     */
    async act(actionCtx, actionId, payload) {
      const api = actionCtx.agent;
      if (actionId === 'cancel') {
        const r = await api.cancel(String(payload?.taskId || ''));
        return { ok: Boolean(r?.ok), message: r?.ok ? '停掉了' : r?.message || '停不掉' };
      }
      if (actionId === 'steer') {
        const r = await api.steer(String(payload?.taskId || ''), String(payload?.note || ''));
        if (!r?.ok) return { ok: false, message: r?.message || '追加不了' };
        // 任务刚好结束：那句话没送出去（**不是错误**，是时序问题）。
        return {
          ok: true,
          message: r.dropped ? '任务已经结束了，这句要求没送出去' : '要求加上了',
        };
      }
      if (actionId === 'archive') {
        const r = await api.archive(String(payload?.taskId || ''));
        return { ok: Boolean(r?.ok), message: r?.ok ? '归档了' : r?.message || '归档不了' };
      }
      if (actionId === 'answer') {
        const r = await api.answerApproval(String(payload?.id || ''), String(payload?.decision || ''));
        return { ok: Boolean(r?.ok), message: r?.message || '' };
      }
      return { ok: false, message: '不认识的作' };
    },
  };
}
