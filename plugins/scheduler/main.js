/**
 * 定时任务。
 *
 * 两种任务：
 *
 * - **命令**：用户写死要跑什么，到点就跑（`cmd.exe` 那条路），结果记在插件里；
 * - **派单**：用户只说要做什么，到点把单子交给桌宠的 agent——
 *   它自己决定怎么做（必要时写脚本、用工具），做砸了或要动机器时仍走它自己的审批。
 *
 * ## 它自己在主进程里活着
 *
 * 插件的实例在应用启动时就建好了（宿主 `load()` 时），
 * 所以定时器**不依赖界面开着**：面板关着、窗口关着，到点照样跑。
 * 界面只是它的显示。
 *
 * ## 错过的时刻不补跑
 *
 * 应用没开着的这段时间里到点的任务，跳过——下次再跑。
 * 补跑的话，攒了三个小时就能一口气炸出三条。
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createStore } from './lib/store.js';
import {
  describeSchedule,
  formatTime,
  nextRunAt,
  normalizeSchedule,
  parseScheduleText,
} from './lib/schedule.js';
import { buildAgentPrompt, runCommand } from './lib/runner.js';

/** 插件 id。 */
const PLUGIN_ID = 'scheduler';

/** 多久看一眼有没有到点的任务。 */
const TICK_MS = 20000;

/** 任务自己的状态 → 人话。 */
const STATUS_TEXT = {
  running: '在跑',
  ok: '跑完了',
  failed: '没做成',
  dispatched: '派出去了',
  skipped: '这次没跑',
};

/** agent 后台任务的状态 → 人话。 */
const AGENT_STATUS_TEXT = {
  queued: '排队中',
  running: '在跑',
  waiting_approval: '等你点头',
  done: '做完了',
  failed: '没做成',
  cancelled: '已取消',
  interrupted: '被打断了',
};

/**
 * 定时任务插件。
 *
 * @param {object} ctx 宿主给的上下文
 * @param {object} [options] 额外口子（测试时用来指定存盘目录）
 */
export default function createSchedulerPlugin(ctx, options = {}) {
  /** 存着的任务。 */
  let tasks = [];
  /** 存盘的那一份。 */
  let store = null;
  /** 正在跑的任务：id → 开始时刻。 */
  const running = new Map();
  /** 每次改动都加一：界面靠它知道列表要不要重画。 */
  let rev = 0;
  /** 现在的时刻。测试时可以把时钟拨快。 */
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** 多看一眼的间隔。 */
  const tickMs = Number(options.tickMs) > 0 ? Number(options.tickMs) : TICK_MS;
  /** 数据准备好了吗。 */
  const ready = init();

  // ------------------------------------------------------------------
  // 起来
  // ------------------------------------------------------------------

  async function init() {
    const dir = options.userDataDir || (await defaultUserDataDir());
    store = createStore(join(dir, 'scheduler.json'));
    const saved = await store.read();
    tasks = normalizeTasks(saved?.tasks);
    // 下一次一律从「现在」往后算：错过的时刻不补跑。
    const at = now();
    for (const task of tasks) task.nextAt = nextRunAt(task.schedule, at) ?? 0;
    setInterval(() => {
      void onTick();
    }, tickMs).unref();
  }

  /** 存盘。 */
  async function save() {
    await store?.write({ tasks });
  }

  // ------------------------------------------------------------------
  // 到点了
  // ------------------------------------------------------------------

  /** 每 20 秒看一眼：有没有到点的任务。 */
  async function onTick() {
    // 插件被关掉了就不跑（宿主照样把实例建出来了）。
    if (ctx.host?.isEnabled && !ctx.host.isEnabled(PLUGIN_ID)) return;
    const at = now();
    let dirty = false;
    for (const task of tasks) {
      if (!task.enabled) continue;
      if (!task.nextAt || task.nextAt > at) continue;
      // 先把下一次推到将来：跑的过程中不该再触发一次。
      task.nextAt = nextRunAt(task.schedule, at) ?? 0;
      dirty = true;
      void fire(task, at);
    }
    if (dirty) await save();
  }

  /** 跑一条任务。 */
  async function fire(task, at) {
    if (running.has(task.id)) {
      task.lastStatus = 'skipped';
      task.lastResult = '上一次还没跑完，这次没跑';
      rev++;
      await save();
      return;
    }
    running.set(task.id, at);
    task.lastRunAt = at;
    task.lastStatus = 'running';
    task.lastResult = '';
    try {
      if (task.type === 'command') await runCommandTask(task);
      else await dispatchAgentTask(task);
    } catch (err) {
      task.lastStatus = 'failed';
      task.lastResult = String(err?.message || err);
    } finally {
      running.delete(task.id);
    }
    // 状态变了，界面该重画一次。
    rev++;
    await save();
  }

  /** 命令型：按用户写的原样跑。 */
  async function runCommandTask(task) {
    const result = await runCommand({
      command: task.command,
      timeoutMs: commandTimeoutMs(),
    });
    task.lastStatus = result.ok ? 'ok' : 'failed';
    task.lastResult = result.ok ? result.output || '跑完了' : result.error || '没跑成';
    notify(
      result.ok
        ? `定时任务「${task.name}」跑完了。${shorten(result.output)}`
        : `定时任务「${task.name}」没跑成：${shorten(task.lastResult)}`,
      result.ok ? 'happy' : 'sad'
    );
  }

  /** 派单型：交给 agent，它自己想办法。 */
  async function dispatchAgentTask(task) {
    const prompt = buildAgentPrompt(task, describeSchedule(task.schedule));
    const result = await ctx.agent?.run?.(prompt, { title: task.name });
    if (!result?.ok) {
      task.lastStatus = 'failed';
      task.lastResult = result?.message || '派不出去';
      return;
    }
    task.agentTaskId = String(result.taskId || '');
    task.lastStatus = 'dispatched';
    // 结果由 agent 那边报（界面看的是它的状态），这里不重复说一遍。
    task.lastResult = '';
  }

  /** 跟用户说一声。 */
  function notify(text, emotion = '') {
    if (!notifyEnabled()) return;
    try {
      ctx.assistant?.say?.(text, { emotion, sound: emotion === 'sad' ? '' : 'success' });
    } catch (err) {
      console.warn('[desk-pet] 定时任务通知失败：', err?.message);
    }
  }

  // ------------------------------------------------------------------
  // 界面要的那一份
  // ------------------------------------------------------------------

  async function snapshot() {
    await ready;
    const board = await listAgentTasks();
    syncAgentStatus(board);
    const at = now();
    return {
      rev,
      now: at,
      settings: {
        notifyOnFinish: notifyEnabled(),
        commandTimeoutMinutes: commandTimeoutMs() / 60000,
      },
      tasks: tasks.map((task) => viewOf(task, board, at)),
    };
  }

  /** 一条任务给界面看的样子。 */
  function viewOf(task, board, at) {
    const live = task.agentTaskId ? board.find((b) => b.taskId === task.agentTaskId) : null;
    return {
      id: task.id,
      name: task.name,
      type: task.type,
      enabled: task.enabled,
      schedule: task.schedule,
      scheduleText: describeSchedule(task.schedule),
      content: task.type === 'command' ? task.command : task.description,
      nextAt: task.nextAt,
      nextText: task.enabled ? formatTime(task.nextAt, at) : '',
      lastRunAt: task.lastRunAt,
      lastStatus: task.lastStatus,
      lastStatusText: STATUS_TEXT[task.lastStatus] || '',
      lastResult: task.lastResult,
      agentStatus: live?.status || '',
      agentStatusText: live ? AGENT_STATUS_TEXT[live.status] || live.status : '',
      agentResult: live?.result || live?.error || '',
    };
  }

  /** agent 那边的事做完了没：做完了就把结果记到这条任务上。 */
  function syncAgentStatus(board) {
    for (const task of tasks) {
      if (task.type !== 'agent' || !task.agentTaskId) continue;
      if (task.lastStatus !== 'dispatched') continue;
      const live = board.find((b) => b.taskId === task.agentTaskId);
      if (!live) continue;
      if (live.status !== 'done' && live.status !== 'failed') continue;
      task.lastStatus = live.status === 'done' ? 'ok' : 'failed';
      task.lastResult = live.status === 'done' ? live.result || '做完了' : live.error || '没做成';
      rev++;
      void save();
    }
  }

  /** agent 现在有哪些后台任务。 */
  async function listAgentTasks() {
    try {
      const list = await ctx.agent?.tasks?.();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------
  // 界面上的动作
  // ------------------------------------------------------------------

  async function act(actionCtx, actionId, payload) {
    await ready;
    let result = { ok: true, message: '' };
    if (actionId === 'save') {
      result = await saveTask(payload);
    } else if (actionId === 'remove') {
      result = await removeTask(payload?.id);
    } else if (actionId === 'toggle') {
      result = toggleTask(payload?.id, payload?.enabled);
    } else if (actionId === 'run') {
      result = await runNow(payload?.id);
    } else if (actionId === 'setting') {
      const key = String(payload?.key || '');
      const r = await ctx.host?.setConfig?.({ [key]: payload?.value });
      result = { ok: Boolean(r?.ok), message: r?.ok ? '存好了' : r?.message || '存不了' };
    }
    const data = await snapshot();
    return { ...data, ok: result.ok, message: result.message };
  }

  /** 加一条或改一条。 */
  async function saveTask(payload) {
    // **等启动完再改**：init() 是异步的，它读完盘会把 tasks 整个换掉——
    // 在那之前塞进去的任务会被覆盖掉。
    await ready;
    const name = String(payload?.name || '').trim();
    if (!name) return { ok: false, message: '给它起个名字' };
    const type = payload?.type === 'agent' ? 'agent' : 'command';
    const content = String(payload?.content || '').trim();
    if (!content) {
      return { ok: false, message: type === 'command' ? '要写点什么命令' : '要写清楚要做什么' };
    }
    const sched = normalizeSchedule(payload?.schedule);
    if (!sched.ok) return { ok: false, message: sched.error };
    const existing = tasks.find((t) => t.id === String(payload?.id || ''));
    if (existing) {
      existing.name = name;
      existing.type = type;
      existing.schedule = sched.value;
      existing.command = type === 'command' ? content : '';
      existing.description = type === 'agent' ? content : '';
      // 改了计划就重新算下一次：不然会按旧计划突然来一次。
      existing.nextAt = nextRunAt(sched.value, now()) ?? 0;
      rev++;
      await save();
      return { ok: true, message: '改好了', task: existing };
    }
    const task = {
      id: randomUUID(),
      name,
      type,
      schedule: sched.value,
      command: type === 'command' ? content : '',
      description: type === 'agent' ? content : '',
      enabled: true,
      createdAt: now(),
      nextAt: nextRunAt(sched.value, now()) ?? 0,
      lastRunAt: 0,
      lastStatus: '',
      lastResult: '',
      agentTaskId: '',
    };
    tasks.push(task);
    rev++;
    await save();
    return { ok: true, message: '加上了', task };
  }

  /** 删掉一条。 */
  async function removeTask(key) {
    await ready;
    const task = findTask(key);
    if (!task) return { ok: false, message: '没有这条任务' };
    tasks = tasks.filter((t) => t.id !== task.id);
    rev++;
    void save();
    return { ok: true, message: '删掉了' };
  }

  /** 开/关一条。 */
  function toggleTask(key, enabled) {
    const task = findTask(key);
    if (!task) return { ok: false, message: '没有这条任务' };
    task.enabled = enabled === true || enabled === 'true';
    // 重新开的时候从现在算：别把关着这段时间攒下的补上。
    if (task.enabled) task.nextAt = nextRunAt(task.schedule, now()) ?? 0;
    rev++;
    void save();
    return { ok: true, message: task.enabled ? '开着了' : '关掉了' };
  }

  /** 立刻跑一次。 */
  async function runNow(key) {
    await ready;
    const task = findTask(key);
    if (!task) return { ok: false, message: '没有这条任务' };
    void fire(task, now());
    return { ok: true, message: '跑起来了' };
  }

  /** 按 id 找，找不到就按名字找。 */
  function findTask(key) {
    const text = String(key || '').trim();
    if (!text) return null;
    return tasks.find((t) => t.id === text) || tasks.find((t) => t.name === text) || null;
  }

  // ------------------------------------------------------------------
  // 设置
  // ------------------------------------------------------------------

  function notifyEnabled() {
    return ctx.config?.notifyOnFinish !== false;
  }

  function commandTimeoutMs() {
    const minutes = Number(ctx.config?.commandTimeoutMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return 600000;
    return Math.min(minutes, 120) * 60000;
  }

  return {
    /** 首份数据。 */
    data: () => snapshot(),
    /** 周期刷新（清单里的 refreshMs）。 */
    tick: () => snapshot(),
    /** 面板上显示的那几个字。 */
    meta: async () => {
      await ready;
      return {
        title: '定时任务',
        // 标题栏不再重复一遍：页面上都写着呢（与系统状态一个做法）。
        subtitle: '',
      };
    },
    /** 自己页面里的动作。 */
    act,
    /** 积木页面（自己的页面不在磁盘上时的退路）。 */
    page: (pageCtx) => {
      return pageCtx.ui.makePage({
        pluginId: PLUGIN_ID,
        title: '定时任务',
        subtitle: tasks.length ? `${tasks.length} 条任务` : '还没有任务',
        blocks: [
          tasks.length
            ? pageCtx.ui.listBlock(
                tasks.map((t) => ({
                  id: t.id,
                  label: t.name,
                  hint: `${describeSchedule(t.schedule)} · ${t.type === 'command' ? '命令' : '派单'}`,
                  icon: 'clock',
                  // **点条目不删它**：删只走右边的 ✕。
                  removeId: `rm-${t.id}`,
                }))
              )
            : pageCtx.ui.emptyBlock('还没有定时任务', 'clock'),
          pageCtx.ui.textBlock('添加与编辑在插件自己的页面里。'),
        ],
      });
    },
    /** 积木界面里的动作：只有 ✕ 才是删。 */
    action(pageCtx, actionId) {
      const id = String(actionId || '');
      if (id.startsWith('rm-')) void removeTask(id.slice(3));
      return this.page(pageCtx);
    },

    /**
     * 给 agent 用的工具。
     *
     * 清单里声明、这里实现，两边必须同名。
     */
    tools(toolCtx) {
      return [
        {
          name: 'scheduler.add',
          async run(args) {
            const kind = args?.kind === 'agent' ? 'agent' : args?.kind === 'command' ? 'command' : '';
            if (!kind) {
              throw new Error('要说明是「按命令跑」（kind=command）还是「让桌宠自己想办法」（kind=agent）');
            }
            const sched = parseScheduleText(args?.schedule);
            if (!sched.ok) throw new Error(sched.error);
            const content = String((kind === 'command' ? args?.command : args?.description) || '').trim();
            if (!content) {
              throw new Error(kind === 'command' ? '要写清楚跑什么命令' : '要写清楚要做什么');
            }
            const name = String(args?.name || '').trim() || content.slice(0, 12);
            const r = await saveTask({ name, type: kind, content, schedule: sched.value });
            if (!r.ok) throw new Error(r.message);
            const task = r.task;
            return {
              text: `加好了定时任务「${name}」：${describeSchedule(task.schedule)}，${
                kind === 'command' ? '到点执行那条命令' : '到点派给桌宠去做'
              }。`,
              data: { id: task.id, name: task.name, schedule: task.schedule },
            };
          },
        },
        {
          name: 'scheduler.list',
          async run() {
            if (!tasks.length) return { text: '还没有定时任务。', data: { items: [] } };
            const lines = tasks.map((t) => {
              const when = t.enabled ? formatTime(t.nextAt) : '已关掉';
              return `${t.name}（id: ${t.id}）：${describeSchedule(t.schedule)}，${
                t.type === 'command' ? '跑命令' : '派单'
              }，下次 ${when}`;
            });
            return {
              text: lines.join('\n'),
              data: {
                items: tasks.map((t) => ({
                  id: t.id,
                  name: t.name,
                  type: t.type,
                  schedule: t.schedule,
                  enabled: t.enabled,
                })),
              },
            };
          },
        },
        {
          name: 'scheduler.remove',
          async run({ id }) {
            const key = String(id || '').trim();
            if (!key) throw new Error('要删哪一条？给个 id');
            const task = findTask(key);
            if (!task) throw new Error('没有这条定时任务');
            const name = task.name;
            await removeTask(key);
            return { text: `删掉了定时任务「${name}」。`, data: { id: key } };
          },
        },
      ];
    },
  };
}

/**
 * 把存盘的那份读成能用的任务。
 *
 * 坏了的（计划看不懂、内容空着）直接丢掉：
 * 一条坏任务不该让整个插件起不来。
 */
function normalizeTasks(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const sched = normalizeSchedule(raw?.schedule);
    if (!sched.ok) continue;
    const type = raw?.type === 'agent' ? 'agent' : 'command';
    const content = String(type === 'command' ? raw?.command : raw?.description || '').trim();
    if (!content) continue;
    out.push({
      id: String(raw?.id || randomUUID()),
      name: String(raw?.name || '').trim() || '未命名',
      type,
      schedule: sched.value,
      command: type === 'command' ? content : '',
      description: type === 'agent' ? content : '',
      enabled: raw?.enabled !== false,
      createdAt: Number(raw?.createdAt) || Date.now(),
      nextAt: 0,
      lastRunAt: Number(raw?.lastRunAt) || 0,
      lastStatus: String(raw?.lastStatus || ''),
      lastResult: String(raw?.lastResult || ''),
      agentTaskId: String(raw?.agentTaskId || ''),
    });
  }
  return out;
}

/**
 * 存盘的目录。
 *
 * 正常情况下是 electron 的 userData；
 * 拿不到（单测里没有 electron）就退到用户主目录。
 */
async function defaultUserDataDir() {
  try {
    const { app } = await import('electron');
    return app.getPath('userData');
  } catch {
    return join(homedir(), '.desk-pet');
  }
}

/** 一句话只留那么多字。 */
function shorten(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
