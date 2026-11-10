/**
 * 提醒。
 *
 * 「30分钟后喝水」「2小时后」「14:30」这些写法由助理解析，
 * 解析不出来时它会明确告诉用户，而不是默默按默认时间提醒。
 */
export default function createRemindersPlugin() {
  const page = (ctx) => {
    const view = ctx.assistant.remindersView();
    return ctx.ui.makePage({
      pluginId: 'reminders',
      title: '提醒',
      subtitle: view.total === 0 ? '没有待触发的提醒' : `${view.total} 条提醒`,
      blocks: [
        view.total === 0
          ? ctx.ui.emptyBlock('没有待触发的提醒')
          : ctx.ui.listBlock(
              view.items.map((r) => ({ id: r.id, label: r.label, hint: r.hint })),
            ),
        ctx.ui.inputBlock('add', '例如：30分钟后喝水', '添加'),
      ],
    });
  };

  return {
    page,
    action(ctx, actionId, value) {
      let r;
      if (actionId === 'add') r = ctx.assistant.addReminder(value);
      // 其余的 actionId 是提醒本身的 id：点一下删掉。
      else r = ctx.assistant.removeReminder(actionId);
      return { ...page(ctx), status: r.message };
    },

    /**
     * 给 agent 用的工具。
     *
     * 清单里声明、这里实现，两边必须同名。
     * 报错要**抛出去**：错误会喂回模型，模型能换个写法再试。
     */
    tools(ctx) {
      return [
        {
          name: 'reminders.add',
          async run({ text }) {
            const body = String(text || '').trim();
            if (!body) throw new Error('要提醒什么？给个 text');
            const r = ctx.assistant.addReminder(body);
            if (!r?.ok) throw new Error(r?.message || '加不进去');
            return { text: r.message, data: {} };
          },
        },
        {
          name: 'reminders.list',
          async run() {
            const view = ctx.assistant.remindersView();
            if (!view.items.length) return { text: '没有待触发的提醒。', data: { items: [] } };
            // id 要给出去：模型要靠它去删。
            const lines = view.items.map(
              (r) => `${r.hint} ${r.label}（id: ${r.id}）`
            );
            return {
              text: lines.join('\n'),
              data: { items: view.items.map((r) => ({ id: r.id, label: r.label, at: r.at })) },
            };
          },
        },
        {
          name: 'reminders.remove',
          async run({ id }) {
            const key = String(id || '').trim();
            if (!key) throw new Error('要删哪一条？给个 id');
            const r = ctx.assistant.removeReminder(key);
            if (!r?.ok) throw new Error(r?.message || '这条提醒不在了');
            return { text: r.message, data: { id: key } };
          },
        },
      ];
    },
  };
}
