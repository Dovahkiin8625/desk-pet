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
