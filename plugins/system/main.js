/**
 * 系统状态。
 *
 * 这个插件有两种形态：
 *
 * - 面板里的一块界面（`page`）；
 * - 挂在桌面上的小部件（清单里的 `widget.page` 指向自己的 widget.html）——
 *   它自己画界面，宿主只负责每秒喂一次数据（`tick`）。
 */
export default function createSystemPlugin() {
  /** 面板里的页面。 */
  const page = (ctx) => {
    const view = ctx.assistant.statusView();
    return ctx.ui.makePage({
      pluginId: 'system',
      title: '系统状态',
      subtitle: 'CPU · 内存 · 温度 · 电源',
      blocks: [
        ctx.ui.textBlock(view.text),
        ctx.ui.toggleBlock('hot-alert', '过热时提醒我', view.hotAlert),
      ],
    });
  };

  /** 小部件要的数据：只要能画图的那几个数。 */
  const stats = (ctx) => {
    const view = ctx.assistant.statusView();
    return {
      cpu: view.cpu,
      memory: view.memory,
      // 原始状态（'nominal'…）与中文说法都带上：
      // 画图用原始的，念给用户听用中文的。
      thermal: view.thermal,
      thermalText: view.thermalText,
      onBattery: view.onBattery,
    };
  };

  return {
    page,
    data: stats,
    tick: stats,
    action(ctx, actionId, value) {
      if (actionId === 'hot-alert') {
        const r = ctx.assistant.setHotAlertEnabled(value === 'true');
        return { ...page(ctx), status: r.message };
      }
      return page(ctx);
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
          name: 'system.status',
          async run() {
            const view = ctx.assistant.statusView();
            return {
              text: view.text,
              data: {
                cpu: view.cpu,
                memory: view.memory,
                thermal: view.thermal,
                onBattery: view.onBattery,
              },
            };
          },
        },
        {
          name: 'system.hotalert.set',
          async run({ enabled }) {
            const on = enabled === true || enabled === 'true';
            const r = ctx.assistant.setHotAlertEnabled(on);
            if (!r?.ok) throw new Error(r?.message || '设置不了');
            return { text: r.message, data: { enabled: on } };
          },
        },
      ];
    },
  };
}
