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
  const toolLists = [];
  let i = 0;
  return {
    seen,
    toolLists,
    async callModel({ messages, tools, onDelta }) {
      seen.push(messages);
      toolLists.push(tools);
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

test('闸门的说法原样喂回模型', async () => {
  // 「没等到确认」与「用户拒绝」对模型是两回事：
  // 闸门给了哪句就用哪句，循环里不要一律改写成「拒绝」。
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      return { text: '不该出现' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }, { text: '那算了' }]);
  await loop(model, {
    tools: [execTool],
    gate: {
      request: async () => ({
        decision: 'supersede',
        reason: '这次调用没有等到确认',
        userReason: '没能等到你的确认',
      }),
    },
  }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /没有等到确认/);
  assert.doesNotMatch(toolMsg.content, /拒绝/, '用户没拒绝过，不能这么说');
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

test('步骤事件：带上工具的人话标签', async () => {
  // 提示词里不能出现工具名——桌宠嘴上要说的是「列目录」，不是「fs.list」。
  const events = [];
  const model = fakeModel([{ toolCalls: [call('fs.list', { path: 'a' })] }, { text: '好了' }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: () => ({
      name: 'fs.list',
      label: '列目录',
      risk: 'read',
      run: async () => ({ text: 'a.txt' }),
    }),
    onEvent: (e) => events.push(e),
  });
  await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  const step = events.find((e) => e.type === 'step');
  assert.equal(step.label, '列目录');
});

test('步骤事件：工具没有标签时是空串', async () => {
  const events = [];
  const model = fakeModel([{ toolCalls: [call('fs.list', { path: 'a' })] }, { text: '好了' }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: () => ({ name: 'fs.list', risk: 'read', run: async () => ({ text: 'a.txt' }) }),
    onEvent: (e) => events.push(e),
  });
  await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  const step = events.find((e) => e.type === 'step');
  assert.equal(step.label, '');
});

test('步骤事件：外部助手自带的那句说明不被工具标签盖掉', async () => {
  // 外部助手报的是「claude code 调了 Read」——比工具标签更具体。
  const events = [];
  const model = fakeModel([{ toolCalls: [call('harness.run', {})] }, { text: '好了' }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: () => ({
      name: 'harness.run',
      label: '外部助手',
      risk: 'read',
      async run(args, ctx) {
        ctx.onEvent?.({ tool: 'harness.run', label: 'claude code 调了 Read', result: 'ok' });
        return { text: '已启动' };
      },
    }),
    onEvent: (e) => events.push(e),
  });
  await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  const fromHarness = events.find((e) => e.type === 'step' && e.label.includes('claude code'));
  assert.ok(fromHarness, '外部助手的那条事件没有转发出来');
  assert.equal(fromHarness.label, 'claude code 调了 Read');
});

test('步骤事件：带着工具返回的 data', async () => {
  const events = [];
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'a' })] }, { text: '好了' }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: () => readTool(),
    onEvent: (e) => events.push(e),
  });
  await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  const step = events.find((e) => e.type === 'step');
  assert.deepEqual(step.data, { args: { path: 'a' } });
});

test('工具调用没带 id 时：assistant 与 tool 消息必须用同一个 id', async () => {
  // 模型没给 id 的场合不少见（有些服务端不返回 id）。
  // **两处各算各的就会对不上号**：assistant 那条是 call_1_0，
  // tool 消息那边却是空串——接口直接 400。
  const model = fakeModel([
    { toolCalls: [{ type: 'function', function: { name: 'fs.read', arguments: '{}' } }] },
    { text: '好了' },
  ]);
  await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  const second = model.seen[1];
  const assistant = second.find((m) => m.role === 'assistant');
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(assistant.tool_calls[0].id, 'assistant 的 tool_call 没有 id');
  assert.equal(toolMsg.tool_call_id, assistant.tool_calls[0].id);
});

test('同一个错连着出三次停下时：这一轮剩下的调用也要有 tool 消息', async () => {
  // 少一条 tool 消息，接口就会因为「tool_calls 没有对应的结果」报错。
  const events = [];
  const calls = ['c1', 'c2', 'c3', 'c4'].map((id) => call('fs.read', { path: id }, id));
  const model = fakeModel([{ toolCalls: calls }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: () => brokenTool(),
    onEvent: (e) => events.push(e),
  });
  const result = await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(result.outcome, AGENT_OUTCOME.REPEATED_ERRORS);
  const skipped = events.filter((e) => e.type === 'step' && /已跳过/.test(e.error || ''));
  assert.equal(skipped.length, 1, '跳过的调用没有发事件');
});

test('没有闸门而工具要确认时：给模型的话与给用户的话不是同一句', async () => {
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      return { text: '不该出现' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }]);
  const result = await loop(model, { tools: [execTool] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  // 喂给模型的话要说清「没有确认渠道」，模型才知道该换条路。
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /审批功能还没上线/);
  // 给用户的话里不该有内部黑话。
  assert.equal(result.outcome, AGENT_OUTCOME.REPEATED_ERRORS);
  assert.match(result.error, /需要你确认/);
  assert.doesNotMatch(result.error, /审批功能还没上线/);
});

test('工具出错时：留一行日志', async () => {
  // 用户只会看到「我停下了」，真正的原因在日志里。
  const lines = [];
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'x' })] }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: () => brokenTool(),
    logger: { warn: (m) => lines.push(m) },
  });
  await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.ok(lines.length >= 1, '工具出错时没有留日志');
  assert.match(lines[0], /fs\.read/);
});

test('中间轮的正文不把 META 那段带进上下文', async () => {
  // 模型被提示词要求「答完另起一行输出 <<META>>」，
  // 它在「好的，我来查一下」这种前言后面很可能也带一段——
  // 那段 JSON 进了历史，模型会以为这一轮已经出过答案了。
  const model = fakeModel([
    { text: '好的，我来查一下\n<<META>>{"emotion":"happy"}', toolCalls: [call('fs.read', {})] },
    { text: '好了' },
  ]);
  await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  const assistant = model.seen[1].find((m) => m.role === 'assistant');
  assert.doesNotMatch(assistant.content, /<<META>>/);
  assert.match(assistant.content, /好的，我来查一下/);
});

test('步数用尽：让模型用现在的上下文给个总结', async () => {
  // 规格 §12：步数用尽时**用当前上下文让模型给个总结**，
  // 而不是甩一句「我没做完」——用户至少要知道做到哪一步了。
  const model = fakeModel([
    { toolCalls: [call('fs.read', { path: 'x' })] },
    { text: '总结：我读了那个文件，它是空的' },
  ]);
  const result = await loop(model, { tools: [readTool()], maxSteps: 1 }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.MAX_STEPS);
  assert.equal(result.text, '总结：我读了那个文件，它是空的');
  // 总结时不能再调工具，否则就是又一轮循环。
  assert.deepEqual(model.toolLists[1], []);
});

test('每轮模型调用都交出正文', async () => {
  const rounds = [];
  const loop = createAgentLoop({
    callModel: async ({ messages }) => {
      const n = rounds.length + 1;
      return n === 1
        ? { text: '我先看看剪贴板', toolCalls: [{ id: 'c1', function: { name: 'clipboard.read', arguments: '{}' } }] }
        : { text: '在你剪贴板里', toolCalls: [] };
    },
    resolveTool: () => ({ name: 'clipboard.read', risk: 'read', run: async () => ({ text: '内容' }) }),
    maxSteps: 3,
    onRound: (r) => rounds.push(r),
  });
  await loop.run({ system: '', messages: [{ role: 'user', content: '在吗' }] });
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].text, '我先看看剪贴板');
  assert.deepEqual(rounds[0].toolCalls, ['clipboard.read']);
  assert.equal(rounds[1].text, '在你剪贴板里');
  // 轮次从 1 开始、连着排——记录里的「第几轮」靠它。
  assert.equal(rounds[0].index, 1);
  assert.equal(rounds[1].index, 2);
});

test('只调工具的那一轮照样交出来：正文是空串', async () => {
  const rounds = [];
  const loop = createAgentLoop({
    callModel: async () => ({
      text: '',
      toolCalls: [{ id: 'c1', function: { name: 'clipboard.read', arguments: '{}' } }],
    }),
    resolveTool: () => ({ name: 'clipboard.read', risk: 'read', run: async () => ({ text: '内容' }) }),
    maxSteps: 1,
    onRound: (r) => rounds.push(r),
  });
  await loop.run({ system: '', messages: [{ role: 'user', content: '在吗' }] });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].text, '');
  assert.deepEqual(rounds[0].toolCalls, ['clipboard.read']);
});

test('交出去的正文里没有 META 那段', async () => {
  const rounds = [];
  const loop = createAgentLoop({
    callModel: async () => ({ text: '我先看看\n<<META>>{"emotion":"happy"}', toolCalls: [] }),
    resolveTool: () => null,
    maxSteps: 1,
    onRound: (r) => rounds.push(r),
  });
  await loop.run({ system: '', messages: [{ role: 'user', content: '在吗' }] });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].text.includes('META'), false);
});

test('模型这一轮报错：没有正文，也就不交出去', async () => {
  const rounds = [];
  const loop = createAgentLoop({
    callModel: async () => {
      throw new Error('挂了');
    },
    resolveTool: () => null,
    maxSteps: 1,
    onRound: (r) => rounds.push(r),
  });
  await assert.rejects(
    () => loop.run({ system: '', messages: [{ role: 'user', content: '在吗' }] })
  );
  assert.equal(rounds.length, 0);
});

test('answerFromTool：工具带回的答复就是最终答复，不再问模型第二遍', async () => {
  const calls = [];
  const loop = createAgentLoop({
    answerFromTool: true,
    callModel: async ({ messages }) => {
      calls.push(messages);
      if (calls.length === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', function: { name: 'do.it', arguments: '{}' } }],
        };
      }
      throw new Error('不该有第二次模型调用');
    },
    resolveTool: () => ({
      name: 'do.it',
      risk: 'read',
      run: async () => ({ text: '做完了', data: { answer: '我去办' } }),
    }),
  });
  const run = await loop.run({ system: 's', messages: [{ role: 'user', content: '去办' }] });
  assert.equal(run.text, '我去办');
  assert.equal(run.outcome, AGENT_OUTCOME.DONE);
  assert.equal(calls.length, 1, '工具给了答复就不该再问模型');
});

test('answerFromTool：默认关闭时行为不变（工具的 data.answer 不算数）', async () => {
  // 同样的工具，但循环没开 answerFromTool：
  // 模型得自己再答一次，工具带的 answer 不能顶替它。
  const calls = [];
  const loop = createAgentLoop({
    callModel: async ({ messages }) => {
      calls.push(messages);
      if (calls.length === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', function: { name: 'do.it', arguments: '{}' } }],
        };
      }
      return { text: '我自己说的话', toolCalls: [] };
    },
    resolveTool: () => ({
      name: 'do.it',
      risk: 'read',
      run: async () => ({ text: '做完了', data: { answer: '我去办' } }),
    }),
  });
  const run = await loop.run({ system: 's', messages: [{ role: 'user', content: '去办' }] });
  assert.equal(run.text, '我自己说的话');
  assert.equal(run.outcome, AGENT_OUTCOME.DONE);
  assert.equal(calls.length, 2, '默认还是要把工具结果喂回模型再问一次');
});

test('answerFromTool：工具失败时不带答复，循环照常走下一轮', async () => {
  const calls = [];
  const loop = createAgentLoop({
    answerFromTool: true,
    callModel: async ({ messages }) => {
      calls.push(messages);
      if (calls.length === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', function: { name: 'do.it', arguments: '{}' } }],
        };
      }
      return { text: '出了点问题', toolCalls: [] };
    },
    resolveTool: () => ({
      name: 'do.it',
      risk: 'read',
      run: async () => {
        throw new Error('工具炸了');
      },
    }),
  });
  const run = await loop.run({ system: 's', messages: [{ role: 'user', content: '去办' }] });
  assert.equal(run.text, '出了点问题');
  assert.equal(run.outcome, AGENT_OUTCOME.DONE);
  assert.equal(calls.length, 2, '工具失败就该让模型再想一次');
});

test('answerFromTool：一个回合里多个工具给了答复：都收，最多取前两条', async () => {
  // 收集答复不能打断这一轮剩下的调用——
  // 少一条 tool 消息，接口就会因为「tool_calls 没有对应的结果」报错。
  const answers = ['甲', '乙', '丙'];
  let i = 0;
  const loop = createAgentLoop({
    answerFromTool: true,
    callModel: async () => {
      if (i >= answers.length) throw new Error('不该有第二次模型调用');
      return {
        text: '',
        toolCalls: answers.map((_, k) => ({
          id: `c${k + 1}`,
          function: { name: 'do.it', arguments: '{}' },
        })),
      };
    },
    resolveTool: () => ({
      name: 'do.it',
      risk: 'read',
      run: async () => {
        const answer = answers[i];
        i += 1;
        return { text: '做完了', data: { answer } };
      },
    }),
  });
  const run = await loop.run({
    system: 's',
    messages: [{ role: 'user', content: '去办' }],
  });
  assert.equal(run.toolCalls, 3, '这一轮剩下的调用不能被跳过');
  assert.equal(run.text, '甲 乙');
  assert.equal(run.outcome, AGENT_OUTCOME.DONE);
});
