import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionBackend } from '../../src/main/assistant/layer/interaction.js';
import { AGENT_OUTCOME } from '../../src/main/assistant/agent/loop.js';
import { TOOL_RISK } from '../../src/shared/assistant.js';

/**
 * 交互层（规格 §4）。
 *
 * 这一层只做三件事：**说话**（一次往返）、**知道自己在忙什么**（状态块）、
 * **不漏内部话术**（过滤器）。外部能力一件不留——
 * 外部能力都在后台任务那边，交互层一个工具都不给。
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
function toolCall(name, args = {}) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
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

/** 一个能列目录的假工具（交互层现在不该有它，但注册表里还在）。 */
function listTool(overrides = {}) {
  return {
    name: 'fs.list',
    label: '列目录',
    description: '列出一个目录里的内容',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => ({ text: 'a.txt' }),
    ...overrides,
  };
}

/** 一个假的「把一件事交出去」工具。 */
function submitTool(overrides = {}) {
  return {
    name: 'task.submit',
    label: '开始做一件事',
    description: '把一件事交出去做',
    parameters: { type: 'object', properties: {} },
    risk: TOOL_RISK.READ,
    run: async (args) => ({
      text: '交出去了',
      data: { taskId: 't-1', answer: String(args?.reply || '').trim() },
    }),
    ...overrides,
  };
}

test('工具表：外部能力一件不给，只剩动作类工具', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
    getTaskTools: () => [],
  });
  await backend.chat({ messages: [{ role: 'user', content: '你好' }], config: CONFIG });
  const names = (calls[0].body.tools || []).map((t) => t.function.name);
  assert.deepEqual(names, [], `交互层不该拿外部能力：${names.join(' / ')}`);
});

test('派单只走一次模型往返：工具带回的 reply 就是答复', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('task.submit', { title: '查天气', brief: '查一下', reply: '我去看看' }),
  ]);
  const submitted = [];
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [
      submitTool({
        run: async (args) => {
          submitted.push(args);
          return { text: '交出去了', data: { taskId: 't-1', answer: String(args?.reply || '').trim() } };
        },
      }),
    ],
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    turn: { userText: '今天天气怎么样', history: [] },
  });
  assert.equal(calls.length, 1, '派单不该问模型第二遍');
  assert.equal(result.text, '我去看看');
  assert.equal(submitted.length, 1);
});

test('reply 里带 META：正文剥掉 META，情绪与记忆留下', async () => {
  const { fetchImpl } = fakeFetch([
    toolCall('task.submit', {
      title: '查天气',
      brief: '查一下',
      reply: '我去看看<<META>>{"emotion":"happy","mood":5,"memories":[{"text":"他住在北京","kind":"fact"}]}',
    }),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [submitTool()],
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    turn: { userText: '今天天气怎么样', history: [] },
  });
  assert.equal(result.text, '我去看看');
  assert.equal(result.emotion, 'happy');
  assert.equal(result.mood, 5);
  assert.deepEqual(result.memories, [{ text: '他住在北京', kind: 'fact' }]);
});

test('模型没写 reply：退回第二轮，让模型自己说', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('task.submit', { title: '查天气', brief: '查一下' }),
    say('我去看一下。'),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [submitTool()],
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    turn: { userText: '今天天气怎么样', history: [] },
  });
  assert.equal(calls.length, 2, '没给答复就该再问模型一次');
  assert.equal(result.text, '我去看一下。');
});

test('提示词：写着我手头在做的事，且没有工具名', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
    getTaskStates: () => [
      {
        taskId: 't-1',
        title: '找 F 盘里的视频',
        status: 'running',
        lastStepLabel: '列目录',
        elapsedMs: 12000,
      },
    ],
  });
  await backend.chat({ messages: [{ role: 'user', content: '那个视频怎么样了' }], config: CONFIG });
  const system = calls[0].body.messages[0].content;
  assert.ok(system.includes('你手头在做的事'), system);
  assert.ok(system.includes('找 F 盘里的视频'), system);
  assert.ok(system.includes('列目录'), system);
  assert.ok(system.includes('t-1'), '编号要留着，停掉那件事时要用');
  assert.ok(!system.includes('fs.list'), '提示词里不许出现工具名');
  assert.ok(!system.includes('task.submit'), '提示词里不许出现工具名');
});

test('提示词：没有在做的事时写「现在没有别的事在忙」', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskStates: () => [],
  });
  await backend.chat({ messages: [{ role: 'user', content: '你好' }], config: CONFIG });
  const system = calls[0].body.messages[0].content;
  assert.ok(system.includes('现在没有别的事在忙'), system);
});

test('提示词：做完了的事不进状态块', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskStates: () => [
      { taskId: 't-1', title: '已经做完的事', status: 'done', lastStepLabel: '', elapsedMs: 1000 },
      { taskId: 't-2', title: '还在做的事', status: 'running', lastStepLabel: '列目录', elapsedMs: 1000 },
    ],
  });
  await backend.chat({ messages: [{ role: 'user', content: '你好' }], config: CONFIG });
  const system = calls[0].body.messages[0].content;
  assert.ok(!system.includes('已经做完的事'), system);
  assert.ok(system.includes('还在做的事'), system);
});

test('话术：答复里的「后台任务」被过滤掉', async () => {
  const { fetchImpl } = fakeFetch([say('我派了个后台任务去查。')]);
  const backend = createInteractionBackend({ fetchImpl });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '查一下' }],
    config: CONFIG,
  });
  assert.ok(!result.text.includes('后台任务'), `漏出去了：${result.text}`);
  assert.ok(!result.text.includes('派单'), `漏出去了：${result.text}`);
  assert.ok(!/后台|派发/.test(result.text), `漏出去了：${result.text}`);
});

test('话术：流出去的那一段也是干净的', async () => {
  const { fetchImpl } = fakeFetch([say('我派了个后台任务去查。')]);
  const backend = createInteractionBackend({ fetchImpl });
  const chunks = [];
  await backend.chat({
    messages: [{ role: 'user', content: '查一下' }],
    config: CONFIG,
    onDelta: (d) => chunks.push(d),
  });
  const streamed = chunks.join('');
  assert.ok(!streamed.includes('后台任务'), `流里漏出去了：${streamed}`);
});

test('maxTokens：交互层用下限 1024（工具参数不能被截断）', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({ fetchImpl });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: { ...CONFIG, maxTokens: 800 },
  });
  assert.equal(calls[0].body.max_tokens, 1024);
});

test('maxTokens：用户自己调大的照旧尊重', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({ fetchImpl });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: { ...CONFIG, maxTokens: 4000 },
  });
  assert.equal(calls[0].body.max_tokens, 4000);
});

test('步数用尽：不再多跑一轮总结（交互层要秒级）', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('task.cancel', { taskId: 't-1' }),
    toolCall('task.cancel', { taskId: 't-1' }),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [submitTool({ name: 'task.cancel' })],
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '做点什么' }],
    config: CONFIG,
    turn: { userText: '做点什么', history: [] },
  });
  // 两步用尽之后**不该有第 3 次请求**——
  // 那一轮是「让模型总结」，交互层不要它（多一次往返就慢一倍）。
  assert.equal(calls.length, 2, '步数用尽后还多跑了一轮总结');
  assert.equal(result.outcome, AGENT_OUTCOME.MAX_STEPS);
});

test('兜底：两步用尽还没答复 → 自动把事交出去，别把模型的窝囊甩给用户', async () => {
  const submitted = [];
  const { fetchImpl } = fakeFetch([
    toolCall('task.cancel', { taskId: 't-1' }),
    toolCall('task.cancel', { taskId: 't-1' }),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [
      submitTool({
        name: 'task.cancel',
        run: async () => ({ text: '停掉了', data: { answer: '' } }),
      }),
      submitTool({
        run: async (args) => {
          submitted.push(args);
          return { text: '交出去了', data: { taskId: 't-2', answer: String(args?.reply || '').trim() } };
        },
      }),
    ],
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    turn: { userText: '今天天气怎么样', history: [] },
  });
  assert.equal(submitted.length, 1, '没有替用户把事交出去');
  assert.match(submitted[0].brief, /今天天气怎么样/);
  assert.match(result.text, /我去查/);
});

test('兜底：模型自己已经交过了 → 不要再来一遍', async () => {
  const submitted = [];
  const { fetchImpl } = fakeFetch([
    toolCall('task.submit', { title: '查天气', brief: '查一下天气', reply: '我去看看' }),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [
      submitTool({
        run: async (args) => {
          submitted.push(args);
          return { text: '交出去了', data: { taskId: 't-1', answer: String(args?.reply || '').trim() } };
        },
      }),
    ],
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    turn: { userText: '今天天气怎么样', history: [] },
  });
  assert.equal(submitted.length, 1, '同一个需求交了两遍');
  assert.equal(result.text, '我去看看');
});

test('取消：已经 abort 的 signal，一条模型请求都不该发', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
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

test('工具：不是只读的工具当场报错（接线时就拦下）', async () => {
  // 没有闸门时，循环只放行只读工具，其余一律被拒——
  // 模型收到的是「需要用户确认，但审批功能还没上线」，
  // 用户只看到一句莫名其妙的话。所以要在**接线时**就说清楚。
  const { fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [submitTool({ risk: TOOL_RISK.WRITE })],
  });
  await assert.rejects(
    () =>
      backend.chat({
        messages: [{ role: 'user', content: '干活' }],
        config: CONFIG,
      }),
    (err) => {
      assert.match(err.message, /task\.submit/);
      return true;
    }
  );
});

test('请求：没配 maxTokens 时按 800 兜底，再抬到下限 1024', async () => {
  // 少了这个兜底，`Number(undefined) || 0` 会算出 0，
  // 而 0 是「合法数字」——于是真的发出去 max_tokens: 0。
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({ fetchImpl });
  const { apiKey, baseUrls, model, temperature, maxTokensField } = CONFIG;
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: { apiKey, baseUrls, model, temperature, maxTokensField },
  });
  assert.equal(calls[0].body.max_tokens, 1024);
});
