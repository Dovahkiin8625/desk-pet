/**
 * 天气。
 *
 * 联网要时间：查的时候先把页面开着，结果到了再刷新一次。
 * 不这么做的话，用户会对着一个空页面等上好几秒。
 *
 * 界面分三块：天气主卡（图标 + 大字温度）、查询按钮、
 * 「桌宠天气效果」（开关 + 带小方框预览的选择）——
 * 效果相关的东西**在正文里**，不在设置抽屉里：
 * 抽屉只放城市与定时播报，效果选择需要画布预览，抽屉画不了。
 */
export default function createWeatherPlugin() {
  const page = (ctx) => {
    const view = ctx.assistant.weatherView();
    const effectView = ctx.assistant.weatherEffectView?.() || null;
    // 有没有「最近一次查到的天气」：磁盘上的旧数据可能只有 text。
    const hasData = Boolean(
      view.condition ||
        Number.isFinite(view.temperature) ||
        Number.isFinite(view.code)
    );
    return ctx.ui.makePage({
      pluginId: 'weather',
      title: '天气',
      subtitle: view.city ? `城市：${view.city}` : '还没设置城市',
      blocks: [
        hasData
          ? ctx.ui.weatherBlock({
              city: view.city,
              text: view.condition,
              icon: view.icon,
              temperature: view.temperature,
              humidity: view.humidity,
              wind: view.wind,
              at: view.at,
            })
          : ctx.ui.emptyBlock('还没有天气数据，点「查一下天气」'),
        ctx.ui.buttonsBlock([
          { id: 'refresh', label: '查一下天气', primary: true, icon: 'refresh' },
        ]),
        // 桌宠天气效果：开关 + 小方框预览的选择，底部「预览」按钮。
        // 动作 id 走宿主的 `settings:` 前缀——插件不用自己写一遍读写。
        ...(effectView
          ? [ctx.ui.effectsBlock({ ...effectView, preview: { label: '预览', actionId: 'previewEffect' } })]
          : []),
      ],
      // 设置项收在右边的抽屉里：正文只放天气本身与效果选择。
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
      if (actionId === 'previewEffect') {
        // 选择是「自动」时由助理按当前天气与季节抽；具体效果直接播它。
        const r = ctx.assistant.previewWeatherEffect?.(ctx.config?.effect);
        return { ...page(ctx), status: r?.message || '预览不了' };
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
