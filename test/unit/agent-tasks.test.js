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

test('任务做完了：通知里带着任务号', async () => {
  // 页面要靠任务号把后台的结果归回发起它的那一块，
  // 所以完成通知里必须带着它（规格 §7.3）。
  const seen = [];
  const tasks = createAgentTasks({
    backend: { chat: async () => ({ text: '干完了' }) },
    getMessages: () => [],
    appendRecord: () => {},
    notify: (payload) => seen.push(payload),
    now: () => 1,
  });
  const res = await tasks.submit({ prompt: '查视频', title: '查视频', config: {} });
  await res.done;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskId, res.taskId);
});

test('任务做砸了：也要通知用户', async () => {
  // **失败与成功一样要通知**：不然用户等半天，
  // 什么也没等到，还以为任务还在跑。
  const seen = [];
  const tasks = createAgentTasks({
    backend: {
      chat: async () => {
        throw new Error('后端炸了');
      },
    },
    getMessages: () => [],
    appendRecord: () => {},
    notify: (payload) => seen.push(payload),
  });
  const res = await tasks.submit({ prompt: '查视频', title: '查视频' });
  await assert.rejects(() => res.done, /后端炸了/);
  await tick();
  assert.equal(seen.length, 1, '失败也要发一条通知');
  assert.equal(seen[0].ok, false);
  assert.match(seen[0].text, /没做成/);
});

test('任务做砸了：错误是后端抛的原样那个', async () => {
  // 后端抛的可能不是 Error（字符串、数字都有）。
  // 取消标记不能挂在原值上——严格模式下挂属性会抛 TypeError，
  // 把真实原因换成一句看不懂的报错。原错误要用 `cause` 保住。
  const seen = [];
  const tasks = createAgentTasks({
    backend: {
      chat: async () => {
        throw '后端炸了';
      },
    },
    getMessages: () => [],
    appendRecord: () => {},
    notify: (payload) => seen.push(payload),
  });
  const res = await tasks.submit({ prompt: '查视频', title: '查视频' });
  // **原样**：消息就是后端抛的那句，不多不少。
  await assert.rejects(
    () => res.done,
    (err) => {
      assert.equal(err.message, '后端炸了');
      assert.equal(err.cause, '后端炸了', '原错误要留在 cause 里');
      return true;
    }
  );
  await tick();
  assert.equal(seen.length, 1, '字符串错误也要通知');
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].text, '这件事没做成：后端炸了');
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

test('中枢：任务列表带上了步数与出错原因', async () => {
  // 界面要靠这两个字段画「跑到第几步了」「为什么没做成」。
  const tasks = createAgentTasks({
    backend: {
      id: 'agent',
      chat: async (ctx) => {
        ctx.onEvent?.({
          type: 'step',
          index: 2,
          tool: 'fs.write',
          args: {},
          result: 'ok',
          error: '',
        });
        return { text: '做完了', emotion: 'happy', mood: 1, memories: [] };
      },
    },
  });
  const t = tasks.submit({ prompt: '写个文件', messages: [] });
  await t.done;
  const row = tasks.list()[0];
  assert.equal(row.stepIndex, 2);
  assert.equal(row.lastStep, 'fs.write');
  assert.equal(row.error, '');
});

test('中枢：看板视图带上了步骤时间线', async () => {
  // 详情页那条竖线要的：每一步说了什么工具、动了什么参数、结果是什么。
  const tasks = createAgentTasks({
    backend: {
      id: 'agent',
      chat: async (ctx) => {
        ctx.onEvent?.({
          type: 'step',
          index: 1,
          tool: 'fs.read',
          args: { path: 'a.md' },
          result: '读到了 3 行',
          error: '',
        });
        ctx.onEvent?.({
          type: 'step',
          index: 2,
          tool: 'fs.write',
          args: { path: 'b.md' },
          result: '',
          error: '写不了',
        });
        return { text: '做完了', emotion: 'happy', mood: 1, memories: [] };
      },
    },
  });
  const t = tasks.submit({ prompt: '写个文件', messages: [] });
  await t.done;
  const row = tasks.board()[0];
  assert.equal(row.taskId, t.taskId);
  assert.equal(row.createdAt > 0, true, '详情页要说得清它是什么时候来的');
  assert.equal(row.steps.length, 2);
  assert.equal(row.steps[0].tool, 'fs.read');
  assert.equal(row.steps[0].args.path, 'a.md');
  assert.equal(row.steps[0].result, '读到了 3 行');
  assert.equal(row.steps[1].error, '写不了');
  assert.equal(row.result, '做完了', '详情页要看到整句话');
});

test('中枢：给模型看的那份列表不带步骤', async () => {
  // 模型要的是「到哪一步了」——整条时间线只会撑爆它的上下文。
  const tasks = createAgentTasks({
    backend: {
      id: 'agent',
      chat: async (ctx) => {
        ctx.onEvent?.({ type: 'step', index: 1, tool: 'fs.read', args: {}, result: 'ok' });
        return { text: '做完了', emotion: 'happy', mood: 1, memories: [] };
      },
    },
  });
  const t = tasks.submit({ prompt: '读个文件', messages: [] });
  await t.done;
  const row = tasks.list()[0];
  assert.equal(row.steps, undefined, '简报里不该有步骤');
  assert.equal(row.createdAt, undefined, '简报里不该有那些界面才要的字段');
  assert.equal(row.stepIndex, 1);
});

test('中枢：归档之后那个任务的步骤清单也不留了', async () => {
  const tasks = createAgentTasks({
    backend: {
      id: 'agent',
      chat: async (ctx) => {
        ctx.onEvent?.({ type: 'step', index: 1, tool: 'fs.read', args: {}, result: 'ok' });
        return { text: '做完了', emotion: 'happy', mood: 1, memories: [] };
      },
    },
  });
  const t = tasks.submit({ prompt: '读个文件', messages: [] });
  await t.done;
  assert.equal(tasks.board().length, 1);
  assert.equal(tasks.archive(t.taskId).ok, true);
  assert.equal(tasks.board().length, 0, '归档了就不再出现在看板上');
});

test('中枢：任务失败时，列表里说得清为什么', async () => {
  const tasks = createAgentTasks({
    backend: {
      id: 'agent',
      chat: async () => {
        throw new Error('后端炸了');
      },
    },
  });
  const t = tasks.submit({ prompt: '查视频', messages: [] });
  await assert.rejects(() => t.done, /后端炸了/);
  assert.equal(tasks.list()[0].error, '后端炸了');
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
