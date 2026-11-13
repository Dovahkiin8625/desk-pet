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
        ctx.ui.buttonsBlock([{ id: 'refresh', label: '查一下天气', primary: true }]),
      ],
      // 设置项收在右边的抽屉里：正文只放天气本身。
      drawer: [
        ctx.ui.inputBlock('city', '例如：北京', '设置城市', view.city),
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

    /**
     * 给 agent 用的工具。
     *
     * 清单里声明、这里实现，两边必须同名。
     * 报错要**抛出去**：错误会喂回模型，模型能换个城市再试。
     */
    tools(ctx) {
      return [
        {
          name: 'weather.get',
          async run({ city }) {
            const name = String(city || '').trim();
            const result = await ctx.assistant.fetchWeather(name || undefined);
            if (!result?.ok) throw new Error(result?.message || '查不到天气');
            return { text: result.message, data: { city: name } };
          },
        },
        {
          name: 'weather.city.set',
          async run({ city }) {
            const name = String(city || '').trim();
            if (!name) throw new Error('要设哪个城市？给个 city');
            const r = ctx.assistant.setWeatherCity(name);
            if (!r?.ok) throw new Error(r?.message || '设不了');
            return { text: r.message, data: { city: name } };
          },
        },
      ];
    },
  };
}
