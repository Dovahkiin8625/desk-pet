import {
  makePage,
  textBlock,
  listBlock,
  inputBlock,
  buttonsBlock,
  toggleBlock,
  emptyBlock,
  messagesBlock,
} from '../../shared/panel.js';

/**
 * 插件注册表。
 *
 * 一个插件就是一块**声明式**的界面：主进程造出「页面描述」，
 * 面板渲染层照着画。渲染层里没有任何业务逻辑——
 * 状态与副作用全在这边（与仓库既有的分工一致：
 * 主进程是唯一的状态来源，渲染层只负责呈现）。
 *
 * 插件的界面是**无状态**的：动作 → 重新 `open()` 一次 → 新的页面。
 * 这样每个插件都只有一份「我现在长什么样」的代码，不会出现
 * 「改了数据但界面没跟着变」的第二套同步逻辑。
 *
 * 关键词里同时放英文与拼音：用户既可能打「todo」，也可能打「daiban」。
 */

/** 插件上下文：插件能用到的东西都从这里来。 */
function makeContext({ assistant, openSettings, update }) {
  return { assistant, openSettings, update };
}

// ---------------------------------------------------------------------------
// 待办
// ---------------------------------------------------------------------------

function todosPlugin() {
  const open = (ctx) => {
    const view = ctx.assistant.todosView();
    return makePage({
      pluginId: 'todos',
      title: '待办',
      subtitle: view.total === 0 ? '一件事都没有' : `还有 ${view.pending} 件事没做完`,
      blocks: [
        view.total === 0
          ? emptyBlock('还没有待办事项')
          : listBlock(
              view.items.map((t) => ({
                id: t.id,
                label: t.label,
                done: t.done,
                hint: t.done ? '已完成' : '',
              })),
            ),
        inputBlock('add', '要做什么？', '添加'),
        buttonsBlock([{ id: 'clear-done', label: '清除已完成' }]),
      ],
    });
  };

  return {
    id: 'todos',
    name: '待办',
    icon: '✓',
    description: '查看与添加待办',
    keywords: ['todo', 'todos', 'daiban', 'dai', 'qingdan', '清单', '任务', '事项'],
    open,
    action(ctx, actionId, value) {
      let r;
      if (actionId === 'add') r = ctx.assistant.addTodo(value);
      else if (actionId === 'clear-done') r = ctx.assistant.clearDoneTodos();
      // 其余的 actionId 都是待办本身的 id：点一下勾完成。
      else r = ctx.assistant.toggleTodo(actionId);
      return { ...open(ctx), status: r.message };
    },
  };
}

// ---------------------------------------------------------------------------
// 提醒
// ---------------------------------------------------------------------------

function remindersPlugin() {
  const open = (ctx) => {
    const view = ctx.assistant.remindersView();
    return makePage({
      pluginId: 'reminders',
      title: '提醒',
      subtitle: view.total === 0 ? '没有待触发的提醒' : `${view.total} 条提醒`,
      blocks: [
        view.total === 0
          ? emptyBlock('没有待触发的提醒')
          : listBlock(
              view.items.map((r) => ({ id: r.id, label: r.label, hint: r.hint })),
            ),
        inputBlock('add', '例如：30分钟后喝水', '添加'),
      ],
    });
  };

  return {
    id: 'reminders',
    name: '提醒',
    icon: '⏰',
    description: '到点提醒你做事',
    keywords: ['reminder', 'remind', 'alarm', 'tixing', 'tx', 'naozhong', '闹钟', '备忘'],
    open,
    action(ctx, actionId, value) {
      let r;
      if (actionId === 'add') r = ctx.assistant.addReminder(value);
      // 其余的 actionId 是提醒本身的 id：点一下删掉。
      else r = ctx.assistant.removeReminder(actionId);
      return { ...open(ctx), status: r.message };
    },
  };
}

// ---------------------------------------------------------------------------
// 番茄钟
// ---------------------------------------------------------------------------

function pomodoroPlugin() {
  const open = (ctx) => {
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
    return makePage({
      pluginId: 'pomodoro',
      title: '番茄钟',
      subtitle: view.text,
      blocks: [textBlock(view.text), buttonsBlock(buttons)],
    });
  };

  return {
    id: 'pomodoro',
    name: '番茄钟',
    icon: '🍅',
    description: '25 分钟专注 / 5 分钟休息',
    keywords: ['pomodoro', 'tomato', 'fanqie', 'fq', 'focus', '专注', '计时', '计时器'],
    open,
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
      return { ...open(ctx), status: r.message };
    },
  };
}

// ---------------------------------------------------------------------------
// 天气
// ---------------------------------------------------------------------------

function weatherPlugin() {
  const open = (ctx) => {
    const view = ctx.assistant.weatherView();
    return makePage({
      pluginId: 'weather',
      title: '天气',
      subtitle: view.city ? `城市：${view.city}` : '还没设置城市',
      blocks: [
        view.text ? textBlock(view.text) : emptyBlock('还没有天气数据，点「查一下天气」'),
        inputBlock('city', '例如：北京', '设置城市', view.city),
        buttonsBlock([{ id: 'refresh', label: '查一下天气', primary: true }]),
        toggleBlock('enabled', '定时播报天气', view.enabled),
      ],
    });
  };

  return {
    id: 'weather',
    name: '天气',
    icon: '🌤',
    description: '当前天气与定时播报',
    keywords: ['weather', 'tianqi', 'tq', '天气', '气温', '下雨', '温度'],
    open,
    action(ctx, actionId, value) {
      if (actionId === 'city') {
        const r = ctx.assistant.setWeatherCity(value);
        return { ...open(ctx), status: r.message };
      }
      if (actionId === 'enabled') {
        const r = ctx.assistant.setWeatherEnabled(value === 'true');
        return { ...open(ctx), status: r.message };
      }
      if (actionId === 'refresh') {
        // 联网要时间：先把页面开着，结果到了再刷新一次。
        // 不这么做的话，用户会对着一个空页面等上好几秒。
        void ctx.assistant
          .fetchWeather()
          .then((r) => {
            ctx.update?.({ ...open(ctx), status: r.message });
          })
          .catch((err) => {
            // 一定要接住：漏掉的拒绝会变成主进程的未处理错误，
            // 而页面会永远停在「正在查…」。
            console.warn('[desk-pet] 天气查询失败：', err?.message || err);
            ctx.update?.({ ...open(ctx), status: '天气暂时查不到' });
          });
        return { ...open(ctx), status: '正在查…' };
      }
      return open(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// 系统状态
// ---------------------------------------------------------------------------

function systemPlugin() {
  const open = (ctx) => {
    const view = ctx.assistant.statusView();
    return makePage({
      pluginId: 'system',
      title: '系统状态',
      subtitle: 'CPU · 内存 · 温度 · 电源',
      blocks: [textBlock(view.text), toggleBlock('hot-alert', '过热时提醒我', view.hotAlert)],
    });
  };

  return {
    id: 'system',
    name: '系统状态',
    icon: '📊',
    description: 'CPU、内存、温度、电源',
    keywords: ['system', 'status', 'cpu', 'neicun', 'xituan', '状态', '内存', '温度', '电源'],
    open,
    action(ctx, actionId, value) {
      if (actionId === 'hot-alert') {
        const r = ctx.assistant.setHotAlertEnabled(value === 'true');
        return { ...open(ctx), status: r.message };
      }
      return open(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// 剪贴板
// ---------------------------------------------------------------------------

function clipboardPlugin() {
  const open = async (ctx) => {
    const view = ctx.assistant.clipboardView();
    // 读剪贴板是异步的（Electron 45 的 clipboard.readText 返回 Promise）。
    const clip = await ctx.assistant.readClipboard();
    return makePage({
      pluginId: 'clipboard',
      title: '剪贴板',
      subtitle: view.enabled ? '助手开着：复制内容时我会提示一句' : '助手关着',
      blocks: [
        clip.ok ? textBlock(`最近复制的是：${clip.text}`) : emptyBlock('剪贴板是空的'),
        toggleBlock('enabled', '剪贴板助手', view.enabled),
      ],
    });
  };

  return {
    id: 'clipboard',
    name: '剪贴板',
    icon: '📋',
    description: '最近复制的内容（不落盘）',
    keywords: ['clipboard', 'copy', 'jiban', 'jb', '剪贴板', '复制'],
    open,
    // 这个插件的 open 是 **async** 的（读剪贴板要等），
    // 所以动作里必须 await —— 直接展开一个 Promise 会得到空对象，
    // 页面就没了（标题、块全空）。
    async action(ctx, actionId, value) {
      if (actionId === 'enabled') {
        const r = ctx.assistant.setClipboardEnabled(value === 'true');
        return { ...(await open(ctx)), status: r.message };
      }
      return open(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// 聊天记录
//
// 聊天本身发生在**气泡**里（桌宠旁边），面板里只看得到输入框；
// 所以历史要单独做一个插件来看。
//
// 插件 id 是 `history` 而不是 `chat`——`chat` 是搜索结果里那条
// 「和桌宠聊天」合成项的 id，两者不能撞。
// ---------------------------------------------------------------------------

function chatHistoryPlugin() {
  const open = (ctx) => {
    const view = ctx.assistant.chatHistoryView();
    return makePage({
      pluginId: 'history',
      title: '聊天记录',
      subtitle: view.total ? `${view.total} 条记录` : '还没聊过',
      blocks: [
        view.total === 0
          ? emptyBlock('还没和桌宠聊过天')
          : messagesBlock(view.messages),
        buttonsBlock([{ id: 'clear', label: '清空记录' }]),
      ],
    });
  };

  return {
    id: 'history',
    name: '聊天记录',
    icon: '📜',
    description: '和桌宠说过的话',
    keywords: [
      'history',
      'chat',
      'record',
      'duihua',
      'liaoshi',
      'jl',
      '聊天',
      '记录',
      '对话',
      '记忆',
    ],
    open,
    action(ctx, actionId) {
      if (actionId === 'clear') {
        const r = ctx.assistant.clearChatHistory();
        return { ...open(ctx), status: r.message };
      }
      return open(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function settingsPlugin() {
  return {
    id: 'settings',
    name: '设置',
    icon: '⚙️',
    description: '桌宠的偏好与语音配置',
    keywords: ['settings', 'setting', 'shezhi', 'sz', '设置', '偏好', '配置'],
    // 设置是另一个窗口：打开它，面板就没用了。
    open(ctx) {
      ctx.openSettings?.();
      return null;
    },
    action() {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

/**
 * 建一份插件注册表。
 *
 * @param {object} deps
 * @param {object} deps.assistant 助理总控（插件读写状态都走它）
 * @param {Function} deps.openSettings 打开设置窗口
 */
export function createPluginRegistry({ assistant, openSettings }) {
  const plugins = [
    todosPlugin(),
    remindersPlugin(),
    pomodoroPlugin(),
    weatherPlugin(),
    clipboardPlugin(),
    systemPlugin(),
    chatHistoryPlugin(),
    settingsPlugin(),
  ];
  const byId = new Map(plugins.map((p) => [p.id, p]));

  /** 搜索用的元数据（不含实现，也不含任何敏感信息）。 */
  function list() {
    return plugins.map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      description: p.description,
      keywords: p.keywords,
    }));
  }

  /** 打开一个插件：返回页面；返回 null 表示「关掉面板」。 */
  async function open(id, update) {
    const plugin = byId.get(id);
    if (!plugin) return null;
    return plugin.open(makeContext({ assistant, openSettings, update }));
  }

  /** 处理插件里的一个动作：返回新的页面；返回 null 表示「关掉面板」。 */
  async function action(pluginId, actionId, value, update) {
    const plugin = byId.get(pluginId);
    if (!plugin) return null;
    return plugin.action(makeContext({ assistant, openSettings, update }), actionId, value);
  }

  return { list, open, action, get: (id) => byId.get(id) || null };
}
