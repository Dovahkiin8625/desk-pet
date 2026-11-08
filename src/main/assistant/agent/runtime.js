import { randomUUID } from 'node:crypto';
import { AGENT_EVENT, TASK_FINAL_STATUS, TASK_STATUS } from '../../../shared/assistant.js';

/**
 * 后台任务运行时（规格 §7）。
 *
 * 桌宠的一个 agent 任务 = 一个后台任务：排队、跑、等审批、结束。
 * 运行时只管**生命周期**，不管任务里干什么（那是 agent 循环的事）。
 *
 * ## 三条最容易做错的
 *
 * 1. **等待审批不占并发槽。**
 *    用户可能几分钟不回，槽位应该让给别的任务——
 *    所以挂起时把槽位还回去，醒来时再重新拿（拿不到就排队等）。
 * 2. **取消要叫醒挂起中的任务。**
 *    挂着的任务正 `await` 用户的答复，不叫醒它的话：
 *    取消之后它还挂着，槽位也回不来。
 * 3. **不做隐式打断。**
 *    正在执行的命令被悄悄杀掉，事后极难排查。要停就显式停（`cancel`）。
 */

/** 终态：这些状态的任务不会再动。 */
const FINAL = new Set(TASK_FINAL_STATUS);

/**
 * 任务被取消时的那个错误。
 *
 * 用 AbortError 的名字：它跟 AbortController 是一套说法，
 * 「这个任务被中止了」而不是「出了什么故障」。
 */
function abortError() {
  const err = new Error('任务已取消');
  err.name = 'AbortError';
  return err;
}

/**
 * 造一个任务运行时。
 *
 * @param {object} options
 * @param {Function} [options.getMaxConcurrent] 同时跑几个任务（默认 1）
 * @param {Function} [options.onEvent] 状态变化事件
 * @param {object} [options.logger] 日志器
 * @param {Function} [options.now] 取当前时刻
 * @param {Function} [options.makeId] 造任务号
 */
export function createAgentRuntime({
  getMaxConcurrent = () => 1,
  onEvent = null,
  logger = console,
  now = () => Date.now(),
  makeId = () => randomUUID(),
} = {}) {
  /** id → 任务。 */
  const tasks = new Map();
  /** 等着起跑的任务 id（FIFO）。 */
  const queue = [];
  /** 正占着并发槽的任务数。 */
  let active = 0;

  function maxConcurrent() {
    const n = Number(getMaxConcurrent());
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  }

  function emit(event) {
    try {
      onEvent?.(event);
    } catch (err) {
      // 订阅者抛异常不许带崩运行时——事件只是通知。
      logger?.warn?.('[desk-pet] agent 任务的订阅者出错：', err?.message);
    }
  }

  /** 任务状态变化的事件。 */
  function taskEvent(task, extra = {}) {
    emit({
      type: AGENT_EVENT.TASK,
      taskId: task.id,
      status: task.status,
      title: task.title,
      at: now(),
      ...extra,
    });
  }

  /** 把任务从队列里摘掉。 */
  function dequeue(taskId) {
    const at = queue.indexOf(taskId);
    if (at >= 0) queue.splice(at, 1);
  }

  /** 起跑一个任务（或给挂起中的任务补一个槽位）。 */
  function pump() {
    while (active < maxConcurrent() && queue.length > 0) {
      const id = queue.shift();
      const task = tasks.get(id);
      if (!task || task.finished) continue;
      active += 1;
      task.holdsSlot = true;
      task.status = TASK_STATUS.RUNNING;
      task.startedAt = task.startedAt || now();
      // 挂起中的任务在等这个槽位：给它。
      const granted = task.slotResolve;
      task.slotResolve = null;
      granted?.();
      if (!task.started) {
        task.started = true;
        launch(task);
      }
      taskEvent(task);
    }
  }

  /** 真正开跑。 */
  function launch(task) {
    const controller = new AbortController();
    task.controller = controller;
    const scope = {
      taskId: task.id,
      signal: controller.signal,
      hooks: makeHooks(task),
      /**
       * 取出并清空待追加的指令。
       *
       * **取走即清空**：一条指令只该被读一次——
       * 留在队列里的话，下一个步骤会再读一遍，模型会当成新要求重复执行。
       */
      steer: () => task.steerNotes.splice(0),
    };
    task.scope = scope;
    Promise.resolve()
      .then(() => task.run(scope))
      .then((result) => finish(task, { ok: true, result }))
      .catch((error) => finish(task, { ok: false, error }));
  }

  /** 任务结束：收尾、还槽、发事件、兑现承诺。 */
  function finish(task, { ok, result, error }) {
    if (task.finished) return;
    task.finished = true;
    task.finishedAt = now();
    if (task.holdsSlot) {
      task.holdsSlot = false;
      active -= 1;
    }
    dequeue(task.id);
    const cancelled = task.status === TASK_STATUS.CANCELLED;
    task.status = cancelled
      ? TASK_STATUS.CANCELLED
      : ok
        ? TASK_STATUS.DONE
        : TASK_STATUS.FAILED;
    task.result = result;
    task.error = error || null;
    taskEvent(task, { error: error ? String(error?.message || error) : '' });
    pump();
    task.resolve?.({
      ok: ok && !cancelled,
      status: task.status,
      result,
      error: error || null,
      taskId: task.id,
    });
  }

  /**
   * 挂起与叫醒。
   *
   * `wait` 会**让出并发槽**：用户可能几分钟不回，
   * 槽位应该让给别的任务（规格 §7.2）。
   */
  function makeHooks(task) {
    return {
      /**
       * 挂起（等用户点头）。醒来之前这个任务不占并发槽。
       *
       * **任务被取消时它会抛错**（AbortError），不是安静地返回——
       * 安静返回的话，任务会接着往下跑该做的事：
       * 用户明明取消了，它还在动他的机器。
       *
       * @param {string} [reason] 'approval' 表示在等审批
       */
      async wait(reason = 'approval') {
        if (task.finished) throw abortError();
        task.waitReason = reason;
        task.status =
          reason === 'approval' ? TASK_STATUS.WAITING_APPROVAL : TASK_STATUS.QUEUED;
        if (task.holdsSlot) {
          task.holdsSlot = false;
          active -= 1;
          pump();
        }
        taskEvent(task);
        await new Promise((resolve) => {
          task.wakeResolve = resolve;
        });
        task.wakeResolve = null;
        if (task.finished) throw abortError();
        // 醒来：重新拿槽位（拿不到就排队等）。
        const granted = new Promise((resolve) => {
          task.slotResolve = resolve;
        });
        task.status = TASK_STATUS.QUEUED;
        // **插到队首**：任务按提交顺序起跑，所以一个醒着的任务
        // 一定比还在排队的任务都早——插队不破坏 FIFO。
        // 而且用户刚答完审批，让它接着走最省事。
        queue.unshift(task.id);
        pump();
        await granted;
        if (task.finished) throw abortError();
        task.status = TASK_STATUS.RUNNING;
        task.waitReason = '';
        taskEvent(task);
      },

      /** 叫醒挂起的任务（用户答复了、或者它被取消了）。 */
      wake() {
        const resolve = task.wakeResolve;
        task.wakeResolve = null;
        resolve?.();
      },
    };
  }

  return {
    /**
     * 提交一个任务。
     *
     * @param {object} job
     * @param {string} [job.title] 一句话说明（给记录与通知用）
     * @param {string} [job.prompt] 任务的内容
     * @param {Function} job.run (scope) => Promise<any>
     * @returns {{ok: boolean, taskId: string, done: Promise<object>, position: number}}
     */
    submit({ title = '', prompt = '', run } = {}) {
      const id = String(makeId());
      const task = {
        id,
        title: String(title || ''),
        prompt: String(prompt || ''),
        status: TASK_STATUS.QUEUED,
        createdAt: now(),
        startedAt: 0,
        finishedAt: 0,
        run: typeof run === 'function' ? run : async () => null,
        controller: null,
        scope: null,
        // 待追加的指令（steer）：执行层在步骤边界取走。
        steerNotes: [],
        // 归档了：不再出现在列表里，也不再计入「正在跑 N 个」。
        // **记录仍然留着**——那是安全审计。
        archived: false,
        holdsSlot: false,
        started: false,
        finished: false,
        waitReason: '',
        result: undefined,
        error: null,
        resolve: null,
        wakeResolve: null,
        slotResolve: null,
      };
      tasks.set(id, task);
      const done = new Promise((resolve) => {
        task.resolve = resolve;
      });
      task.done = done;
      queue.push(id);
      taskEvent(task);
      pump();
      // 我排第几：**前面**还有几个没做完的任务（按提交的先后算）。
      //
      // 不能用队列的长度：跑着的任务不在队列里，
      // 但它确实占着位子——用户要等的是它。
      const ahead = [...tasks.values()].filter((t) => t !== task && !t.finished).length;
      return {
        ok: true,
        taskId: id,
        done,
        position: ahead + 1,
        // 拿到槽位了吗：没拿到就是排队中（要告诉用户「排第 N 位」）。
        queued: task.status === TASK_STATUS.QUEUED,
      };
    },

    /**
     * 给正在跑的任务追加一句要求。
     *
     * **三种结局分得清**（规格 §8）：
     * - 任务还在跑 → 收下（`ok: true`）；
     * - 任务**刚好结束** → 指令丢弃，但**不报错**——
     *   这是时序问题，不是用户的错，报错只会让人以为程序坏了；
     * - 任务**已被取消** → 指令作废，返回 `{ ok: false }`——
     *   取消是明确的用户意图，往一个已经不存在的任务上追加是白做。
     */
    steer(taskId, note) {
      const task = tasks.get(String(taskId || ''));
      if (!task) return { ok: false, message: '没有这个任务' };
      if (task.status === TASK_STATUS.CANCELLED) {
        return { ok: false, message: '这个任务已经被取消了' };
      }
      if (task.finished || FINAL.has(task.status)) {
        return { ok: true, dropped: true };
      }
      const text = String(note || '').trim();
      if (!text) return { ok: false, message: '要追加什么？' };
      task.steerNotes.push(text);
      return { ok: true };
    },

    /**
     * 归档一个**已结束**的任务。
     *
     * 归档只影响可见性：记录条目留着（那是安全审计），
     * 只是它不再出现在列表里，也不再计入「正在跑 N 个」（规格 §6.2）。
     *
     * 还在跑的任务不能归档——要先停掉它。
     */
    archive(taskId) {
      const task = tasks.get(String(taskId || ''));
      if (!task) return { ok: false, message: '没有这个任务' };
      if (!task.finished && !FINAL.has(task.status)) {
        return { ok: false, message: '这个任务还在跑，先停掉它再归档' };
      }
      task.archived = true;
      return { ok: true };
    },

    /**
     * 取消一个任务。
     *
     * **显式**取消：不做隐式打断（规格 §7.3）。
     */
    cancel(taskId) {
      const task = tasks.get(String(taskId || ''));
      if (!task) return { ok: false, message: '没有这个任务' };
      if (task.finished || FINAL.has(task.status)) {
        return { ok: false, message: '这个任务已经结束了' };
      }
      task.status = TASK_STATUS.CANCELLED;
      // 取消了，待追加的指令也就作废了（规格 §5.2）——
      // 留着它们只会在任务万一复活时冒出来。
      task.steerNotes.length = 0;
      dequeue(task.id);
      // 叫醒挂起中的任务：它正 await 用户的答复，不叫醒就一直挂着。
      task.wakeResolve?.();
      task.wakeResolve = null;
      task.slotResolve?.();
      task.slotResolve = null;
      task.controller?.abort();
      finish(task, { ok: false, error: new Error('任务已取消') });
      return { ok: true };
    },

    /** 查一个任务。 */
    get(taskId) {
      return tasks.get(String(taskId || '')) || null;
    },

    /**
     * 所有任务（新的在前）。
     *
     * **默认不含归档的**：归档就是「从列表里收起来」，
     * 记录还在磁盘上（`list({includeArchived: true})` 能看到）。
     */
    list({ includeArchived = false } = {}) {
      const all = [...tasks.values()].reverse();
      return includeArchived ? all : all.filter((t) => !t.archived);
    },

    /** 应用退出：取消所有任务。 */
    stop() {
      for (const task of [...tasks.values()]) {
        if (!task.finished) this.cancel(task.id);
      }
    },
  };
}
