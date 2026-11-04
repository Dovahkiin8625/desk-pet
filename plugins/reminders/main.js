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
  };
}
