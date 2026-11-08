# 桌宠内置 Agent 运行时 · L3 运行时与审批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 L3 的四件事做完——**后台任务运行时**（T9：队列、并发、取消）、**审批闸门**（T10：三档策略、永久放行、拒绝喂回模型）、**审批气泡**（T11：三个按钮、不自动消失）、**任务完成/失败通知与分类记录**（T12）。

**Architecture:** 五块，按依赖排队：

```
T9  agent/runtime.js    任务运行时：FIFO 队列 / 并发上限 / 状态机 / 取消
                        （等待审批不占槽：挂起时把槽位让出去）
   │
   ▼
T10 agent/approval.js   审批闸门：策略判定 / 永久放行 / 问用户 / 拒绝的语义
   │
   ▼
T12 agent/record.js     分类记录：任务 / 步骤 / 审批三类条目 + 中断检测
   │
   ▼
T11 bubble.js           审批气泡：sticky 形态 + 三个按钮 + 能点（普通气泡是点击穿透的）
   │
   ▼
接线 agent/tasks.js     任务中枢：把运行时、闸门、后端、记录、通知缝在一起
     + assistant/index.js + chat/agent.js + facade
```

- **为什么运行时排在最前**：审批要「挂起时不占槽」，而挂起/唤醒是运行时的事；
  闸门只是调用它。
- **为什么记录单独成文件**：记录是**给人看的**东西，它进磁盘、进界面，但**绝不能进模型上下文**。
  把它做成纯函数（造条目 + 找中断的任务），就能脱离 Electron 单测。
- **这一层不做界面插件**：聊天记录插件化是 L5（T16/T17）。这一层只把记录写对。

**Tech Stack:** Electron + Node（`node --test` 跑单元测试，无测试框架依赖）。
运行时、闸门、记录、任务中枢**都不 import electron**——它们是 agent 的骨架，必须能在普通 node 里测。

**Spec:** `docs/superpowers/specs/2026-11-07-agent-runtime-design.md`（本计划实现 §14 里的 **L3 · 运行时** 四项：T9 / T10 / T11 / T12，以及 §7 的状态机与队列、§8 的审批与气泡、§4.2 的记录分类）

## Global Constraints

- **注释与文档用中文。** 每个文件开头一段块注释，说明「这是什么」和「为什么这么写」；反直觉的设计尤其要写清楚不这么写会怎样。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `fix(助手): …` / `test(助手): …` / `docs(助手): …`。
- **能被测到的改动，先写测试。** 每个任务都按 RED→GREEN 走。
- **Edit 的 `file_path` 必须是绝对路径。**
- **契约只有一份**：任务状态与事件类型放在 `src/shared/assistant.js`（主进程写记录、渲染层读记录，两边必须认同一套取值）。
- **不碰 L4 及以后**：不写 `agent/harness.js`、不做 MCP、不做多 agent 并行。
- **不碰用户的真实配置**：单元测试用注入的假后端、假闸门、假通知；不读真实 `assistant.json`。
- **不隐式打断正在跑的任务**：正在执行的命令被悄悄杀掉事后极难排查，要停就显式停。
- 单元测试命令：`npm run test:unit`（等价于 `node --test "test/unit/**/*.test.js"`）。

## 这几件事最容易做错（写代码时反复看）

1. **等待审批不能占着并发槽。**
   用户可能几分钟不回，槽位应该让给别的任务。
   做法：任务挂起时把槽位还回去，醒来时再重新拿（拿不到就排队等）。
2. **「拒绝」不是终止任务，是给模型一个否定的信号。**
   模型可以换个参数再试。把它当成异常抛出，agent 就只会「失败」而不会「换条路」。
3. **审批气泡不能自动消失，也不能是点击穿透的。**
   普通气泡永远 `setIgnoreMouseEvents(true)`（不然会挡住桌面点击）；
   审批气泡是唯一例外——它有按钮要让人点。
4. **`ttlMs: 0` 不等于「不消失」。**
   `scheduleHide` 里 `ttlMs <= 0` 会退回默认 TTL，所以 sticky 要**另加一个标志**，
   不能靠 `ttlMs: 0` 表达。
5. **任务状态变化、步骤、审批记录一律不进模型上下文。**
   漏了这条过滤，工具日志会把对话冲垮，而且症状是「模型突然变笨」而不是报错。
6. **取消要能叫醒挂起中的任务。**
   挂起的任务正 `await` 用户的答复，不叫醒它的话，取消之后它还挂着，槽位也回不来。
7. **每个 tool_call 都要有一条 `role:'tool'` 的消息。**
   拒绝也算一条（内容是「用户拒绝了这次调用」）。少一条，接口直接 400。
   （L2 已经保证循环侧，这里是提醒：闸门返回「拒绝」时**不要抛异常**。）
8. **重启后不假装能恢复任务。**
   正在跑的 shell 子进程早就死了；只在记录里标一句「已中断」。

## Review Focus

以下是规格暗示、但**没有一个任务的测试会覆盖**的输入类与失败模式。按「最可能先咬到人的」排序：

1. **用户点「拒绝」** → 工具不执行，但任务继续，模型能换条路（规格 §8.2）。
2. **用户点「自动」** → 本任务内**同风险等级**的后续调用不再问；别的任务还要问。
3. **审批挂着的时候用户又发了一句话** → 新任务排队，而不是插队执行。
4. **任务在等审批时被取消** → 挂起被叫醒、槽位还回来、状态是「已取消」。
5. **审批的气泡被别的消息顶掉** → 决议回不来，任务永远挂着（槽位泄漏）。
6. **同一时刻有两个任务都要审批** → 第二个审批请求不能把第一个的决议搞混（按 id 认）。
7. **插件提交的任务失败** → 用户要收到通知，且记录里有失败条目。
8. **应用退出时还有任务在跑** → `stop()` 要取消全部、叫醒挂起的、杀掉子进程。

---

### Task 1: T9 任务运行时

**Files:**
- Create: `src/main/assistant/agent/runtime.js`
- Modify: `src/shared/assistant.js`（加 `TASK_STATUS` 与 `AGENT_EVENT`）
- Test: `test/unit/agent-runtime.test.js`

**Interfaces:**
- Produces:
  - `src/shared/assistant.js`：`TASK_STATUS`（queued / running / waiting_approval / done / failed / cancelled / interrupted）、`AGENT_EVENT`（task / step / approval）
  - `src/main/assistant/agent/runtime.js`：
    - `createAgentRuntime({ getMaxConcurrent, onEvent, logger, now, makeId })`
    - `runtime.submit({ title, prompt, run }) → { ok, taskId, done, position }`
    - `runtime.cancel(taskId) → { ok, message? }`
    - `runtime.get(taskId)` / `runtime.list()`
    - `runtime.stop()`
    - 任务的 `run(scope)` 收到 `scope = { taskId, signal, hooks }`
    - `scope.hooks.wait(reason)`：挂起（**释放并发槽**），醒来后重新拿槽
    - `scope.hooks.wake()`：叫醒挂起的任务

**描述：** `run` 是一个 `async (scope) => result` 的函数。
`scope.hooks.wait('approval')` 会**让出并发槽**并等到有人叫醒它；
`scope.hooks.wake()` 由「知道用户答复了」的一方调用。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-runtime.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../src/main/assistant/agent/runtime.js';
import { TASK_STATUS } from '../../src/shared/assistant.js';

/**
 * 后台任务运行时（规格 §7）。
 *
 * 三件事最容易做错：
 * 1. **等待审批不占并发槽**——用户可能几分钟不回，槽位该让给别的任务；
 * 2. **取消要叫醒挂起的任务**——不然它一直挂着，槽位也回不来；
 * 3. **不做隐式打断**——取消是显式的，跑着的任务被中止要说清楚。
 */

/** 等一拍，让队列与 promise 走完。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

test('运行时：提交一个任务，拿到结果', async () => {
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  const task = runtime.submit({ title: '查天气', prompt: '查天气', run: async () => ({ text: '晴' }) });
  assert.equal(task.ok, true);
  assert.ok(task.taskId);
  const done = await task.done;
  assert.equal(done.status, TASK_STATUS.DONE);
  assert.deepEqual(done.result, { text: '晴' });
});

test('运行时：FIFO——先来的先跑', async () => {
  const order = [];
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const a = runtime.submit({ title: 'A', run: async () => { order.push('A'); await gate; } });
  const b = runtime.submit({ title: 'B', run: async () => { order.push('B'); } });
  await tick();
  assert.deepEqual(order, ['A'], 'B 不该抢在 A 前面');
  release();
  await Promise.all([a.done, b.done]);
  assert.deepEqual(order, ['A', 'B']);
});

test('运行时：并发上限——同时跑的不超过上限', async () => {
  let running = 0;
  let peak = 0;
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 2 });
  const tasks = [];
  for (let i = 0; i < 4; i += 1) {
    tasks.push(runtime.submit({
      title: `T${i}`,
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
      },
    }));
  }
  await Promise.all(tasks.map((t) => t.done));
  assert.ok(peak <= 2, `同时跑了 ${peak} 个`);
});

test('运行时：等待审批不占槽——别的任务能插上来跑', async () => {
  const order = [];
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  let scopeA = null;
  const a = runtime.submit({
    title: 'A',
    run: async (scope) => { scopeA = scope; order.push('A 开始'); await scope.hooks.wait('approval'); order.push('A 继续'); },
  });
  await tick();
  assert.deepEqual(order, ['A 开始']);
  const b = runtime.submit({ title: 'B', run: async () => { order.push('B 跑了'); } });
  await tick();
  assert.deepEqual(order, ['A 开始', 'B 跑了'], 'A 在等审批，不该占着唯一的槽');
  scopeA.hooks.wake();
  await Promise.all([a.done, b.done]);
});

test('运行时：取消排队中的任务，它不会跑', async () => {
  let ran = false;
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const a = runtime.submit({ title: 'A', run: async () => { await gate; } });
  const b = runtime.submit({ title: 'B', run: async () => { ran = true; } });
  await tick();
  assert.equal(runtime.cancel(b.taskId).ok, true);
  release();
  await a.done;
  await tick();
  assert.equal(ran, false, '被取消的任务不该跑');
  assert.equal(runtime.get(b.taskId).status, TASK_STATUS.CANCELLED);
});

test('运行时：取消跑着的任务，它被中止', async () => {
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  let aborted = false;
  const a = runtime.submit({
    title: 'A',
    run: async (scope) => {
      await new Promise((resolve) => {
        scope.signal.addEventListener('abort', () => { aborted = true; resolve(); });
      });
      return '停了';
    },
  });
  await tick();
  assert.equal(runtime.cancel(a.taskId).ok, true);
  const done = await a.done;
  assert.equal(done.status, TASK_STATUS.CANCELLED);
  assert.equal(aborted, true, 'signal 应该被 abort');
});

test('运行时：取消等审批中的任务，它被叫醒并结束', async () => {
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  let woke = false;
  const a = runtime.submit({
    title: 'A',
    run: async (scope) => {
      await scope.hooks.wait('approval');
      woke = true;
    },
  });
  await tick();
  assert.equal(runtime.cancel(a.taskId).ok, true);
  const done = await a.done;
  assert.equal(done.status, TASK_STATUS.CANCELLED);
  await tick();
  assert.equal(woke, false, '被取消后不该再往下走');
});

test('运行时：任务失败，错误传出去', async () => {
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  const a = runtime.submit({ title: 'A', run: async () => { throw new Error('炸了'); } });
  const done = await a.done;
  assert.equal(done.status, TASK_STATUS.FAILED);
  assert.match(String(done.error?.message || done.error), /炸了/);
});

test('运行时：状态变化都有事件', async () => {
  const events = [];
  const runtime = createAgentRuntime({
    getMaxConcurrent: () => 1,
    onEvent: (e) => events.push(e),
  });
  const a = runtime.submit({ title: 'A', run: async () => '好了' });
  await a.done;
  const statuses = events.filter((e) => e.type === 'task').map((e) => e.status);
  assert.ok(statuses.includes(TASK_STATUS.QUEUED), '要有排队');
  assert.ok(statuses.includes(TASK_STATUS.RUNNING), '要有开始');
  assert.ok(statuses.includes(TASK_STATUS.DONE), '要有完成');
  assert.equal(events[0].taskId, a.taskId);
});

test('运行时：stop() 取消所有任务', async () => {
  const runtime = createAgentRuntime({ getMaxConcurrent: () => 1 });
  const tasks = [];
  for (let i = 0; i < 3; i += 1) {
    tasks.push(runtime.submit({ title: `T${i}`, run: async (scope) => {
      await new Promise((resolve) => scope.signal.addEventListener('abort', resolve));
    } }));
  }
  await tick();
  runtime.stop();
  const dones = await Promise.all(tasks.map((t) => t.done));
  assert.ok(dones.every((d) => d.status === TASK_STATUS.CANCELLED));
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-runtime.test.js"`

Expected: FAIL —— `src/main/assistant/agent/runtime.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 实现运行时**

在 `src/shared/assistant.js` 末尾追加：

```js
/**
 * agent 任务的状态（规格 §7.1 的状态机）。
 *
 * 放在共享契约里：主进程写任务记录、渲染层读任务记录，
 * 两边对「这个任务到哪一步了」的理解必须一致。
 */
export const TASK_STATUS = Object.freeze({
  /** 排队中（还没拿到并发槽）。 */
  QUEUED: 'queued',
  /** 正在跑。 */
  RUNNING: 'running',
  /** 等用户点头（**不占并发槽**）。 */
  WAITING_APPROVAL: 'waiting_approval',
  /** 跑完了。 */
  DONE: 'done',
  /** 失败了。 */
  FAILED: 'failed',
  /** 被取消了。 */
  CANCELLED: 'cancelled',
  /** 应用退出时被中断（重启后补记的）。 */
  INTERRUPTED: 'interrupted',
});

/** 任务已到终态：不会再变了。 */
export const TASK_FINAL_STATUS = Object.freeze([
  TASK_STATUS.DONE,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.INTERRUPTED,
]);

/** agent 事件的类型（插件与记录都认这一套）。 */
export const AGENT_EVENT = Object.freeze({
  /** 任务状态变化。 */
  TASK: 'task',
  /** 任务中的一次工具调用。 */
  STEP: 'step',
  /** 一次审批请求与它的决议。 */
  APPROVAL: 'approval',
});
```

新建 `src/main/assistant/agent/runtime.js`：

```js
import { randomUUID } from 'node:crypto';
import { TASK_STATUS } from '../../../shared/assistant.js';

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
const FINAL = new Set([
  TASK_STATUS.DONE,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.INTERRUPTED,
]);

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
      type: 'task',
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
       * @param {string} [reason] 'approval' 表示在等审批
       */
      async wait(reason = 'approval') {
        if (task.finished) return;
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
        if (task.finished) return;
        // 醒来：重新拿槽位（拿不到就排队等）。
        const granted = new Promise((resolve) => {
          task.slotResolve = resolve;
        });
        task.status = TASK_STATUS.QUEUED;
        queue.unshift(task.id);
        pump();
        await granted;
        if (task.finished) return;
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
      return { ok: true, taskId: id, done, position: queue.length };
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

    /** 所有任务（新的在前）。 */
    list() {
      return [...tasks.values()].reverse();
    },

    /** 应用退出：取消所有任务。 */
    stop() {
      for (const task of [...tasks.values()]) {
        if (!task.finished) this.cancel(task.id);
      }
    },
  };
}
```

- [x] **Step 4: 跑测试，确认它全绿**

Run: `node --test "test/unit/agent-runtime.test.js"`

Expected: PASS —— 10 个测试全过。

- [x] **Step 5: 提交**

```bash
git add src/shared/assistant.js src/main/assistant/agent/runtime.js test/unit/agent-runtime.test.js
git commit -m "feat(助手): 后台任务运行时——队列、并发上限、取消"
```

---

### Task 2: T10 审批闸门

**Files:**
- Create: `src/main/assistant/agent/approval.js`
- Test: `test/unit/agent-approval.test.js`

**Interfaces:**
- Consumes: `src/shared/assistant.js` 的 `TOOL_RISK`
- Produces:
  - `src/main/assistant/agent/approval.js`：
    - `APPROVAL_DECISION`（allow / deny / always）
    - `decideApproval({ policy, allowAlways, tool, risk }) → 'allow' | 'ask'`
    - `createApprovalGate({ getPolicy, getAllowAlways, ask, hooks, taskId, onDecision })`
      → `{ request({ tool, args, risk, signal }) → Promise<{allowed, reason, userReason}> }`
    - `describeToolCall(tool, args) → string`（给人看的一行说明）

**描述：** `ask({ taskId, tool, args, risk })` 返回一个 promise，
兑现的值为 `'allow' | 'deny' | 'always'`。
`hooks` 是运行时给的挂起接口（`wait` / `wake`）——挂起期间**不占并发槽**。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-approval.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_DECISION,
  createApprovalGate,
  decideApproval,
  describeToolCall,
} from '../../src/main/assistant/agent/approval.js';

/**
 * 审批闸门（规格 §8）。
 *
 * 两条语义最容易做错：
 * 1. **「拒绝」不是终止任务**，是给模型一个否定的信号——
 *    模型可以换个参数再试。把它当异常抛出，agent 就只会「失败」。
 * 2. **「自动」是任务级的**：本任务内后续**同风险等级**的操作不再问，
 *    别的任务还要问。
 */

const READ_TOOL = { name: 'fs.read', label: '读文件', risk: 'read' };
const WRITE_TOOL = { name: 'fs.write', label: '写文件', risk: 'write' };
const EXEC_TOOL = { name: 'shell.exec', label: '执行命令', risk: 'exec' };

test('策略：graded 下只读自动放行', () => {
  assert.equal(decideApproval({ policy: 'graded', tool: READ_TOOL, risk: 'read' }), 'allow');
});

test('策略：graded 下写入与执行要问用户', () => {
  assert.equal(decideApproval({ policy: 'graded', tool: WRITE_TOOL, risk: 'write' }), 'ask');
  assert.equal(decideApproval({ policy: 'graded', tool: EXEC_TOOL, risk: 'exec' }), 'ask');
});

test('策略：manual 下全部要问，auto 下全部放行', () => {
  assert.equal(decideApproval({ policy: 'manual', tool: READ_TOOL, risk: 'read' }), 'ask');
  assert.equal(decideApproval({ policy: 'auto', tool: EXEC_TOOL, risk: 'exec' }), 'allow');
});

test('策略：永久放行的工具直接放行', () => {
  assert.equal(
    decideApproval({ policy: 'graded', allowAlways: ['shell.exec'], tool: EXEC_TOOL, risk: 'exec' }),
    'allow'
  );
});

test('闸门：只读工具不问用户', async () => {
  let asked = 0;
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { asked += 1; return 'allow'; },
  });
  const v = await gate.request({ tool: READ_TOOL, args: {}, risk: 'read' });
  assert.equal(v.allowed, true);
  assert.equal(asked, 0);
});

test('闸门：用户允许 → 放行', async () => {
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.ALLOW,
  });
  const v = await gate.request({ tool: EXEC_TOOL, args: { command: 'ls' }, risk: 'exec' });
  assert.equal(v.allowed, true);
});

test('闸门：用户拒绝 → 不放行，而且给模型一句能换路的话', async () => {
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.DENY,
  });
  const v = await gate.request({ tool: EXEC_TOOL, args: { command: 'ls' }, risk: 'exec' });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /拒绝|没获准/, '给模型的话要说清是用户拒绝了');
  assert.ok(v.userReason, '给用户的话也要有');
});

test('闸门：点「自动」后，本任务内同风险的后续调用不再问', async () => {
  let asked = 0;
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { asked += 1; return APPROVAL_DECISION.ALWAYS; },
  });
  const first = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(first.allowed, true);
  const second = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(second.allowed, true);
  assert.equal(asked, 1, '第二次不该再问');
});

test('闸门：点「自动」只管本任务——别的任务还要问', async () => {
  let asked = 0;
  const makeGate = () => createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { asked += 1; return APPROVAL_DECISION.ALWAYS; },
  });
  const a = makeGate();
  await a.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  const b = makeGate();
  const v = await b.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(v.allowed, true);
  assert.equal(asked, 2, '另一个任务还要问一次');
});

test('闸门：等待期间挂起，不占并发槽', async () => {
  const calls = [];
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { calls.push('ask'); return APPROVAL_DECISION.ALLOW; },
    hooks: {
      wait: async (reason) => { calls.push(`wait:${reason}`); },
      wake: () => { calls.push('wake'); },
    },
  });
  await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.deepEqual(calls, ['ask', 'wait:approval']);
});

test('闸门：没有问用户的渠道时，一律不放行', async () => {
  const gate = createApprovalGate({ getPolicy: () => 'graded' });
  const v = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(v.allowed, false);
});

test('闸门：任务被取消时，不放行', async () => {
  const controller = new AbortController();
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: () => new Promise(() => {}),   // 用户一直不答复
  });
  const pending = gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec', signal: controller.signal });
  controller.abort();
  const v = await pending;
  assert.equal(v.allowed, false);
});

test('闸门：每次决议都留一笔，给记录用', async () => {
  const seen = [];
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.ALLOW,
    onDecision: (e) => seen.push(e),
  });
  await gate.request({ tool: EXEC_TOOL, args: { command: 'ls' }, risk: 'exec' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'shell.exec');
  assert.equal(seen[0].decision, 'allow');
});

test('说明：给人看的一行话说清要做什么', () => {
  const text = describeToolCall({ name: 'shell.exec', label: '执行命令' }, { command: 'npm test' });
  assert.match(text, /npm test/);
  assert.match(text, /执行命令|命令/);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-approval.test.js"`

Expected: FAIL —— `src/main/assistant/agent/approval.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 实现闸门**

新建 `src/main/assistant/agent/approval.js`：

```js
import { TOOL_RISK } from '../../../shared/assistant.js';

/**
 * 审批闸门（规格 §8）。
 *
 * 闸门回答一个问题：**这个工具要不要用户点头。**
 *
 * ## 三个按钮的语义是不对称的，这是故意的
 *
 * - **允许**：本次放行这一次调用；
 * - **拒绝**：本次不给，**把「不给」喂回模型**——
 *   模型可以换个参数再试，而不是整个任务死掉；
 * - **自动**：本任务内，后续**同风险等级**的操作全部自动放行。
 *
 * 「拒绝」不是终止任务：把它当异常抛出，
 * agent 就只会「失败」，而不会「换条路」。
 */

/** 审批决议。 */
export const APPROVAL_DECISION = Object.freeze({
  /** 本次放行。 */
  ALLOW: 'allow',
  /** 本次不给（喂回模型）。 */
  DENY: 'deny',
  /** 本任务内同风险的后续调用都放行。 */
  ALWAYS: 'always',
});

/**
 * 判定一个工具要不要用户点头。
 *
 * @param {object} options
 * @param {'auto'|'graded'|'manual'} [options.policy]
 * @param {string[]} [options.allowAlways] 永久放行的工具名
 * @param {object} [options.tool] 工具描述符（取 name 与 risk）
 * @param {string} [options.risk] 生效的风险等级（工具表里已经算过）
 * @returns {'allow'|'ask'}
 */
export function decideApproval({ policy = 'graded', allowAlways = [], tool = {}, risk = '' } = {}) {
  const name = String(tool?.name || '');
  const level = String(risk || tool?.risk || TOOL_RISK.READ);
  // 永久放行：用户点过「信任这个工具」。
  if (Array.isArray(allowAlways) && allowAlways.includes(name)) return 'allow';
  const p = String(policy || 'graded');
  if (p === 'auto') return 'allow';
  if (p === 'manual') return 'ask';
  // graded：只读自动放行，写入与执行要问。
  return level === TOOL_RISK.READ ? 'allow' : 'ask';
}

/**
 * 造一个审批闸门。
 *
 * **一个闸门管一个任务**：「自动」是任务级的，
 * 所以「自动放行的风险等级」记在闸门实例里，不记在全局。
 *
 * @param {object} options
 * @param {Function} [options.getPolicy] 当前策略
 * @param {Function} [options.getAllowAlways] 永久放行的工具名
 * @param {Function} [options.ask]
 *   ({ taskId, tool, args, risk }) → Promise<'allow'|'deny'|'always'>
 *   问用户（审批气泡）。**没有它就一律不放行**——
 *   宁可什么都不做，也不能在用户没点头的情况下动他的机器。
 * @param {object} [options.hooks] 运行时的挂起接口（wait / wake）
 * @param {string} [options.taskId]
 * @param {Function} [options.onDecision] 每次决议留一笔（给记录用）
 */
export function createApprovalGate({
  getPolicy = () => 'graded',
  getAllowAlways = () => [],
  ask = null,
  hooks = null,
  taskId = '',
  onDecision = null,
} = {}) {
  /** 本任务里被「自动」放行的风险等级。 */
  const autoRisks = new Set();

  return {
    /**
     * 问一次：这个工具要不要放行。
     *
     * @returns {Promise<{allowed: boolean, reason?: string, userReason?: string}>}
     */
    async request({ tool = {}, args = {}, risk = '', signal = null } = {}) {
      const name = String(tool?.name || '');
      const level = String(risk || tool?.risk || TOOL_RISK.READ);

      // 本任务里点过「自动」：同风险等级的直接放行。
      if (autoRisks.has(level)) {
        return { allowed: true, decision: APPROVAL_DECISION.ALWAYS };
      }

      const verdict = decideApproval({
        policy: getPolicy(),
        allowAlways: getAllowAlways(),
        tool,
        risk: level,
      });
      if (verdict === 'allow') return { allowed: true, decision: APPROVAL_DECISION.ALLOW };

      if (typeof ask !== 'function') {
        return {
          allowed: false,
          reason: `「${name}」需要用户确认，但现在没有确认的渠道：请告诉用户这件事你做不到。`,
          userReason: '有个操作需要你确认，但当前没有确认的渠道，所以我没有动它。',
        };
      }

      // 问用户。**挂起期间不占并发槽**（规格 §7.2）。
      const pending = Promise.resolve(
        ask({ taskId, tool, args, risk: level })
      ).catch(() => APPROVAL_DECISION.DENY);
      if (hooks?.wait) {
        const waiting = hooks.wait('approval');
        pending.then(() => hooks.wake?.());
        await waiting;
      }
      // 任务被取消时，用户可能一直不答复：不能干等着。
      const outcome = await raceAbort(pending, signal);
      const decision = outcome === APPROVAL_DECISION.ALLOW || outcome === APPROVAL_DECISION.ALWAYS
        ? outcome
        : APPROVAL_DECISION.DENY;

      if (decision === APPROVAL_DECISION.ALWAYS) autoRisks.add(level);

      onDecision?.({
        taskId,
        tool: name,
        args,
        risk: level,
        decision,
      });

      if (decision === APPROVAL_DECISION.ALLOW || decision === APPROVAL_DECISION.ALWAYS) {
        return { allowed: true, decision };
      }
      return {
        allowed: false,
        reason: `用户拒绝了「${name}」这次调用`,
        userReason: `「${name}」这次没有获准。`,
      };
    },
  };
}

/**
 * 答复与取消赛跑。
 *
 * 任务被取消时，用户可能一直不答复——不能干等着。
 */
function raceAbort(pending, signal) {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(APPROVAL_DECISION.DENY);
  return Promise.race([
    pending,
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(APPROVAL_DECISION.DENY), { once: true });
    }),
  ]);
}

/**
 * 把一次工具调用说成**给人看**的一句话。
 *
 * 审批气泡上要写清楚「到底要干什么」——
 * 只写工具名的话，用户只能凭感觉点头。
 */
export function describeToolCall(tool = {}, args = {}) {
  const label = String(tool?.label || tool?.name || '这个操作');
  const parts = [];
  const a = args && typeof args === 'object' ? args : {};
  for (const [key, value] of Object.entries(a)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
  }
  return parts.length ? `${label}：${parts.join('，')}` : label;
}
```

- [x] **Step 4: 跑测试，确认它全绿**

Run: `node --test "test/unit/agent-approval.test.js"`

Expected: PASS —— 13 个测试全过。

- [x] **Step 5: 提交**

```bash
git add src/main/assistant/agent/approval.js test/unit/agent-approval.test.js
git commit -m "feat(助手): 审批闸门——三档策略、永久放行、拒绝喂回模型"
```

---

### Task 3: T12 分类记录

**Files:**
- Create: `src/main/assistant/agent/record.js`
- Test: `test/unit/agent-task-record.test.js`

**Interfaces:**
- Consumes: `src/shared/assistant.js` 的 `CHAT_KIND`、`TASK_STATUS`
- Produces:
  - `src/main/assistant/agent/record.js`：
    - `TASK_STATUS_TEXT`（状态 → 中文短句）
    - `taskRecord({ taskId, status, title, at }) → ChatEntry`
    - `stepRecord({ taskId, index, tool, args, result, error, at }) → ChatEntry`
    - `approvalRecord({ taskId, tool, args, risk, decision, at }) → ChatEntry`
    - `interruptedTasks(messages) → [{ taskId, title }]`

**描述：** 这些条目走 `chat/memory.js` 的 `appendMessage` 落盘，
所以形状要与 `normalizeChatEntry` 一致：`{ kind, role, text, at, meta }`。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-task-record.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_STATUS_TEXT,
  approvalRecord,
  interruptedTasks,
  stepRecord,
  taskRecord,
} from '../../src/main/assistant/agent/record.js';
import { CHAT_KIND, CHAT_KIND_FOR_MODEL, TASK_STATUS } from '../../src/shared/assistant.js';
import { appendMessage } from '../../src/main/assistant/chat/memory.js';
import { buildChatMessages } from '../../src/main/assistant/chat/prompt.js';

/**
 * 分类记录（规格 §4.2 的 task / step / approval 三类）。
 *
 * 最要紧的一条：**这三类记录绝不能进模型上下文**——
 * 它们是给人看的，进了上下文会把对话冲垮，
 * 而且症状是「模型突然变笨」而不是报错，极难排查。
 */

test('任务记录：分类与形状与规格一致', () => {
  const entry = taskRecord({ taskId: 't1', status: TASK_STATUS.RUNNING, title: '查天气' });
  assert.equal(entry.kind, CHAT_KIND.TASK);
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.meta.taskId, 't1');
  assert.equal(entry.meta.status, 'running');
  assert.equal(entry.meta.title, '查天气');
  assert.match(entry.text, /查天气/);
});

test('步骤记录：带工具名、参数与结果', () => {
  const entry = stepRecord({ taskId: 't1', index: 2, tool: 'fs.read', args: { path: 'a.txt' }, result: '内容' });
  assert.equal(entry.kind, CHAT_KIND.STEP);
  assert.equal(entry.meta.index, 2);
  assert.equal(entry.meta.tool, 'fs.read');
  assert.deepEqual(entry.meta.args, { path: 'a.txt' });
  assert.equal(entry.meta.result, '内容');
});

test('步骤记录：出错时也留一笔，错在 meta 里', () => {
  const entry = stepRecord({ taskId: 't1', index: 3, tool: 'shell.exec', error: '炸了' });
  assert.equal(entry.kind, CHAT_KIND.STEP);
  assert.equal(entry.meta.error, '炸了');
});

test('审批记录：带工具与决议', () => {
  const entry = approvalRecord({ taskId: 't1', tool: 'shell.exec', args: { command: 'ls' }, risk: 'exec', decision: 'allow' });
  assert.equal(entry.kind, CHAT_KIND.APPROVAL);
  assert.equal(entry.meta.tool, 'shell.exec');
  assert.equal(entry.meta.risk, 'exec');
  assert.equal(entry.meta.decision, 'allow');
});

test('中断检测：上次退出时还在跑的任务被找出来', () => {
  const messages = [
    taskRecord({ taskId: 't1', status: TASK_STATUS.QUEUED, title: '甲' }),
    taskRecord({ taskId: 't1', status: TASK_STATUS.RUNNING, title: '甲' }),
    taskRecord({ taskId: 't2', status: TASK_STATUS.DONE, title: '乙' }),
  ];
  const list = interruptedTasks(messages);
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, 't1');
  assert.equal(list[0].title, '甲');
});

test('中断检测：等审批中的任务也算中断', () => {
  const messages = [taskRecord({ taskId: 't1', status: TASK_STATUS.WAITING_APPROVAL, title: '甲' })];
  assert.equal(interruptedTasks(messages).length, 1);
});

test('中断检测：没有任务就空数组', () => {
  assert.deepEqual(interruptedTasks([]), []);
  assert.deepEqual(interruptedTasks([{ kind: 'user', text: '在呢' }]), []);
});

test('关键：这三种记录一律不进模型上下文', () => {
  const messages = [];
  messages.push(...appendMessage(messages, { kind: CHAT_KIND.USER, role: 'user', text: '帮我查天气' }));
  messages.push(...appendMessage(messages, taskRecord({ taskId: 't1', status: TASK_STATUS.RUNNING, title: '查天气' })));
  messages.push(...appendMessage(messages, stepRecord({ taskId: 't1', index: 1, tool: 'fs.read', result: 'x' })));
  messages.push(...appendMessage(messages, approvalRecord({ taskId: 't1', tool: 'fs.read', decision: 'allow' })));
  messages.push(...appendMessage(messages, { kind: CHAT_KIND.REPLY, role: 'assistant', text: '今天晴' }));

  const convo = buildChatMessages({ history: messages, userText: '再说一句' });
  const texts = convo.map((m) => m.content);
  assert.ok(texts.includes('帮我查天气'));
  assert.ok(texts.includes('今天晴'));
  assert.ok(!texts.some((t) => String(t).includes('fs.read')), '步骤不能进上下文');
  assert.ok(!texts.some((t) => String(t).includes('查天气 ·')), '任务状态不能进上下文');
  // 只有 user 与 reply 两种分类进上下文。
  assert.ok(CHAT_KIND_FOR_MODEL.every((k) => k === CHAT_KIND.USER || k === CHAT_KIND.REPLY));
});

test('状态短句：每个状态都有一句人话', () => {
  for (const status of Object.values(TASK_STATUS)) {
    assert.ok(TASK_STATUS_TEXT[status], `${status} 没有对应的话`);
  }
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-task-record.test.js"`

Expected: FAIL —— `src/main/assistant/agent/record.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 实现记录模块**

新建 `src/main/assistant/agent/record.js`：

```js
import { CHAT_KIND, TASK_STATUS } from '../../../shared/assistant.js';

/**
 * agent 的分类记录（规格 §4.2）。
 *
 * 聊天记录现在有五种分类：user / reply / task / step / approval。
 * 前两种是**给模型看的**，后三种是**给人看的**——
 * 它们绝不能进模型上下文（见 chat/prompt.js 的过滤）。
 *
 * 这里只造条目，不落盘：落盘走 chat/memory.js 的 `appendMessage`，
 * 那边的分路截断才对。
 */

/** 任务状态的中文短句（给记录与气泡用）。 */
export const TASK_STATUS_TEXT = Object.freeze({
  [TASK_STATUS.QUEUED]: '排队中',
  [TASK_STATUS.RUNNING]: '进行中',
  [TASK_STATUS.WAITING_APPROVAL]: '等你点头',
  [TASK_STATUS.DONE]: '完成',
  [TASK_STATUS.FAILED]: '失败',
  [TASK_STATUS.CANCELLED]: '已取消',
  [TASK_STATUS.INTERRUPTED]: '已中断',
});

/** 任务状态变化的一条记录。 */
export function taskRecord({ taskId = '', status = '', title = '', at = Date.now() } = {}) {
  const label = TASK_STATUS_TEXT[status] || String(status || '');
  return {
    kind: CHAT_KIND.TASK,
    role: 'assistant',
    text: title ? `${label} · ${title}` : label,
    at,
    meta: { taskId, status, title },
  };
}

/** 任务中的一次工具调用。 */
export function stepRecord({
  taskId = '',
  index = 0,
  tool = '',
  args = null,
  result = '',
  error = '',
  at = Date.now(),
} = {}) {
  const name = String(tool || '工具');
  return {
    kind: CHAT_KIND.STEP,
    role: 'assistant',
    text: error ? `${name} 出错：${error}` : name,
    at,
    meta: { taskId, index, tool: name, args, result, error },
  };
}

/** 一次审批请求与它的决议。 */
export function approvalRecord({
  taskId = '',
  tool = '',
  args = null,
  risk = '',
  decision = '',
  at = Date.now(),
} = {}) {
  const name = String(tool || '工具');
  const label =
    decision === 'allow' ? '已允许' : decision === 'always' ? '本任务内自动放行' : '已拒绝';
  return {
    kind: CHAT_KIND.APPROVAL,
    role: 'assistant',
    text: `${name}：${label}`,
    at,
    meta: { taskId, tool: name, args, risk, decision },
  };
}

/** 到终态的状态：这些任务不用再管了。 */
const FINAL_STATUS = new Set([
  TASK_STATUS.DONE,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED,
  TASK_STATUS.INTERRUPTED,
]);

/**
 * 找出**上次退出时还在跑**的任务（规格 §7.4）。
 *
 * 任务本体不持久化：跑着的 shell 子进程在应用退出时已经死了，
 * 假装能恢复是自欺欺人。所以在记录里标一句「已中断」就够了。
 *
 * 判据：每个任务号**最后一条**状态记录不是终态 → 它当时还在跑。
 */
export function interruptedTasks(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const latest = new Map();
  for (const item of list) {
    if (item?.kind !== CHAT_KIND.TASK) continue;
    const taskId = String(item?.meta?.taskId || '');
    if (!taskId) continue;
    latest.set(taskId, { taskId, title: String(item?.meta?.title || ''), status: String(item?.meta?.status || '') });
  }
  return [...latest.values()].filter((t) => !FINAL_STATUS.has(t.status));
}
```

- [x] **Step 4: 跑测试，确认它全绿**

Run: `node --test "test/unit/agent-task-record.test.js"`

Expected: PASS —— 8 个测试全过。

- [x] **Step 5: 提交**

```bash
git add src/main/assistant/agent/record.js test/unit/agent-task-record.test.js
git commit -m "feat(助手): agent 的分类记录——任务、步骤、审批三类条目"
```

---

### Task 4: T11 审批气泡

**Files:**
- Create: `src/main/bubbleApproval.js`（**不引 electron** 的审批 inbox，好单测）
- Modify: `src/main/bubble.js`（sticky 形态 + 能点）
- Modify: `src/preload/bubble.cjs`（`onApproval` / `respondApproval`）
- Modify: `src/renderer/bubble/index.html`（按钮行）
- Modify: `src/renderer/bubble/main.js`（渲染与回传）
- Test: `test/unit/bubble-approval.test.js`

**Interfaces:**
- Produces:
  - `src/main/bubbleApproval.js`：
    - `createApprovalInbox()` → `{ request({ id, title, text, risk }) → Promise<'allow'|'deny'|'always'>, respond({ id, decision }) → boolean, pending() → number, clear() }`
  - `src/main/bubble.js`：`bubble.showApproval({ id, title, text, risk }) → Promise<'allow'|'deny'|'always'>`
  - `src/preload/bubble.cjs`：`window.bubble.onApproval(cb)` / `window.bubble.respondApproval({ id, decision })`

- [x] **Step 1: 写失败的测试**

创建 `test/unit/bubble-approval.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalInbox } from '../../src/main/bubbleApproval.js';

/**
 * 审批气泡的「等答复」这件事（规格 §8.2）。
 *
 * 抽成不引 electron 的小模块，是为了能单测：
 * 主进程的气泡控制器引了 electron，在普通 node 里测不了。
 *
 * 最要紧的一条：**决议要按 id 认**——
 * 两个任务同时要审批时，第二个的答复不能把第一个的搞混。
 */

test('审批：请求之后，答复按 id 兑现', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', title: '要点头', text: '跑命令？' });
  assert.equal(inbox.pending(), 1);
  assert.equal(inbox.respond({ id: 'a1', decision: 'allow' }), true);
  assert.equal(await p, 'allow');
  assert.equal(inbox.pending(), 0);
});

test('审批：两个请求各归各的', async () => {
  const inbox = createApprovalInbox();
  const a = inbox.request({ id: 'a1', text: '甲' });
  const b = inbox.request({ id: 'a2', text: '乙' });
  inbox.respond({ id: 'a2', decision: 'deny' });
  assert.equal(await b, 'deny');
  inbox.respond({ id: 'a1', decision: 'allow' });
  assert.equal(await a, 'allow');
});

test('审批：不认识的 id 不算数，也不抛错', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', text: '甲' });
  assert.equal(inbox.respond({ id: 'nope', decision: 'allow' }), false);
  inbox.respond({ id: 'a1', decision: 'deny' });
  assert.equal(await p, 'deny');
});

test('审批：没见过的决议按拒绝算', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', text: '甲' });
  inbox.respond({ id: 'a1', decision: '乱写的' });
  assert.equal(await p, 'deny');
});

test('审批：取消（clear）让挂着的请求都有个交代', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', text: '甲' });
  inbox.clear();
  assert.equal(await p, 'deny');
  assert.equal(inbox.pending(), 0);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/bubble-approval.test.js"`

Expected: FAIL —— `src/main/bubbleApproval.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 实现审批 inbox**

新建 `src/main/bubbleApproval.js`：

```js
/**
 * 审批气泡的「等答复」这件事。
 *
 * 为什么要单独一个文件：气泡控制器（src/main/bubble.js）引了 electron，
 * 在普通 node 里测不了。而「答复按 id 认」「没人管时要有个交代」
 * 这两件事最容易做错，必须能单测，所以抽出来。
 *
 * ## 决议只有三种
 *
 * allow（本次放行）/ deny（本次不给）/ always（本任务内同风险都放行）。
 * **不认识的一律当 deny**——宁可多问一次，也不要因为一个坏值就放行。
 */

/** 合法的决议。 */
const DECISIONS = new Set(['allow', 'deny', 'always']);

export function createApprovalInbox() {
  /** id → { resolve, payload }。 */
  const waiting = new Map();

  return {
    /**
     * 挂一个审批请求，等用户的答复。
     *
     * @param {object} request { id, title, text, risk }
     * @returns {Promise<'allow'|'deny'|'always'>}
     */
    request(request) {
      const id = String(request?.id || '');
      if (!id) return Promise.resolve('deny');
      return new Promise((resolve) => {
        waiting.set(id, { resolve, request });
      });
    },

    /**
     * 用户答复了。
     *
     * @returns {boolean} 有没有对上号（对不上就别乱改状态）
     */
    respond({ id, decision } = {}) {
      const key = String(id || '');
      const item = waiting.get(key);
      if (!item) return false;
      waiting.delete(key);
      const d = String(decision || '');
      item.resolve(DECISIONS.has(d) ? d : 'deny');
      return true;
    },

    /** 还有几个在等。 */
    pending() {
      return waiting.size;
    },

    /** 全都作废（应用退出、气泡被关掉）：挂着的请求要有交代。 */
    clear() {
      for (const item of waiting.values()) item.resolve('deny');
      waiting.clear();
    },
  };
}
```

- [x] **Step 4: 跑测试，确认它全绿**

Run: `node --test "test/unit/bubble-approval.test.js"`

Expected: PASS —— 5 个测试全过。

- [x] **Step 5: 给气泡控制器加 sticky 的审批形态**

改 `src/main/bubble.js`：

1. 顶部导入 `createApprovalInbox`；
2. 控制器里造一个 `const approvals = createApprovalInbox();`；
3. 加 `showApproval({ id, title, text, risk })`：

```js
  /**
   * 显示一条**要用户点头**的消息（审批气泡）。
   *
   * 与普通气泡有两点不同：
   * 1. **不自动消失**：它一直挂着等用户点（规格 §8.2）。
   *    `ttlMs: 0` 表达不了这个——`scheduleHide` 会把它退回默认 TTL，
   *    所以这里干脆不装计时器。
   * 2. **能点**：普通气泡永远点击穿透（不然会挡住桌面点击），
   *    审批气泡是唯一例外——它有按钮要让人点。
   *
   * @returns {Promise<'allow'|'deny'|'always'>} 用户的答复
   */
  function showApproval({ id, title = '', text = '', risk = '' } = {}) {
    const key = String(id || `approval-${++approvalSeq}`);
    // 审批是**阻塞**的：它卡在任务的关键路径上，
    // 别的消息排后面（用户得先点头，任务才能继续）。
    if (streamId) cancelStream();
    clearTimer();
    const payload = { approvalId: key, title, text, risk };
    if (!win || win.isDestroyed()) {
      createWindow();
      pending.push({ type: 'approval', payload, id: key });
      return approvals.request({ id: key, title, text, risk });
    }
    if (!ready) {
      pending.push({ type: 'approval', payload, id: key });
      return approvals.request({ id: key, title, text, risk });
    }
    setInteractive(true);
    send('pet:bubbleApproval', payload);
    return approvals.request({ id: key, title, text, risk });
  }
```

4. 加 `setInteractive(on)`：

```js
  /**
   * 气泡能不能点。
   *
   * 普通气泡永远**点击穿透**（Windows 没有逐像素命中测试，
   * 整个窗口矩形都是热区——气泡吃了桌面点击，用户会以为桌面坏了）。
   * 审批气泡是唯一例外：它有按钮。
   */
  function setInteractive(on) {
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!on, { forward: true });
    win.setFocusable(Boolean(on));
  }
```

5. `ipcMain.on('pet:bubbleReady')` 里补发审批：

```js
    while (pending.length > 0) {
      const item = pending.shift();
      if (item.type === 'stream') startStream(item.payload);
      else if (item.type === 'approval') {
        setInteractive(true);
        send('pet:bubbleApproval', item.payload);
      } else deliver(item.payload);
    }
```

6. 页面答复的通道：

```js
  // 用户在审批气泡上点了按钮。
  ipcMain.on('pet:bubbleApprovalResponse', (event, payload) => {
    if (!win || event.sender !== win.webContents) return;
    const ok = approvals.respond(payload || {});
    if (!ok) return;
    setInteractive(false);
    // 答复完就把气泡收起来：它已经没用了。
    if (win && !win.isVisible()) return;
    send('pet:bubbleApprovalDone', { approvalId: payload?.id });
    hide();
  });
```

7. `hide()` 里要把审批收干净：

```js
  function hide() {
    clearTimer();
    cancelStream({ hide: false });
    currentMessage = null;
    oneShotSide = null;
    // 审批气泡被收走时，挂着的请求要有交代——
    // 不然任务会一直等下去（槽位也回不来）。
    approvals.clear();
    setInteractive(false);
    if (!win || win.isDestroyed()) return;
    send('pet:bubbleHide');
    win.hide();
  }
```

8. 对外加上 `showApproval`。

> **注意**：`hide()` 里调用 `approvals.clear()` 会把所有挂着的审批都作废——
> 这是有意的（气泡只有一只，收走它就意味着用户没机会答了）。
> 但 `respondApproval` 走的是 `approvals.respond()`，它先把那一条摘掉，
> 所以正常答复不受影响。

改 `src/preload/bubble.cjs`：

```js
  // —— 审批气泡（要用户点头）——
  // 主进程要弹一条带按钮的审批。
  onApproval: (cb) => {
    ipcRenderer.on('pet:bubbleApproval', (_e, payload) => cb(payload));
  },
  // 审批办完了：把气泡收起来。
  onApprovalDone: (cb) => {
    ipcRenderer.on('pet:bubbleApprovalDone', (_e, payload) => cb(payload));
  },
  // 用户按了按钮。
  respondApproval: (payload) => ipcRenderer.send('pet:bubbleApprovalResponse', payload),
```

改 `src/renderer/bubble/index.html`：在 `#text` 后面加按钮行，并加样式。

```html
    #actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    #actions:empty { display: none; }
    #actions button {
      font: 13px/1 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      color: #4a4235;
      background: #f3ecdd;
      border: 1px solid #d8d2c4;
      border-radius: 8px;
      padding: 6px 12px;
      cursor: pointer;
    }
    #actions button:hover { background: #e9dfc9; }
    #actions button[data-decision="allow"] { color: #2f6b3d; }
    #actions button[data-decision="deny"] { color: #8a3b32; }
```

```html
  <div id="bubble" data-placement="top">
    <div id="title"></div>
    <div id="text"></div>
    <div id="actions"></div>
    <div id="tail"></div>
  </div>
```

改 `src/renderer/bubble/main.js`：

```js
const actionsEl = document.getElementById('actions');

/** 当前挂着的审批 id：没有审批时是 null。 */
let approvalId = null;

/** 渲染审批的三个按钮。 */
function renderApproval(payload) {
  approvalId = payload?.approvalId ?? null;
  actionsEl.textContent = '';
  if (!approvalId) return;
  const buttons = [
    { decision: 'allow', text: '允许' },
    { decision: 'deny', text: '拒绝' },
    { decision: 'always', text: '自动' },
  ];
  for (const item of buttons) {
    const button = document.createElement('button');
    button.textContent = item.text;
    button.dataset.decision = item.decision;
    button.addEventListener('click', () => {
      window.bubble?.respondApproval?.({ id: approvalId, decision: item.decision });
      approvalId = null;
      actionsEl.textContent = '';
    });
    actionsEl.append(button);
  }
  bubble.classList.remove('hidden');
  reportSize(true);
}
```

并在 `render()` / `onHide` 里把按钮清空，另外注册监听：

```js
window.bubble?.onApproval?.((payload) => renderApproval(payload));

window.bubble?.onApprovalDone?.(() => {
  approvalId = null;
  actionsEl.textContent = '';
});
```

> `render()`（普通消息）也要把按钮清掉：审批气泡之后又来了一条普通消息，
> 按钮留着会让用户点一个已经作废的审批。

- [x] **Step 6: 跑测试，确认它全绿**

Run: `node --test "test/unit/bubble-approval.test.js"`

Expected: PASS —— 5 个测试全过。

- [x] **Step 7: 提交**

```bash
git add src/main/bubble.js src/main/bubbleApproval.js src/preload/bubble.cjs \
        src/renderer/bubble/index.html src/renderer/bubble/main.js \
        test/unit/bubble-approval.test.js
git commit -m "feat(助手): 审批气泡——三个按钮、不自动消失、能点"
```

---

### Task 5: 接线——任务中枢与助理

**Files:**
- Create: `src/main/assistant/agent/tasks.js`
- Modify: `src/main/assistant/chat/agent.js`（接受 `ctx.gate`）
- Modify: `src/main/assistant/index.js`（接线运行时、闸门、记录、通知、重启标中断）
- Modify: `src/main/assistant/agent/facade.js`（把运行时接上）
- Test: `test/unit/agent-tasks.test.js`

**Interfaces:**
- Consumes: `runtime.js`、`approval.js`、`record.js`
- Produces:
  - `src/main/assistant/agent/tasks.js`：
    - `createAgentTasks({ backend, ask, getMessages, appendRecord, notify, onEvent, getMaxConcurrent, getPolicy, getAllowAlways, logger })`
    - `tasks.submit({ prompt, title, messages, config, onDelta, foreground }) → { ok, taskId, done }`
    - `tasks.cancel(taskId)` / `tasks.list()`

**描述：** `done` 兑现的是**后端的返回**（与 `backend.chat` 一样），
这样前台路径（用户发话）能直接把它当成一次对话的结果。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-tasks.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentTasks } from '../../src/main/assistant/agent/tasks.js';
import { TASK_STATUS } from '../../src/shared/assistant.js';

/**
 * 任务中枢：把运行时、闸门、后端、记录、通知缝在一起。
 *
 * 这是 L3 唯一「什么都碰」的地方，所以它必须**不引 electron**——
 * 这样整条链路（提交 → 审批 → 执行 → 记录 → 通知）都能在普通 node 里跑一遍。
 */

/** 等一拍，让队列与 promise 走完。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 造一个假后端：把要干的活记下来，按需调闸门。 */
function fakeBackend(actions = []) {
  return {
    id: 'agent',
    chat: async (ctx) => {
      actions.push({ type: 'chat', messages: ctx.messages, gate: ctx.gate });
      if (ctx.gate) {
        const v = await ctx.gate.request({ tool: { name: 'shell.exec', risk: 'exec' }, args: { command: 'ls' }, risk: 'exec' });
        actions.push({ type: 'gate', allowed: v.allowed });
        if (!v.allowed) return { text: '用户不让我跑', emotion: 'neutral', mood: 0, memories: [] };
      }
      return { text: '做完了', emotion: 'happy', mood: 1, memories: [] };
    },
  };
}

test('中枢：提交一个任务，结果回来了', async () => {
  const tasks = createAgentTasks({ backend: fakeBackend() });
  const t = tasks.submit({ prompt: '查天气', messages: [{ role: 'user', content: '查天气' }] });
  assert.equal(t.ok, true);
  const result = await t.done;
  assert.equal(result.text, '做完了');
});

test('中枢：审批被拒绝时，工具不执行，但任务继续', async () => {
  const actions = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(actions),
    getPolicy: () => 'graded',
    ask: async () => 'deny',
  });
  const t = tasks.submit({ prompt: '跑个命令', messages: [{ role: 'user', content: '跑个命令' }] });
  const result = await t.done;
  const gate = actions.find((a) => a.type === 'gate');
  assert.equal(gate.allowed, false);
  assert.equal(result.text, '用户不让我跑', '拒绝要喂回模型，而不是让任务崩掉');
});

test('中枢：审批通过时，任务照常做完', async () => {
  const actions = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(actions),
    getPolicy: () => 'graded',
    ask: async () => 'allow',
  });
  const t = tasks.submit({ prompt: '跑个命令', messages: [{ role: 'user', content: '跑个命令' }] });
  const result = await t.done;
  assert.equal(actions.find((a) => a.type === 'gate').allowed, true);
  assert.equal(result.text, '做完了');
});

test('中枢：任务状态变化写进记录', async () => {
  const records = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    appendRecord: (entry) => records.push(entry),
  });
  const t = tasks.submit({ prompt: '查天气', messages: [] });
  await t.done;
  const kinds = records.map((r) => r.kind);
  assert.ok(kinds.includes('task'), '要有任务状态记录');
  assert.equal(records[0].meta.status, TASK_STATUS.QUEUED);
});

test('中枢：审批留一笔记录', async () => {
  const records = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    getPolicy: () => 'graded',
    ask: async () => 'allow',
    appendRecord: (entry) => records.push(entry),
  });
  const t = tasks.submit({ prompt: '跑个命令', messages: [] });
  await t.done;
  const approval = records.find((r) => r.kind === 'approval');
  assert.ok(approval, '要有审批记录');
  assert.equal(approval.meta.decision, 'allow');
});

test('中枢：后台任务做完了要通知用户', async () => {
  const notices = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    notify: (n) => notices.push(n),
  });
  const t = tasks.submit({ prompt: '查天气', messages: [], foreground: false });
  await t.done;
  await tick();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /做完了/);
});

test('中枢：前台任务不通知——回复气泡就是它', async () => {
  const notices = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    notify: (n) => notices.push(n),
  });
  const t = tasks.submit({ prompt: '查天气', messages: [], foreground: true });
  await t.done;
  await tick();
  assert.equal(notices.length, 0);
});

test('中枢：事件带着任务号转发出去', async () => {
  const events = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    onEvent: (e) => events.push(e),
  });
  const t = tasks.submit({ prompt: '查天气', messages: [] });
  await t.done;
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.taskId === t.taskId), '每个事件都要带任务号');
});

test('中枢：取消一个任务', async () => {
  const tasks = createAgentTasks({ backend: fakeBackend() });
  const t = tasks.submit({ prompt: '查天气', messages: [] });
  assert.equal(tasks.cancel(t.taskId).ok, true);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-tasks.test.js"`

Expected: FAIL —— `src/main/assistant/agent/tasks.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 实现任务中枢**

新建 `src/main/assistant/agent/tasks.js`：

```js
import { createAgentRuntime } from './runtime.js';
import { createApprovalGate } from './approval.js';
import { approvalRecord, stepRecord, taskRecord } from './record.js';

/**
 * agent 任务的中枢。
 *
 * 把五样东西缝在一起：
 * - **运行时**（runtime.js）：队列、并发、取消；
 * - **闸门**（approval.js）：要不要用户点头；
 * - **后端**（chat/agent.js）：真正跑那个多步循环；
 * - **记录**（record.js）：任务、步骤、审批写进聊天记录；
 * - **通知**：任务做完了/失败了要告诉用户。
 *
 * ## 为什么它不引 electron
 *
 * 这一层是整条链路（提交 → 审批 → 执行 → 记录 → 通知）的枢纽，
 * 必须能在普通 node 里跑一遍——不然「审批拒绝了任务还能不能继续」
 * 这种最要紧的事只能靠手点。
 */

/**
 * 造一个任务中枢。
 *
 * @param {object} options
 * @param {object} options.backend agent 后端（chat/agent.js 造出来的那个）
 * @param {Function} [options.ask] 问用户：({taskId, tool, args, risk}) → Promise<'allow'|'deny'|'always'>
 * @param {Function} [options.getMessages] 后台任务的对话上下文
 * @param {Function} [options.appendRecord] 写一条分类记录
 * @param {Function} [options.notify] 通知用户：({ title, text, ok })
 * @param {Function} [options.onEvent] 事件转发（给插件）
 * @param {Function} [options.getMaxConcurrent] 同时跑几个任务
 * @param {Function} [options.getPolicy] 审批策略
 * @param {Function} [options.getAllowAlways] 永久放行的工具名
 */
export function createAgentTasks({
  backend = null,
  ask = null,
  getMessages = null,
  appendRecord = () => {},
  notify = () => {},
  onEvent = () => {},
  getMaxConcurrent = () => 1,
  getPolicy = () => 'graded',
  getAllowAlways = () => [],
  logger = console,
  now = () => Date.now(),
} = {}) {
  /** 把一个事件转成记录。 */
  function recordFor(event) {
    if (event.type === 'step') {
      return stepRecord({
        taskId: event.taskId,
        index: event.index,
        tool: event.tool,
        args: event.args,
        result: event.result,
        error: event.error,
        at: event.at,
      });
    }
    if (event.type === 'approval') {
      return approvalRecord({
        taskId: event.taskId,
        tool: event.tool,
        args: event.args,
        risk: event.risk,
        decision: event.decision,
        at: event.at,
      });
    }
    if (event.type === 'task') {
      return taskRecord({
        taskId: event.taskId,
        status: event.status,
        title: event.title,
        at: event.at,
      });
    }
    return null;
  }

  /** 事件往外走一份、往记录里落一份。 */
  function publish(event) {
    try {
      onEvent?.(event);
    } catch (err) {
      logger?.warn?.('[desk-pet] agent 事件的订阅者出错：', err?.message);
    }
    const entry = recordFor(event);
    if (entry) {
      try {
        appendRecord(entry);
      } catch (err) {
        logger?.warn?.('[desk-pet] agent 记录写不进去：', err?.message);
      }
    }
  }

  const runtime = createAgentRuntime({
    getMaxConcurrent,
    onEvent: publish,
    logger,
    now,
  });

  return {
    /** 运行时（插件与设置界面要看任务列表时用）。 */
    runtime,

    /**
     * 提交一个任务。
     *
     * @param {object} job
     * @param {string} job.prompt 任务的内容
     * @param {string} [job.title] 一句话说明
     * @param {Array} [job.messages] 对话上下文（不给就用 getMessages 造）
     * @param {object} [job.config] 大模型配置
     * @param {Function} [job.onDelta] 流式增量
     * @param {boolean} [job.foreground] 前台任务（用户的对话）不弹完成通知
     * @returns {{ok: boolean, taskId: string, done: Promise<object>}}
     */
    submit({
      prompt = '',
      title = '',
      messages = null,
      config = {},
      onDelta = null,
      foreground = false,
    } = {}) {
      const text = String(prompt || '');
      const job = runtime.submit({
        title: title || shortTitle(text),
        prompt: text,
        run: async (scope) => {
          // 闸门是**每个任务一个**：「自动」是任务级的。
          const gate = createApprovalGate({
            getPolicy,
            getAllowAlways,
            ask,
            hooks: scope.hooks,
            taskId: scope.taskId,
            onDecision: (decision) =>
              publish({ type: 'approval', taskId: scope.taskId, at: now(), ...decision }),
          });
          const convo = Array.isArray(messages)
            ? messages
            : typeof getMessages === 'function'
              ? getMessages(text)
              : [{ role: 'user', content: text }];
          const result = await backend.chat({
            messages: convo,
            config,
            onDelta,
            onEvent: (event) => publish({ ...event, taskId: scope.taskId, at: now() }),
            gate,
            signal: scope.signal,
            trigger: 'user',
          });
          return result;
        },
      });

      // 后台任务做完了要告诉用户；前台任务的回复气泡已经说过了。
      if (!foreground) {
        void job.done.then(
          (result) => {
            notify({
              title: job.title,
              text: result?.text || '这件事做完了',
              ok: true,
            });
          },
          (err) => {
            notify({
              title: job.title,
              text: `这件事没做成：${err?.message || err}`,
              ok: false,
            });
          }
        );
      }
      return job;
    },

    /** 取消一个任务。 */
    cancel(taskId) {
      return runtime.cancel(taskId);
    },

    /** 任务列表。 */
    list() {
      return runtime.list();
    },
  };
}

/** 取一句话说明：太长了就截断。 */
function shortTitle(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}
```

- [x] **Step 4: 跑测试，确认它全绿**

Run: `node --test "test/unit/agent-tasks.test.js"`

Expected: PASS —— 9 个测试全过。

- [x] **Step 5: 后端接受每个任务的闸门**

改 `src/main/assistant/chat/agent.js`：

```js
    async chat(ctx) {
      const { messages = [], config = {}, onDelta, onEvent, signal } = ctx;
      // 闸门是**每个任务一个**（「自动」是任务级的），
      // 所以由调用方按任务给；没给就用全局那个。
      const gate = ctx.gate ?? getGate();
```

并把 `gate: getGate(),` 改成 `gate,`。

- [x] **Step 6: 把运行时接进助理**

改 `src/main/assistant/index.js`：

1. 引入：

```js
import { createAgentTasks } from './agent/tasks.js';
import { interruptedTasks, taskRecord } from './agent/record.js';
```

2. 在 `createAgentBackend(...)` 之后造任务中枢：

```js
  // ------------------------------------------------------------------
  // agent 的任务中枢（L3）
  //
  // agent 模式下**每句话都是一个任务**：排队、并发、取消都在运行时里。
  // 审批也是任务级的事——所以闸门由中枢按任务造。
  // ------------------------------------------------------------------
  const agentTasks = createAgentTasks({
    backend: agentBackend,
    // 问用户：审批气泡。气泡只有一个，挂着的审批会互相顶——
    // 所以这里按 id 认（bubble.js 里的 inbox 管这个）。
    ask: ({ taskId, tool, args, risk }) =>
      bubble.showApproval({
        id: taskId,
        title: '需要你点头',
        text: describeToolCall(tool, args),
        risk,
      }),
    getMessages: (prompt) =>
      buildChatMessages({ history: state?.chat?.messages || [], userText: prompt, trigger: 'user' }),
    appendRecord: (entry) => {
      if (!state) return;
      state.chat.messages = appendMessage(state.chat.messages, entry);
      scheduleSave();
    },
    notify: ({ title, text, ok }) => {
      say(text, { emotion: ok ? 'happy' : 'sad', sound: ok ? 'success' : '' });
    },
    onEvent: (event) => agentFacade.emit(event),
    getMaxConcurrent: () => state?.agent?.maxConcurrent || DEFAULT_AGENT.maxConcurrent,
    getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
    getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
    logger: console,
  });
```

3. 把 agent 后端**包一层**，让它走任务运行时：

```js
  // agent 后端：**每句话都是一个后台任务**（规格 §7）。
  //
  // 包一层的理由：普通对话是一次调用就结束，
  // agent 是排队 + 并发 + 取消——那些都在运行时里。
  backends.register(
    'agent',
    {
      id: 'agent',
      label: 'agent 模式',
      async chat(ctx) {
        const task = agentTasks.submit({
          prompt: ctx.prompt || '',
          messages: ctx.messages,
          config: ctx.config,
          onDelta: ctx.onDelta,
          foreground: true,
        });
        return task.done;
      },
    }
  );
```

4. `runChat` 里给后端补上 `prompt`：

```js
      result = await backend.chat({
        system,
        messages,
        prompt: content,
        trigger,
        config,
        ...
```

5. 把运行时接给 facade（插件的 `ctx.agent.run`）：

```js
  const agentFacade = createAgentFacade({
    tools: toolRegistry,
    runtime: {
      run: async (prompt, opts) => {
        const task = agentTasks.submit({
          prompt,
          title: opts?.title || '',
          foreground: false,
        });
        return { ok: true, taskId: task.taskId };
      },
      cancel: async (taskId) => agentTasks.cancel(taskId),
      history: () => chatHistoryView().messages,
    },
    getHistory: () => chatHistoryView().messages,
  });
```

6. **重启后标中断**（规格 §7.4）：在 `start()` 里读完状态之后：

```js
      // 上次退出时还在跑的任务：在记录里标一句「已中断」。
      //
      // **不尝试恢复**：跑着的 shell 子进程早就死了，
      // 假装能恢复是自欺欺人。
      const interrupted = interruptedTasks(state.chat.messages);
      for (const task of interrupted) {
        state.chat.messages = appendMessage(
          state.chat.messages,
          taskRecord({ taskId: task.taskId, status: 'interrupted', title: task.title })
        );
      }
      if (interrupted.length > 0) scheduleSave();
```

7. `stop()` 里取消所有任务：

```js
      agentTasks.runtime.stop();
```

- [x] **Step 7: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 全部通过（原有 363 个 + 新增）。

- [x] **Step 8: 提交**

```bash
git add src/main/assistant/agent/tasks.js src/main/assistant/chat/agent.js \
        src/main/assistant/index.js src/main/assistant/agent/facade.js \
        test/unit/agent-tasks.test.js
git commit -m "feat(助手): 接线——agent 的每句话都是一个后台任务"
```

---

## 复审要点（做完之后自己过一遍）

- [x] 等待审批时，别的任务真的能跑吗？（槽位有没有还回去）
- [x] 拒绝之后，模型收到的是「用户拒绝了」而不是异常吗？
- [x] 审批气泡点完之后，窗口的点击穿透恢复了吗？
- [x] 任务、步骤、审批三类记录真的没进模型上下文吗？
- [x] 重启之后，上次没跑完的任务在记录里标成「已中断」了吗？
- [x] 应用退出时，挂着的审批与任务都收干净了吗？
