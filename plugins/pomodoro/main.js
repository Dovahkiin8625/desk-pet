/**
 * 番茄钟。
 *
 * 独立窗口每秒重算一次页面（清单里的 refreshMs），
 * 于是倒计时是**活着**的，不用手动刷新。
 */
export default function createPomodoroPlugin() {
  const page = (ctx) => {
    const view = ctx.assistant.pomodoroView();
    const buttons = [];
    if (view.running) {
      buttons.push({ id: 'pause', label: '暂停', primary: true });
    } else if (view.paused) {
      buttons.push({ id: 'resume', label: '继续', primary: true });
    } else {
      buttons.push({ id: 'start-focus', label: '开始专注 25 分钟', primary: true });
      buttons.push({ id: 'start-break', label: '开始休息 5 分钟' });
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
      let r;
      switch (actionId) {
        case 'start-focus':
          r = ctx.assistant.startPomodoro('focus');
          break;
        case 'start-break':
          r = ctx.assistant.startPomodoro('break');
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
  };
}
