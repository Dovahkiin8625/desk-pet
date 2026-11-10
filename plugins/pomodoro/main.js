/**
 * 番茄钟。
 *
 * 独立窗口每秒重算一次页面（清单里的 refreshMs），
 * 于是倒计时是**活着**的，不用手动刷新。
 *
 * 时长由用户在插件自己的页面上配（清单的 settings 段），
 * 界面与 agent 工具都读同一份配置。
 */
export default function createPomodoroPlugin() {
  /** 用户配的专注/休息时长（分钟）。 */
  const minutes = (ctx) => ({
    focus: Number(ctx.config?.focusMinutes) || 25,
    break: Number(ctx.config?.breakMinutes) || 5,
  });

  const page = (ctx) => {
    const view = ctx.assistant.pomodoroView();
    const m = minutes(ctx);
    const buttons = [];
    if (view.running) {
      buttons.push({ id: 'pause', label: '暂停', primary: true });
    } else if (view.paused) {
      buttons.push({ id: 'resume', label: '继续', primary: true });
    } else {
      buttons.push({ id: 'start-focus', label: `开始专注 ${m.focus} 分钟`, primary: true });
      buttons.push({ id: 'start-break', label: `开始休息 ${m.break} 分钟` });
    }
    buttons.push({ id: 'reset', label: '重置' });
    return ctx.ui.makePage({
      pluginId: 'pomodoro',
      title: '番茄钟',
      subtitle: view.text,
      blocks: [ctx.ui.textBlock(view.text), ctx.ui.buttonsBlock(buttons)],
    });
  };

  return {
    page,
    action(ctx, actionId) {
      const m = minutes(ctx);
      let r;
      switch (actionId) {
        case 'start-focus':
          r = ctx.assistant.startPomodoro('focus', m.focus);
          break;
        case 'start-break':
          r = ctx.assistant.startPomodoro('break', m.break);
          break;
        case 'pause':
          r = ctx.assistant.pausePomodoro();
          break;
        case 'resume':
          r = ctx.assistant.resumePomodoro();
          break;
        case 'reset':
          r = ctx.assistant.resetPomodoro();
          break;
        default:
          r = { ok: false, message: '不认识这个操作' };
      }
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
          name: 'pomodoro.start',
          async run({ phase, minutes: mins }) {
            // 配置是**活**的：工具实现被缓存着，用户改完设置要立刻生效。
            const m = minutes(ctx);
            const isBreak = phase === 'break';
            const fallback = isBreak ? m.break : m.focus;
            const dur = Number(mins);
            const use = Number.isFinite(dur) && dur > 0 ? dur : fallback;
            const r = ctx.assistant.startPomodoro(isBreak ? 'break' : 'focus', use);
            if (!r?.ok) throw new Error(r?.message || '番茄钟起不来');
            return { text: r.message, data: { phase: isBreak ? 'break' : 'focus', minutes: use } };
          },
        },
        {
          name: 'pomodoro.pause',
          async run() {
            const r = ctx.assistant.pausePomodoro();
            if (!r?.ok) throw new Error(r?.message || '暂停不了');
            return { text: r.message, data: {} };
          },
        },
        {
          name: 'pomodoro.resume',
          async run() {
            const r = ctx.assistant.resumePomodoro();
            if (!r?.ok) throw new Error(r?.message || '继续不了');
            return { text: r.message, data: {} };
          },
        },
        {
          name: 'pomodoro.reset',
          async run() {
            const r = ctx.assistant.resetPomodoro();
            if (!r?.ok) throw new Error(r?.message || '重置不了');
            return { text: r.message, data: {} };
          },
        },
        {
          name: 'pomodoro.status',
          async run() {
            const view = ctx.assistant.pomodoroView();
            return { text: view.text, data: { running: view.running, paused: view.paused } };
          },
        },
      ];
    },
  };
}
