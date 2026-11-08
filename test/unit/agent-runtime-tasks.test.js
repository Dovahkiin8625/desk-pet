import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../src/main/assistant/agent/runtime.js';
import { createAgentTasks } from '../../src/main/assistant/agent/tasks.js';

/**
 * 运行时与任务中枢的新增能力（规格 §6.2、§5.2）。
 *
 * 三件事最容易做错：
 * 1. **归档只影响可见性**：记录要留着（那是安全审计），只是不再出现在列表里；
 * 2. **归档不了还在跑的任务**：要先停掉；
 * 3. **steer 到达时任务已经结束**：要明确说「已经结束了」，
 *    不能假装收下了——用户会以为追加的要求生效了。
 */

/** 一个会等闸门的后台任务。 */
function blockingTask(runtime, gate) {
  return runtime.submit({
    title: '查视频',
    run: async () => {
      await gate;
      return 'ok';
    },
  });
}

/** 造一个闸门（用来把任务挂住）。 */
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('归档：跑着的任务不能归档', async () => {
  const runtime = createAgentRuntime();
  const g = gate();
  const task = blockingTask(runtime, g.promise);
  const res = runtime.archive(task.taskId);
  assert.equal(res.ok, false);
  assert.match(res.message, /还在跑/);
  g.release();
  await task.done;
});

test('归档：结束的任务可以归档，归档后不在列表里', async () => {
  const runtime = createAgentRuntime();
  const task = runtime.submit({ title: '查视频', run: async () => 'ok' });
  await task.done;
  assert.equal(runtime.list().length, 1);

  const res = runtime.archive(task.taskId);
  assert.equal(res.ok, true);
  assert.equal(runtime.list().length, 0, '归档后不该出现在列表里');
  assert.equal(runtime.list({ includeArchived: true }).length, 1, '归档的记录要留着');
});

test('steer：追加的要求能在任务里取出来', async () => {
  const runtime = createAgentRuntime();
  let notes = null;
  const task = runtime.submit({
    title: '查视频',
    run: async (scope) => {
      notes = scope.steer();
      return 'ok';
    },
  });
  const res = runtime.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, true);
  await task.done;
  assert.deepEqual(notes, ['顺便看看 D 盘']);
});

test('steer：任务已经结束的，指令丢弃但不报错', async () => {
  const runtime = createAgentRuntime();
  const task = runtime.submit({ title: '查视频', run: async () => 'ok' });
  await task.done;
  const res = runtime.steer(task.taskId, '顺便看看 D 盘');
  // **不是错误**：任务刚好结束时那句追加确实没送出去，
  // 但这是时序问题，不是用户的错——报错只会让人以为程序坏了。
  assert.equal(res.ok, true);
  assert.equal(res.dropped, true);
});

test('steer：任务被取消的，指令作废并返回失败', async () => {
  const runtime = createAgentRuntime();
  const g = gate();
  const task = blockingTask(runtime, g.promise);
  runtime.cancel(task.taskId);
  const res = runtime.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, false);
  assert.match(res.message, /取消/);
  g.release();
});

test('steer：没有这个任务就说没有', () => {
  const runtime = createAgentRuntime();
  const res = runtime.steer('nope', '随便');
  assert.equal(res.ok, false);
  assert.match(res.message, /没有这个任务/);
});

/** 一个假的后端：报一步工具调用，然后给结果。 */
function fakeBackend() {
  return {
    id: 'fake',
    async chat(ctx) {
      ctx.onEvent?.({
        type: 'step',
        index: 1,
        tool: 'fs.list',
        args: {},
        result: 'a.txt',
        error: '',
      });
      return { text: '查完了', emotion: 'neutral', mood: 0, memories: [] };
    },
  };
}

test('中枢：列表是给人看的精简视图，带上最近一步', async () => {
  const tasks = createAgentTasks({ backend: fakeBackend() });
  const t = tasks.submit({ prompt: '查视频', messages: [] });
  await t.done;
  const list = tasks.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, t.taskId);
  assert.equal(list[0].title, '查视频');
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].lastStep, 'fs.list');
  assert.ok(Number.isFinite(list[0].elapsedMs));
  // 精简视图里不该有内部字段（run / scope / controller）。
  assert.equal(list[0].run, undefined);
});

test('计数：在跑的和排队的分开算，归档的不算', async () => {
  const tasks = createAgentTasks({ backend: fakeBackend() });
  const done = tasks.submit({ prompt: '查视频', messages: [] });
  await done.done;
  assert.equal(tasks.counts().running, 0);
  assert.equal(tasks.counts().queued, 0);

  // 归档之后：不在列表里，也不在计数里。
  tasks.archive(done.taskId);
  assert.equal(tasks.list().length, 0);
  assert.equal(tasks.counts().running, 0);
});
