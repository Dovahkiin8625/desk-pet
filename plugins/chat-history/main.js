/**
 * 聊天记录（从内置功能变成插件）。
 *
 * ## 为什么改成插件
 *
 * 原来它是面板里的一个内置功能，只能用声明式积木画，
 * 只能显示「谁在什么时候说了什么」。agent 之后记录里会有任务、步骤、审批，
 * 它们要**分类显示**、要**实时更新**、还要能分离成独立窗口——
 * 声明式积木表达不了这些，做成插件它们是白送的。
 *
 * ## 数据从哪儿来
 *
 * - **首份快照**：`ctx.agent.history()`（全部记录）；
 * - **之后的增量**：订阅 `ctx.agent.onEvent`，一条记录进来就推给界面。
 *
 * 插件与宿主同生共死，所以订阅不用退订。
 */
export default function createChatHistoryPlugin(ctx) {
  const agent = ctx.agent;

  // 记录一变就推给界面。
  agent.onEvent((entry) => ctx.push({ entries: [entry] }));

  return {
    /**
     * 首份快照：全部记录。
     *
     * 页面拿到它就把界面画出来；之后的推送接着往下加。
     */
    data: () => ({ entries: agent.history() }),

    /** 标题那几个字段（面板上显示的）。 */
    meta: () => ({
      title: '聊天记录',
      subtitle: `${agent.history().length} 条记录`,
    }),

    /**
     * 页面里的动作：清空记录。
     *
     * 清完由页面自己重新取一份快照（`data()` 这时返回空数组）。
     */
    act(actionCtx, actionId) {
      if (actionId !== 'clear') return null;
      const r = actionCtx.assistant.clearChatHistory();
      return { ok: true, message: r?.message || '记录清空了' };
    },
  };
}
