import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_KIND } from '../../src/shared/assistant.js';
import { createTaskTools } from '../../src/main/assistant/layer/taskTools.js';

/**
 * 五个任务管理工具（规格 §4.1、§6.2）。
 *
 * 派单要带三样东西：**用户原话**、**交互层的理解**、**相关历史**——
 * 只给一样，执行层要么不知道约束，要么细节全丢。
 */

/** 一个假的任务中枢。 */
function fakeTasks() {
  const calls = [];
  return {
    calls,
    submit(job) {
      calls.push({ op: 'submit', job });
      return {
        ok: true,
        taskId: 't-9',
        position: 1,
        queued: false,
        done: Promise.resolve({ ok: true }),
      };
    },
    list() {
      return [
        { taskId: 't-9', title: '查视频', status: 'running', lastStep: 'fs.list', result: '', elapsedMs: 1200 },
      ];
    },
    cancel(id) {
      calls.push({ op: 'cancel', id });
      return { ok: true };
    },
    archive(id) {
      calls.push({ op: 'archive', id });
      return { ok: true };
    },
    steer(id, note) {
      calls.push({ op: 'steer', id, note });
      return { ok: true };
    },
  };
}

/** 造这一轮的工具集。 */
function makeTools({ tasks = fakeTasks(), dispatchEnabled = true, records = [], history = [] } = {}) {
  const tools = createTaskTools({
    tasks,
    dispatchEnabled,
    appendRecord: (entry) => records.push(entry),
    now: () => 1000,
    turn: {
      history,
      userText: 'F 盘 video 下有什么',
      config: { model: 'stub-model' },
    },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, byName, tasks, records };
}

test('派单：把用户原话与简报一起交给后台任务', async () => {
  const { byName, tasks } = makeTools();
  const out = await byName.get('task.submit').run({
    title: '查视频',
    brief: '看看 F:\\video 下有什么',
  });
  assert.equal(out.data.taskId, 't-9');

  const job = tasks.calls[0].job;
  assert.equal(job.title, '查视频');
  const last = job.messages.at(-1);
  assert.match(last.content, /看看 F:\\video 下有什么/, '简报要带过去');
  assert.match(last.content, /用户原话：F 盘 video 下有什么/, '用户原话也要带过去');
});

test('派单：记一条 dispatch 记录，正文里有任务号', async () => {
  const { byName, records } = makeTools();
  await byName.get('task.submit').run({ title: '查视频', brief: '看看' });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, CHAT_KIND.DISPATCH);
  assert.match(records[0].text, /t-9/, '任务号要在正文里：交互层下一轮要靠它说「停掉 t-9」');
  assert.equal(records[0].meta.brief, '看看', '交底要进派单记录：页面要原样显示它');
});

test('派单：说明太长就让它写短点', async () => {
  const { byName } = makeTools();
  // **为什么要限长**：交互层的 `maxTokens` 按普通对话（默认 800），
  // 而工具参数与正文**共用**同一个额度——说明被截断，
  // 参数就不是合法 JSON，循环报错，白烧掉 3 步里的 1 步。
  await assert.rejects(
    () => byName.get('task.submit').run({ title: '查视频', brief: '看'.repeat(300) }),
    /太长/
  );
});

test('派单关了：不能派，也不该真的派出去', async () => {
  const { byName, tasks } = makeTools({ dispatchEnabled: false });
  await assert.rejects(
    () => byName.get('task.submit').run({ title: '查视频', brief: '看看' }),
    /不能派单/
  );
  assert.equal(tasks.calls.length, 0, '不能派单就不该提交任务');
});

test('查看：把任务列出来', async () => {
  const { byName } = makeTools();
  const out = await byName.get('task.list').run({});
  assert.match(out.text, /t-9/);
  assert.match(out.text, /查视频/);
});

test('停掉 / 归档 / 追加要求：都转给中枢', async () => {
  const { byName, tasks } = makeTools();
  await byName.get('task.cancel').run({ taskId: 't-9' });
  await byName.get('task.delete').run({ taskId: 't-9' });
  await byName.get('task.steer').run({ taskId: 't-9', note: '顺便看看 D 盘' });
  assert.deepEqual(
    tasks.calls.map((c) => c.op),
    ['cancel', 'archive', 'steer']
  );
  assert.equal(tasks.calls[2].note, '顺便看看 D 盘');
});

test('失败要如实说：中枢不认就不假装成', async () => {
  const { byName } = makeTools({
    tasks: fakeTasks(),
  });
  byName.get('task.cancel');
  const tasks = fakeTasks();
  tasks.cancel = () => ({ ok: false, message: '这个任务已经结束了' });
  const tools = createTaskTools({
    tasks,
    dispatchEnabled: true,
    appendRecord: () => {},
    now: () => 1,
    turn: { history: [], userText: '停掉', config: {} },
  });
  const cancel = tools.find((t) => t.name === 'task.cancel');
  await assert.rejects(() => cancel.run({ taskId: 't-9' }), /已经结束/);
});

test('追加要求：任务刚好结束时要说实话——没送出去', async () => {
  // 中枢把「指令被丢弃」也当成功返回（不是错误，是时序问题），
  // 但工具不能跟着说「已追加要求」——那句话根本没送到任务那儿。
  const tasks = fakeTasks();
  tasks.steer = () => ({ ok: true, dropped: true });
  const records = [];
  const tools = createTaskTools({
    tasks,
    dispatchEnabled: true,
    appendRecord: (entry) => records.push(entry),
    now: () => 1,
    turn: { history: [], userText: '顺便看看 D 盘', config: {} },
  });
  const steer = tools.find((t) => t.name === 'task.steer');
  const out = await steer.run({ taskId: 't-9', note: '顺便看看 D 盘' });
  assert.doesNotMatch(out.text, /已给任务/);
  assert.match(out.text, /没送出去/);
  assert.equal(records[0].text.includes('已追加'), false);
});
