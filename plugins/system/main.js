/**
 * 系统状态。
 *
 * 这个插件有两种形态：
 *
 * - 自己的页面（`pages/status.html`）：面板工作台与独立窗口装的是同一份，
 *   三条用量画成条，热度与电源摆在底下那行字里；
 * - 挂在桌面上的小部件（清单里的 `widget.page` 指向自己的 widget.html）——
 *   它自己画界面，宿主只负责每秒喂一次数据（`tick`）。
 *
 * 设置（过热提醒）在页面自己的抽屉里，与剪贴板插件一个样子。
 */
export default function createSystemPlugin() {
  /** 界面要的那一份数据。 */
  const stats = (ctx) => {
    const view = ctx.assistant.statusView();
    return {
      cpu: view.cpu,
      memory: view.memory,
      memoryText: view.memoryText,
      // GPU 采不到就是 null（小部件画「—」，不画 0%）。
      gpu: view.gpu,
      // 原始状态（'nominal'…）与中文说法都带上：
      // 画图用原始的，念给用户听用中文的。
      thermal: view.thermal,
      thermalText: view.thermalText,
      onBattery: view.onBattery,
      hotAlert: view.hotAlert,
    };
  };

  /**
   * 标题那几个字段（自己的页面用）。**要便宜**：别在这儿采样。
   */
  const meta = () => ({
    title: '系统状态',
    // 状态自己画在页面上，标题栏不再重复一遍。
    subtitle: '',
  });

  /** 自己页面里的一个动作。 */
  const act = (ctx, actionId, payload) => {
    let message = '';
    if (actionId === 'hot-alert') {
      const on = payload?.enabled === true || payload?.enabled === 'true';
      const r = ctx.assistant.setHotAlertEnabled(on);
      message = r?.message || '';
    }
    return { ...stats(ctx), message };
  };

  /** 积木页面（自己的页面不在磁盘上时的退路）。 */
  const page = (ctx) => {
    const view = ctx.assistant.statusView();
    return ctx.ui.makePage({
      pluginId: 'system',
      title: '系统状态',
      subtitle: 'CPU · 内存 · GPU · 温度 · 电源',
      blocks: [ctx.ui.textBlock(view.text)],
      drawer: [ctx.ui.toggleBlock('hot-alert', '过热时提醒我', view.hotAlert)],
    });
  };

  return {
    page,
    meta,
    data: stats,
    tick: stats,
    act,

    /** 积木界面里的一个动作（自己的页面不在时的退路）。 */
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
                gpu: view.gpu,
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
