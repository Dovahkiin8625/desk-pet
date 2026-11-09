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
        const v = await ctx.gate.request({
          tool: { name: 'shell.exec', risk: 'exec' },
          args: { command: 'ls' },
          risk: 'exec',
        });
        actions.push({ type: 'gate', allowed: v.allowed });
        if (!v.allowed) {
          return { text: '用户不让我跑', emotion: 'neutral', mood: 0, memories: [] };
        }
      }
      return { text: '做完了', emotion: 'happy', mood: 1, memories: [] };
    },
  };
}

/** 造一个永远不结束的后端：用来把后面的任务挤到队列里。 */
function neverEndingBackend() {
  return {
    id: 'agent',
    chat: () => new Promise(() => {}),
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
  const approval = records.find((r) => r.kind === 'approval' && r.meta.decision === 'allow');
  assert.ok(approval, '要有审批记录');
  assert.equal(approval.meta.decision, 'allow');
});

test('中枢：审批请求一发出就写一条「等你点头」的记录', async () => {
  // 规格 §15：记录里要有审批项，用户才知道任务还卡着。
  const records = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    getPolicy: () => 'graded',
    ask: async () => 'allow',
    appendRecord: (entry) => records.push(entry),
  });
  const t = tasks.submit({ prompt: '跑个命令', messages: [] });
  await t.done;
  const approvals = records.filter((r) => r.kind === 'approval');
  assert.ok(
    approvals.some((r) => r.meta.decision === 'pending'),
    '要有一条还在等的记录'
  );
  assert.ok(
    approvals.some((r) => r.meta.decision === 'allow'),
    '决议也要有一条'
  );
});

test('中枢：用户点「取消」时，任务真的停了', async () => {
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    getPolicy: () => 'graded',
    ask: async () => 'cancel',
  });
  const t = tasks.submit({ prompt: '跑个命令', messages: [] });
  await assert.rejects(() => t.done, /取消/);
  assert.equal(tasks.list()[0].status, TASK_STATUS.CANCELLED);
});

test('中枢：后台任务做完了要通知用户', async () => {
  const notices = [];
  const tasks = createAgentTasks({
    backend: fakeBackend(),
    notify: (n) => notices.push(n),
  });
  const t = tasks.submit({ prompt: '查天气', messages: [] });
  await t.done;
  await tick();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /做完了/);
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
  assert.ok(
    events.every((e) => e.taskId === t.taskId),
    '每个事件都要带任务号'
  );
});

test('中枢：取消一个任务', async () => {
  const tasks = createAgentTasks({ backend: fakeBackend() });
  const t = tasks.submit({ prompt: '查天气', messages: [] });
  assert.equal(tasks.cancel(t.taskId).ok, true);
});

test('中枢：第二个任务知道自己排第 2 位', async () => {
  // 规格 §7.2：排队时要告诉用户「排第 N 位」。
  // 所以中枢得把位置算出来——不然界面上只能说「排队中」。
  const tasks = createAgentTasks({ backend: neverEndingBackend() });
  const first = tasks.submit({ prompt: '甲', messages: [] });
  const second = tasks.submit({ prompt: '乙', messages: [] });
  assert.equal(first.queued, false, '第一个任务直接开跑');
  assert.equal(second.queued, true, '第二个任务要排队');
  assert.equal(second.position, 2, '第二个任务排第 2 位');
});

test('中枢：排队的任务不算「已排队」，跑着的才算', async () => {
  const tasks = createAgentTasks({ backend: neverEndingBackend() });
  const first = tasks.submit({ prompt: '甲', messages: [] });
  assert.equal(first.queued, false);
  assert.equal(first.position, 1, '第一个任务就是第 1 位');
});
