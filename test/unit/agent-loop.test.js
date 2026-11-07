import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_OUTCOME, createAgentLoop } from '../../src/main/assistant/agent/loop.js';

/** 造一个只读的假工具。 */
function readTool(onRun = () => {}) {
  return {
    name: 'fs.read',
    label: '读文件',
    description: '读文件',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    async run(args) {
      onRun(args);
      return { text: '文件内容', data: { args } };
    },
  };
}

/** 造一个必失败的工具。 */
function brokenTool(message = '文件不存在') {
  return {
    name: 'fs.read',
    label: '读文件',
    description: '读文件',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    async run() {
      throw new Error(message);
    },
  };
}

/** 一轮工具调用的剧本。 */
function call(name, args = {}, id = 'call_1') {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 假模型：按剧本一轮轮返回。 */
function fakeModel(script) {
  const seen = [];
  let i = 0;
  return {
    seen,
    async callModel({ messages, onDelta }) {
      seen.push(messages);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (step.text) onDelta?.(step.text);
      return { text: step.text || '', toolCalls: step.toolCalls || [] };
    },
  };
}

/** 把一次调用接成循环。 */
function loop(model, { tools = [], gate = null, maxSteps = 20 } = {}) {
  return createAgentLoop({
    callModel: model.callModel,
    resolveTool: (name) => tools.find((t) => t.name === name) || null,
    gate,
    maxSteps,
  });
}

test('多步循环：调工具 → 拿结果 → 再调 → 出结论', async () => {
  const runs = [];
  const tool = readTool((args) => runs.push(args));
  const model = fakeModel([
    { toolCalls: [call('fs.read', { path: 'a.txt' })] },
    { toolCalls: [call('fs.read', { path: 'b.txt' })] },
    { text: '两个文件都读完了' },
  ]);
  const result = await loop(model, { tools: [tool] }).run({
    system: '你是小桌',
    messages: [{ role: 'user', content: '读一下' }],
  });

  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  assert.equal(result.text, '两个文件都读完了');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { path: 'a.txt' });
  assert.equal(result.steps, 3);
});

test('工具的结果要作为 role:tool 的消息喂回模型', async () => {
  const model = fakeModel([{ toolCalls: [call('fs.read', {})] }, { text: '好了' }]);
  await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  const second = model.seen[1];
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '模型没收到 tool 消息');
  assert.equal(toolMsg.content, '文件内容');
});

test('模型调了不存在的工具：不终止，把错误喂回模型', async () => {
  const model = fakeModel([
    { toolCalls: [call('weather.get', { city: '北京' })] },
    { text: '那个工具我确实没有' },
  ]);
  const result = await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /没有这个工具/);
});

test('工具的参数不是合法 JSON：不终止，把错误喂回模型', async () => {
  const model = fakeModel([
    {
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'fs.read', arguments: '{"path":' } },
      ],
    },
    { text: '我换个写法' },
  ]);
  const result = await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /JSON/);
});

test('工具报错：错误喂回模型，模型换条路就成功', async () => {
  let attempt = 0;
  const tool = {
    name: 'fs.read',
    risk: 'read',
    async run() {
      attempt += 1;
      if (attempt === 1) throw new Error('文件不存在');
      return { text: '找到了' };
    },
  };
  const model = fakeModel([
    { toolCalls: [call('fs.read', { path: 'x' })] },
    { toolCalls: [call('fs.read', { path: 'y' })] },
    { text: '好了' },
  ]);
  const result = await loop(model, { tools: [tool] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  assert.equal(result.text, '好了');
  const firstErr = model.seen[1].find((m) => m.role === 'tool');
  assert.match(firstErr.content, /出错/);
});

test('同一个错连着出三次：停下来并说明原因', async () => {
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'x' })] }]);
  const result = await loop(model, { tools: [brokenTool('文件不存在')] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.REPEATED_ERRORS);
  assert.match(result.error, /文件不存在/);
});

test('步数用尽：停下来，且没有结论', async () => {
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'x' })] }]);
  const result = await loop(model, { tools: [readTool()], maxSteps: 3 }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.MAX_STEPS);
  assert.equal(result.text, '');
  assert.equal(result.steps, 3);
});

test('没有审批闸门时：只读工具照常执行', async () => {
  let ran = 0;
  const model = fakeModel([{ toolCalls: [call('fs.read', {})] }, { text: '好了' }]);
  await loop(model, { tools: [readTool(() => { ran += 1; })] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 1);
});

test('没有审批闸门时：执行类工具不执行，理由喂回模型', async () => {
  let ran = 0;
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      ran += 1;
      return { text: '不该出现' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }, { text: '好' }]);
  const result = await loop(model, { tools: [execTool] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 0);
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /审批|确认/);
});

test('闸门拒绝：工具不执行，拒绝是给模型的信号而不是终止', async () => {
  let ran = 0;
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      ran += 1;
      return { text: '不该出现' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }, { text: '那算了' }]);
  const result = await loop(model, {
    tools: [execTool],
    gate: { request: async () => ({ decision: 'deny' }) },
  }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 0);
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  assert.equal(result.text, '那算了');
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /拒绝/);
});

test('闸门放行：工具照常执行', async () => {
  let ran = 0;
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      ran += 1;
      return { text: '列出来了' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }, { text: '好' }]);
  await loop(model, {
    tools: [execTool],
    gate: { request: async () => ({ decision: 'allow' }) },
  }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 1);
});

test('一轮里调多个工具：每个都要有自己的 tool 结果', async () => {
  const model = fakeModel([
    {
      toolCalls: [call('fs.read', { path: 'a' }, 'c1'), call('fs.read', { path: 'b' }, 'c2')],
    },
    { text: '都读完了' },
  ]);
  await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  const toolMsgs = model.seen[1].filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2']);
});

test('被取消：停下来，outcome 是 aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const model = fakeModel([{ text: '不该走到这' }]);
  const result = await loop(model, { tools: [] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
    signal: controller.signal,
  });
  assert.equal(result.outcome, AGENT_OUTCOME.ABORTED);
});

test('步骤事件：工具调用会发事件', async () => {
  const events = [];
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'a' })] }, { text: '好了' }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: (name) => (name === 'fs.read' ? readTool() : null),
    onEvent: (e) => events.push(e),
  });
  await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  const step = events.find((e) => e.type === 'step');
  assert.ok(step, '没发步骤事件');
  assert.equal(step.tool, 'fs.read');
});
