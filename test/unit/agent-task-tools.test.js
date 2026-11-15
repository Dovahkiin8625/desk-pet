import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_KIND } from '../../src/shared/assistant.js';
import { createTaskTools } from '../../src/main/assistant/agent/tools/tasks.js';

/**
 * 四个任务管理工具。
 *
 * 交出去的时候带的是**当前这段对话**（不是模型重写的一段说明），
 * 外加模型写的两样东西：**目标**与**做完的标准**。
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
        {
          taskId: 't-9',
          title: '查视频',
          status: 'running',
          lastStep: 'fs.list',
          result: '',
          elapsedMs: 1200,
        },
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
function makeTools({ tasks = fakeTasks(), canEscalate = true, records = [], convo = [] } = {}) {
  const tools = createTaskTools({
    tasks,
    getConvo: () => convo,
    config: { model: 'stub-model' },
    canEscalate,
    appendRecord: (entry) => records.push(entry),
    now: () => 1000,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, byName, tasks, records };
}

test('工具表：四个动作类工具，没有查列表与查状态', () => {
  const names = createTaskTools({ tasks: fakeTasks() }).map((t) => t.name);
  assert.deepEqual(names, ['task.run', 'task.cancel', 'task.steer', 'task.delete']);
});

test('四个工具都带 reply 参数，且是可选的', () => {
  const tools = createTaskTools({ tasks: fakeTasks() });
  for (const t of tools) {
    assert.ok(t.parameters.properties.reply, `${t.name} 少了 reply 参数`);
    assert.equal(t.parameters.properties.reply.type, 'string');
    assert.ok(!t.parameters.required.includes('reply'), `${t.name} 的 reply 不该是必填`);
  }
});

test('交出去：reply 原样带回 data.answer', async () => {
  const { byName } = makeTools();
  const out = await byName.get('task.run').run({ goal: '查天气', reply: ' 我这就去查 ' });
  assert.equal(out.data.answer, '我这就去查');
});

test('交出去：模型没写 reply 时 answer 是空串（不是 undefined）', async () => {
  const { byName } = makeTools();
  const out = await byName.get('task.run').run({ goal: '查天气' });
  assert.equal(out.data.answer, '');
});

test('工具描述里不许出现「后台任务」「派单」这类词', () => {
  const tools = createTaskTools({ tasks: fakeTasks() });
  for (const t of tools) {
    assert.ok(
      !/后台任务|派单|派发/.test(t.description),
      `${t.name} 的描述漏了内部话术：${t.description}`
    );
    assert.ok(!/后台任务|派单|派发/.test(t.parameters.properties.reply?.description || ''));
  }
});

test('停掉 / 收起来 / 补要求：reply 也带回 data.answer', async () => {
  const { byName } = makeTools();
  const cancel = await byName.get('task.cancel').run({ taskId: 't-9', reply: '好，先放着' });
  const steer = await byName.get('task.steer').run({
    taskId: 't-9',
    note: '顺便看看 D 盘',
    reply: '再加一条',
  });
  const del = await byName.get('task.delete').run({ taskId: 't-9' });
  assert.equal(cancel.data.answer, '好，先放着');
  assert.equal(steer.data.answer, '再加一条');
  assert.equal(del.data.answer, '', '没写 reply 时也是空串');
});

test('交出去：带的是当前这段对话，不是重写的一段说明', async () => {
  const convo = [
    { role: 'user', content: 'F 盘 video 下有什么' },
    { role: 'assistant', content: '我去看看' },
  ];
  const { byName, tasks } = makeTools({ convo });
  const out = await byName.get('task.run').run({ goal: '查视频', done_when: '列出所有视频文件' });
  assert.equal(out.data.taskId, 't-9');

  const job = tasks.calls[0].job;
  assert.deepEqual(job.messages, convo, '对话要原样带过去');
  assert.equal(job.criteria, '列出所有视频文件', '做完的标准要带过去');
});

test('交出去：对话停在半截上时要先修好（不能直接发出去）', async () => {
  // assistant 说了要调工具，结果还没写回来——那样发出去接口会 400。
  const convo = [
    { role: 'user', content: '删掉 a.png' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'fs.del', arguments: '{}' } }] },
  ];
  const { byName, tasks } = makeTools({ convo });
  await byName.get('task.run').run({ goal: '删掉 a.png' });
  const job = tasks.calls[0].job;
  assert.equal(job.messages.length, 1, '半截的那轮要被截掉');
  assert.equal(job.messages[0].role, 'user');
});

test('交出去：记一条 dispatch 记录，正文里有任务号', async () => {
  const { byName, records } = makeTools();
  await byName.get('task.run').run({ goal: '查视频', done_when: '列出所有视频文件' });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, CHAT_KIND.DISPATCH);
  assert.match(records[0].text, /t-9/, '任务号要在正文里：下一轮要靠它说「停掉 t-9」');
  assert.match(records[0].meta.brief, /做完的标准：列出所有视频文件/);
});

test('记录里的动作是宠物的说法，不许有内部话术', async () => {
  const { byName, records } = makeTools();
  await byName.get('task.run').run({ goal: '查视频' });
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
    assert.ok(
      !/后台任务|派单|派发|派了个任务/.test(rec.meta.action),
      `内部话术漏到界面上了：${rec.meta.action}`
    );
  }
});

test('目标太长就让它写短点', async () => {
  const { byName } = makeTools();
  await assert.rejects(() => byName.get('task.run').run({ goal: '看'.repeat(300) }), /太长/);
});

test('做完的标准太长就让它写短点', async () => {
  const { byName } = makeTools();
  await assert.rejects(
    () => byName.get('task.run').run({ goal: '查视频', done_when: '看'.repeat(300) }),
    /太长/
  );
});

test('不能交出去的时候：连工具都不给', () => {
  const names = createTaskTools({ tasks: fakeTasks(), canEscalate: false }).map((t) => t.name);
  assert.ok(!names.includes('task.run'), '给了模型它就会去调，然后被拒——白白浪费一轮');
  assert.deepEqual(names, ['task.cancel', 'task.steer', 'task.delete']);
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
  const tasks = fakeTasks();
  tasks.cancel = () => ({ ok: false, message: '这个任务已经结束了' });
  const tools = createTaskTools({ tasks, appendRecord: () => {}, now: () => 1 });
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
    appendRecord: (entry) => records.push(entry),
    now: () => 1,
  });
  const steer = tools.find((t) => t.name === 'task.steer');
  const out = await steer.run({ taskId: 't-9', note: '顺便看看 D 盘' });
  assert.doesNotMatch(out.text, /已给任务/);
  assert.match(out.text, /没送出去/);
  assert.equal(records[0].text.includes('已追加'), false);
});
