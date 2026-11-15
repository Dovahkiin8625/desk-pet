import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentBackend } from '../../src/main/assistant/chat/agent.js';
import { AGENT_OUTCOME, safeConvo } from '../../src/main/assistant/agent/loop.js';
import { TOOL_RISK } from '../../src/shared/assistant.js';

/**
 * 统一 agent（前台 = 后台 = 同一个 agent）。
 *
 * 前台与后台的差别只有三处：步数上限、步数用尽时是总结还是交出去、
 * 工具带回的那句话算不算最终答复。这三处就是这里要守住的全部。
 */

const CONFIG = {
  apiKey: 'k',
  baseUrls: ['http://stub/v1'],
  model: 'stub-model',
  temperature: 0.7,
  maxTokens: 800,
  maxTokensField: 'max_tokens',
};

/** 造一个假接口：按顺序回预设的响应。 */
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

/** 造一句「调工具」的响应。 */
function toolCall(name, args = {}, id = 'c-1') {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

/** 造一句「说点什么」的响应。 */
function say(text) {
  return { choices: [{ message: { content: text } }] };
}

/** 造一个假工具表。 */
function fakeRegistry(tools = []) {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n) => map.get(n) || null, list: () => [...map.values()] };
}

/** 一个能列目录的假工具。 */
function listTool(overrides = {}) {
  return {
    name: 'fs.list',
    label: '列目录',
    description: '列出一个目录里的内容',
    parameters: { type: 'object', properties: {} },
    risk: TOOL_RISK.READ,
    run: async () => ({ text: 'a.txt' }),
    ...overrides,
  };
}

/** 一个假的「把这件事交出去」工具。 */
function runTool(overrides = {}) {
  return {
    name: 'task.run',
    label: '把这件事交出去继续做',
    description: '把这件事交出去继续做',
    parameters: { type: 'object', properties: {} },
    risk: TOOL_RISK.READ,
    handsOver: true,
    run: async (args) => ({
      text: '交出去了',
      data: { taskId: 't-1', answer: String(args?.reply || '').trim() },
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 前台：工具与答复
// ---------------------------------------------------------------------------

test('前台也有真工具：注册表里的工具默认带上', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([listTool()]),
  });
  await backend.chat({ messages: [{ role: 'user', content: 'F 盘有什么' }], config: CONFIG });
  const names = (calls[0].body.tools || []).map((t) => t.function.name);
  assert.deepEqual(names, ['fs.list']);
});

test('只聊天模式：注册表里的工具一个都不带', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([listTool()]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
    includeRegistryTools: false,
  });
  const names = (calls[0].body.tools || []).map((t) => t.function.name);
  assert.deepEqual(names, [], '只聊天不该碰本机');
});

test('工具表是合并的：注册表的 + 这一轮多带的', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([listTool()]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
    tools: [runTool()],
  });
  const names = (calls[0].body.tools || []).map((t) => t.function.name);
  assert.deepEqual(names, ['fs.list', 'task.run']);
});

test('工具带回的那句话就是答复：一次模型往返', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('task.run', { goal: '查天气', reply: '我去看看' }),
  ]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    tools: [runTool()],
    answerFromTool: true,
  });
  assert.equal(calls.length, 1, '不该问模型第二遍');
  assert.equal(result.text, '我去看看');
});

test('后台不用工具带回的那句：结果要喂回模型', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('task.run', { goal: '查天气', reply: '我去看看' }),
    say('查完了，晴。'),
  ]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    tools: [runTool()],
    answerFromTool: false,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.text, '查完了，晴。');
});

// ---------------------------------------------------------------------------
// 前台：交出去（升级到后台）
// ---------------------------------------------------------------------------

test('步数用尽：交给后台继续做，并带上这段对话', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('fs.list', {}, 'c-1'),
    toolCall('fs.list', {}, 'c-2'),
  ]);
  const handed = [];
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([listTool()]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: 'F 盘有什么' }],
    config: CONFIG,
    maxSteps: 2,
    summarize: false,
    canEscalate: true,
    escalate: async (payload) => {
      handed.push(payload);
      return { ok: true, taskId: 't-9' };
    },
  });
  assert.equal(handed.length, 1, '没有替用户把事交出去');
  assert.equal(result.escalated, true);
  assert.equal(result.taskId, 't-9');
  assert.equal(calls.length, 2, '前台不该多跑一轮总结');
  const convo = handed[0].convo;
  assert.equal(convo[0].role, 'user');
  assert.equal(convo[0].content, 'F 盘有什么');
});

test('说了要做却没动手：替它交出去', async () => {
  // 模型只回了一句「好嘞，我去给你放一首」，一个字都没交出去——
  // 用户那边一点动静都没有。桌宠不能拿一句空话糊弄用户。
  const { fetchImpl } = fakeFetch([say('好嘞，我去给你放一首，别切窗口啦。')]);
  const handed = [];
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '放首歌' }],
    config: CONFIG,
    tools: [runTool()],
    canEscalate: true,
    escalate: async (payload) => {
      handed.push(payload);
      return { ok: true, taskId: 't-9', answer: '' };
    },
  });
  assert.equal(handed.length, 1, '桌宠说要去做，却没把事交出去');
  assert.equal(result.escalated, true);
});

test('只是聊天：不交出去', async () => {
  const { fetchImpl } = fakeFetch([say('今天过得怎么样，想说就说，不想说也行。')]);
  const handed = [];
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '今天过得怎么样' }],
    config: CONFIG,
    tools: [runTool()],
    canEscalate: true,
    escalate: async (payload) => {
      handed.push(payload);
      return { ok: true, taskId: 't-9' };
    },
  });
  assert.equal(handed.length, 0, '聊天不该派出一个任务');
});

test('问句不算承诺：不交出去', async () => {
  const { fetchImpl } = fakeFetch([say('要不要我放首歌给你当下背景？')]);
  const handed = [];
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '我有点累' }],
    config: CONFIG,
    tools: [runTool()],
    canEscalate: true,
    escalate: async (payload) => {
      handed.push(payload);
      return { ok: true, taskId: 't-9' };
    },
  });
  assert.equal(handed.length, 0, '还在问用户，不该自己动起来');
});

test('模型自己已经交过了：不要再来一遍', async () => {
  const { fetchImpl } = fakeFetch([toolCall('task.run', { goal: '查天气', reply: '我去看看' })]);
  const handed = [];
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    tools: [runTool()],
    answerFromTool: true,
    canEscalate: true,
    escalate: async (payload) => {
      handed.push(payload);
      return { ok: true, taskId: 't-9' };
    },
  });
  assert.equal(handed.length, 0, '同一个需求交了两遍');
  assert.equal(result.text, '我去看看');
});

test('交不出去：如实告诉用户，别留一句空承诺', async () => {
  const { fetchImpl } = fakeFetch([say('好嘞，我去给你放一首。')]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '放首歌' }],
    config: CONFIG,
    tools: [runTool()],
    canEscalate: true,
    escalate: async () => ({ ok: false }),
  });
  assert.equal(result.escalated, false);
  assert.match(result.text, /放一首/);
});

// ---------------------------------------------------------------------------
// 循环与取消
// ---------------------------------------------------------------------------

test('取消：已经 abort 的 signal，一条模型请求都不该发', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([listTool()]),
  });
  const ac = new AbortController();
  ac.abort();
  const result = await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
    signal: ac.signal,
  });
  assert.equal(calls.length, 0, '已经取消了还去调模型');
  assert.equal(result.outcome, AGENT_OUTCOME.ABORTED);
});

test('工具：没有闸门时，写与执行类工具不执行，模型能换条路', async () => {
  // 没有闸门 = 用户没机会点头，就不能替他点头。
  // 拒绝要**喂回模型**（不是抛异常）：抛异常等于整件事停掉，
  // 模型连换条路的机会都没有。
  let ran = 0;
  const { calls, fetchImpl } = fakeFetch([
    toolCall('fs.list', {}, 'c-1'),
    say('这个我没法直接做。'),
  ]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () =>
      fakeRegistry([
        listTool({
          risk: TOOL_RISK.WRITE,
          run: async () => {
            ran += 1;
            return { text: '做了' };
          },
        }),
      ]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '干活' }],
    config: CONFIG,
  });
  assert.equal(ran, 0, '没闸门时写操作不能执行');
  assert.equal(calls.length, 2, '模型该有机会换条路');
  const toolMsg = calls[1].body.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /需要用户确认/);
  assert.equal(result.text, '这个我没法直接做。');
});

test('maxTokens：agent 的下限是 2048（工具参数不能被截断）', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: { ...CONFIG, maxTokens: 800 },
  });
  assert.equal(calls[0].body.max_tokens, 2048);
});

test('maxTokens：用户自己调大的照旧尊重', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => fakeRegistry([]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: { ...CONFIG, maxTokens: 4000 },
  });
  assert.equal(calls[0].body.max_tokens, 4000);
});

// ---------------------------------------------------------------------------
// safeConvo：交出去之前要把对话修成能直接发出去的样子
// ---------------------------------------------------------------------------

test('safeConvo：正常对话原样返回', () => {
  const convo = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
  ];
  assert.deepEqual(safeConvo(convo), convo);
});

test('safeConvo：半截的一轮要被截掉（否则接口 400）', () => {
  const convo = [
    { role: 'user', content: '删掉 a.png' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', function: { name: 'fs.del', arguments: '{}' } }],
    },
  ];
  const fixed = safeConvo(convo);
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].role, 'user');
});

test('safeConvo：两个调用只回来一个，也要截掉那一轮', () => {
  const convo = [
    { role: 'user', content: '删掉 a.png' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', function: { name: 'fs.del', arguments: '{}' } },
        { id: 'c2', function: { name: 'fs.del', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '删掉了' },
  ];
  const fixed = safeConvo(convo);
  assert.equal(fixed.length, 1, '少一个结果的轮次不能发出去');
});

test('safeConvo：调用都有结果时不动', () => {
  const convo = [
    { role: 'user', content: '删掉 a.png' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', function: { name: 'fs.del', arguments: '{}' } },
        { id: 'c2', function: { name: 'fs.del', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '删掉了' },
    { role: 'tool', tool_call_id: 'c2', content: '删掉了' },
  ];
  assert.deepEqual(safeConvo(convo), convo);
});
