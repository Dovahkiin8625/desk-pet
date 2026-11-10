import test from 'node:test';
import assert from 'node:assert/strict';

import createTasksPlugin from '../../plugins/tasks/main.js';

/**
 * 后台任务插件（主进程侧）。
 *
 * 它只做两件事：把 agent 的东西凑成一份快照，
 * 以及把界面上的四个动作转给 agent。
 * **失败要如实说**——界面显示的是它给的那句话。
 */

/** 造一个假 agent。 */
function fakeAgent(overrides = {}) {
  return {
    tasks: async () => [
      {
        taskId: 't1',
        title: '翻文件',
        status: 'running',
        lastStep: 'fs.list',
        stepIndex: 1,
        result: '',
        error: '',
        elapsedMs: 1000,
      },
    ],
    approvals: async () => [
      { id: 't1-1', taskId: 't1', title: '需要你点头', text: '写文件：a.md', risk: 'write' },
    ],
    cancel: async () => ({ ok: true }),
    steer: async () => ({ ok: true }),
    archive: async () => ({ ok: false, message: '这个任务还在跑，先停掉它再归档' }),
    answerApproval: async () => ({ ok: false, message: '这个已经答复过了' }),
    history: () => [{ kind: 'task', meta: { status: 'interrupted' } }],
    ...overrides,
  };
}

test('任务插件：快照里有任务、审批、计数与中断数', async () => {
  const plugin = createTasksPlugin({ agent: fakeAgent() });
  const data = await plugin.data();
  assert.equal(data.tasks.length, 1);
  assert.equal(data.approvals[0].id, 't1-1');
  assert.deepEqual(data.counts, { running: 1, queued: 0 });
  assert.equal(data.interrupted, 1);
});

test('任务插件：刷新也是一份全量快照', async () => {
  const plugin = createTasksPlugin({ agent: fakeAgent() });
  const data = await plugin.tick();
  assert.equal(data.tasks.length, 1);
});

test('任务插件：停掉一个任务', async () => {
  const plugin = createTasksPlugin({ agent: fakeAgent() });
  const res = await plugin.act({ agent: fakeAgent() }, 'cancel', { taskId: 't1' });
  assert.equal(res.ok, true);
  assert.equal(res.message, '停掉了');
});

test('任务插件：归档在跑的任务要把运行时的话说清楚', async () => {
  const plugin = createTasksPlugin({ agent: fakeAgent() });
  const res = await plugin.act({ agent: fakeAgent() }, 'archive', { taskId: 't1' });
  assert.equal(res.ok, false);
  assert.equal(res.message, '这个任务还在跑，先停掉它再归档');
});

test('任务插件：重复答复要说「已经答复过了」', async () => {
  const plugin = createTasksPlugin({ agent: fakeAgent() });
  const res = await plugin.act({ agent: fakeAgent() }, 'answer', {
    id: 't1-1',
    decision: 'allow',
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /已经答复过了/);
});

test('任务插件：任务刚好结束时，追加的要求没送出去', async () => {
  const agent = fakeAgent({ steer: async () => ({ ok: true, dropped: true }) });
  const plugin = createTasksPlugin({ agent });
  const res = await plugin.act({ agent }, 'steer', {
    taskId: 't1',
    note: '快点',
  });
  assert.equal(res.ok, true);
  assert.match(res.message, /没送出去/);
});
