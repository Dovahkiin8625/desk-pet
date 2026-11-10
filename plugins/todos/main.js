/**
 * 待办。
 *
 * 插件长什么样：`page()` 算出个页面描述，宿主拿去画。
 * 数据都在助理那边（唯一的状态来源），插件只负责读与写。
 *
 * 关键词里同时放英文与拼音：用户既可能打「todo」，也可能打「daiban」。
 */
export default function createTodosPlugin() {
  /** 算一次页面。 */
  const page = (ctx) => {
    const view = ctx.assistant.todosView();
    return ctx.ui.makePage({
      pluginId: 'todos',
      title: '待办',
      subtitle: view.total === 0 ? '一件事都没有' : `还有 ${view.pending} 件事没做完`,
      blocks: [
        view.total === 0
          ? ctx.ui.emptyBlock('还没有待办事项')
          : ctx.ui.listBlock(
              view.items.map((t) => ({
                id: t.id,
                label: t.label,
                done: t.done,
                hint: t.done ? '已完成' : '',
              })),
            ),
        ctx.ui.inputBlock('add', '要做什么？', '添加'),
        ctx.ui.buttonsBlock([{ id: 'clear-done', label: '清除已完成' }]),
      ],
    });
  };

  return {
    page,

    /**
     * 处理一个动作。
     *
     * 动作有两种：插件自己定义的（add / clear-done），
     * 以及待办本身的 id（点一下勾完成）。
     */
    action(ctx, actionId, value) {
      let r;
      if (actionId === 'add') r = ctx.assistant.addTodo(value);
      else if (actionId === 'clear-done') r = ctx.assistant.clearDoneTodos();
      else r = ctx.assistant.toggleTodo(actionId);
      return { ...page(ctx), status: r.message };
    },

    /**
     * 给 agent 用的工具。
     *
     * 清单里声明、这里实现，两边必须同名。
     * 报错要**抛出去**：错误会喂回模型，模型能换个参数再试。
     */
    tools(ctx) {
      return [
        {
          name: 'todos.add',
          async run({ text }) {
            const body = String(text || '').trim();
            if (!body) throw new Error('要写点什么？给个 text');
            const r = ctx.assistant.addTodo(body);
            if (!r?.ok) throw new Error(r?.message || '加不进去');
            return { text: r.message, data: {} };
          },
        },
        {
          name: 'todos.list',
          async run() {
            const view = ctx.assistant.todosView();
            if (!view.items.length) return { text: '还没有待办。', data: { items: [] } };
            // id 要给出去：模型要靠它去勾完成。
            const lines = view.items.map(
              (t) => `${t.done ? '[已完成]' : '[未完成]'} ${t.label}（id: ${t.id}）`
            );
            return {
              text: lines.join('\n'),
              data: { items: view.items.map((t) => ({ id: t.id, label: t.label, done: t.done })) },
            };
          },
        },
        {
          name: 'todos.toggle',
          async run({ id }) {
            const key = String(id || '').trim();
            if (!key) throw new Error('要勾哪一条？给个 id');
            const r = ctx.assistant.toggleTodo(key);
            if (!r?.ok) throw new Error(r?.message || '这条待办不在了');
            return { text: r.message, data: { id: key } };
          },
        },
        {
          name: 'todos.clear',
          async run() {
            const r = ctx.assistant.clearDoneTodos();
            if (!r?.ok) throw new Error(r?.message || '没有已完成的可以清');
            return { text: r.message, data: {} };
          },
        },
      ];
    },
  };
}
