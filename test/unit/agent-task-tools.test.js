import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_KIND } from '../../src/shared/assistant.js';
import { createTaskTools } from '../../src/main/assistant/layer/taskTools.js';

/**
 * 四个任务管理工具（规格 §4.1、§6.2）。
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

test('工具表：只剩四个动作类工具，没有查列表与查状态', () => {
  const names = createTaskTools({ tasks: fakeTasks() }).map((t) => t.name);
  assert.deepEqual(names, ['task.submit', 'task.cancel', 'task.steer', 'task.delete']);
});

test('四个工具都带 reply 参数，且是可选的', () => {
  const tools = createTaskTools({ tasks: fakeTasks() });
  for (const t of tools) {
    assert.ok(t.parameters.properties.reply, `${t.name} 少了 reply 参数`);
    assert.equal(t.parameters.properties.reply.type, 'string');
    assert.ok(!t.parameters.required.includes('reply'), `${t.name} 的 reply 不该是必填`);
  }
});

test('派单：reply 原样带回 data.answer', async () => {
  const tools = createTaskTools({ tasks: fakeTasks(), turn: { userText: '查天气' } });
  const submit = tools.find((t) => t.name === 'task.submit');
  const out = await submit.run({ title: '查天气', brief: '查一下', reply: ' 我这就去查 ' });
  assert.equal(out.data.answer, '我这就去查');
});

test('派单：模型没写 reply 时 answer 是空串（不是 undefined）', async () => {
  const tools = createTaskTools({ tasks: fakeTasks(), turn: { userText: '查天气' } });
  const submit = tools.find((t) => t.name === 'task.submit');
  const out = await submit.run({ title: '查天气', brief: '查一下' });
  assert.equal(out.data.answer, '');
});

test('工具描述里不许出现「后台任务」「派单」这类词', () => {
  const tools = createTaskTools({ tasks: fakeTasks() });
  for (const t of tools) {
    assert.ok(!/后台任务|派单|派发/.test(t.description), `${t.name} 的描述漏了内部话术：${t.description}`);
    assert.ok(!/后台任务|派单|派发/.test(t.parameters.properties.reply?.description || ''));
  }
});

test('停掉 / 收起来 / 补要求：reply 也带回 data.answer', async () => {
  const { byName } = makeTools();
  const cancel = await byName.get('task.cancel').run({ taskId: 't-9', reply: '好，先放着' });
  const steer = await byName.get('task.steer').run({ taskId: 't-9', note: '顺便看看 D 盘', reply: '再加一条' });
  const del = await byName.get('task.delete').run({ taskId: 't-9' });
  assert.equal(cancel.data.answer, '好，先放着');
  assert.equal(steer.data.answer, '再加一条');
  assert.equal(del.data.answer, '', '没写 reply 时也是空串');
});

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

test('记录里的动作是宠物的说法，不许有内部话术', async () => {
  const { byName, records } = makeTools();
  await byName.get('task.submit').run({ title: '查视频', brief: '看看' });
  await byName.get('task.cancel').run({ taskId: 't-9' });
  await byName.get('task.delete').run({ taskId: 't-9' });
  await byName.get('task.steer').run({ taskId: 't-9', note: '顺便看看 D 盘' });
  const actions = records.map((r) => r.meta.action);
  assert.deepEqual(actions, [
    '开始做：查视频',
    '停掉了：查视频',
    '收起来了：查视频',
    '给那件事补了一句要求',
  ]);
  for (const rec of records) {
    assert.ok(!/后台任务|派单|派发|派了个任务/.test(rec.meta.action), `内部话术漏到界面上了：${rec.meta.action}`);
  }
});

test('派单：说明太长就让它写短点', async () => {
  const { byName } = makeTools();
  // **为什么要限长**：交互层的 `maxTokens` 按普通对话（默认 800），
  // 而工具参数与正文共用同一个额度——说明被截断，
  // 参数就不是合法 JSON，循环报错，白烧掉 3 步里的 1 步。
  await assert.rejects(
    () => byName.get('task.submit').run({ title: '查视频', brief: '看'.repeat(300) }),
    /太长/
  );
});

test('派单关了：不能派，也不该真的派出去', async () => {
  const { byName, tasks } = makeTools({ dispatchEnabled: false });
  // **报错文案里不许有内部话术**：这句话会喂回模型，模型会照着说给用户听。
  await assert.rejects(
    () => byName.get('task.submit').run({ title: '查视频', brief: '看看' }),
    (err) => {
      assert.match(err.message, /不能把事交出去/);
      assert.ok(!/派单|后台任务/.test(err.message), err.message);
      return true;
    }
  );
  assert.equal(tasks.calls.length, 0, '不能派单就不该提交任务');
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
