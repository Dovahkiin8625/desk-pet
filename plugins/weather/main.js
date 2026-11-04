/**
 * 天气。
 *
 * 联网要时间：查的时候先把页面开着，结果到了再刷新一次。
 * 不这么做的话，用户会对着一个空页面等上好几秒。
 */
export default function createWeatherPlugin() {
  const page = (ctx) => {
    const view = ctx.assistant.weatherView();
    return ctx.ui.makePage({
      pluginId: 'weather',
      title: '天气',
      subtitle: view.city ? `城市：${view.city}` : '还没设置城市',
      blocks: [
        view.text ? ctx.ui.textBlock(view.text) : ctx.ui.emptyBlock('还没有天气数据，点「查一下天气」'),
        ctx.ui.inputBlock('city', '例如：北京', '设置城市', view.city),
        ctx.ui.buttonsBlock([{ id: 'refresh', label: '查一下天气', primary: true }]),
        ctx.ui.toggleBlock('enabled', '定时播报天气', view.enabled),
      ],
    });
  };

  return {
    page,
    action(ctx, actionId, value) {
      if (actionId === 'city') {
        const r = ctx.assistant.setWeatherCity(value);
        return { ...page(ctx), status: r.message };
      }
      if (actionId === 'enabled') {
        const r = ctx.assistant.setWeatherEnabled(value === 'true');
        return { ...page(ctx), status: r.message };
      }
      if (actionId === 'refresh') {
        void ctx.assistant
          .fetchWeather()
          .then((r) => {
            ctx.update?.({ ...page(ctx), status: r.message });
          })
          .catch((err) => {
            // 一定要接住：漏掉的拒绝会变成主进程的未处理错误，
            // 而页面会永远停在「正在查…」。
            console.warn('[desk-pet] 天气查询失败：', err?.message || err);
            ctx.update?.({ ...page(ctx), status: '天气暂时查不到' });
          });
        return { ...page(ctx), status: '正在查…' };
      }
      return page(ctx);
    },
  };
}
