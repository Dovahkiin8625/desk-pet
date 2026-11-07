import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequestBody,
  createToolCallAccumulator,
  parseFrame,
  toRequestTools,
  chatCompletion,
  chatCompletionStream,
  chatCompletionStreamWithProbe,
} from '../../src/main/assistant/llm/openai.js';

/**
 * LLM 客户端的工具支持。
 *
 * **最大的坑：流式下的 `tool_calls` 是分片的。**
 * `choices[].delta.tool_calls[]` 里的 `function.arguments` 是一段被网络切碎的 JSON 字符串，
 * 按 `index` 到达——每帧单独 parse 必然失败；按到达顺序拼接而不看 index 也必然错位。
 *
 * 这不是假想：T0 的探针实测 MiniMax 在一次流式响应里就把两个并行调用的参数切成了 3 块。
 */

/** 造一个假的 SSE 响应。 */
function sseResponse(frames) {
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : '') },
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          releaseLock() {},
        };
      },
    },
    text: async () => body,
  };
}

/** 一个假的服务端响应（非流式）。 */
function jsonResponse(obj) {
  const body = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => body,
  };
}

const TOOL = {
  name: 'weather.get',
  label: '查天气',
  description: '按城市名查当前天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
};

test('请求体：tools 转成 OpenAI 兼容格式', () => {
  assert.deepEqual(toRequestTools([TOOL]), [
    {
      type: 'function',
      function: {
        name: 'weather.get',
        description: '按城市名查当前天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      },
    },
  ]);
});

test('请求体：工具描述符里的 label 与 risk **不能**发出去', () => {
  const [tool] = toRequestTools([TOOL]);
  assert.equal('label' in tool.function, false);
  assert.equal('risk' in tool.function, false);
  assert.equal('label' in tool, false);
});

test('请求体：没有工具时**不发** tools 字段', () => {
  const body = buildRequestBody({ model: 'm', messages: [] });
  assert.equal('tools' in body, false, '有的服务端见到空数组直接 400');
  const body2 = buildRequestBody({ model: 'm', messages: [], tools: [TOOL] });
  assert.equal(body2.tools.length, 1);
});

test('消息：role:"tool" 的消息原样带上去', () => {
  const messages = [
    { role: 'user', content: '查天气' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather.get', arguments: '{"city":"北京"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '北京 晴 26℃' },
  ];
  const body = buildRequestBody({ model: 'm', messages });
  assert.deepEqual(body.messages, messages);
  assert.equal(body.messages[2].tool_call_id, 'call_1');
});

test('累积：分片的 arguments 要按 index 拼成一整段', () => {
  const acc = createToolCallAccumulator();
  acc.push([{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{"ci' } }]);
  acc.push([{ index: 0, function: { arguments: 'ty":"北' } }]);
  acc.push([{ index: 0, function: { arguments: '京"}' } }]);
  const calls = acc.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_1');
  assert.equal(calls[0].function.name, 'weather.get');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: '北京' });
});

test('累积：并行调用交错到达时不能错位', () => {
  const acc = createToolCallAccumulator();
  // 第二个调用的第一片**先**到——按到达顺序拼接必然粘在一起。
  acc.push([{ index: 1, id: 'call_2', function: { name: 'fs.list', arguments: '{"pa' } }]);
  acc.push([{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{"ci' } }]);
  acc.push([{ index: 1, function: { arguments: 'th":"src"}' } }]);
  acc.push([{ index: 0, function: { arguments: 'ty":"北京"}' } }]);
  const calls = acc.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, 'call_1', '按 index 排序');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: '北京' });
  assert.equal(calls[1].id, 'call_2');
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { path: 'src' });
});

test('累积：工具名重复到达时不能拼成两遍', () => {
  const acc = createToolCallAccumulator();
  acc.push([{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{}' } }]);
  acc.push([{ index: 0, function: { name: 'weather.get', arguments: '' } }]);
  assert.equal(acc.calls()[0].function.name, 'weather.get');
});

test('累积：工具名被切成碎片时要拼对（"fo" + "o" → "foo"）', () => {
  const acc = createToolCallAccumulator();
  acc.push([{ index: 0, id: 'call_1', function: { name: 'fo', arguments: '' } }]);
  acc.push([{ index: 0, function: { name: 'o', arguments: '' } }]);
  assert.equal(acc.calls()[0].function.name, 'foo');
});

test('累积：服务端重发完整名时要替换，不能拼成两遍', () => {
  const acc = createToolCallAccumulator();
  acc.push([{ index: 0, id: 'call_1', function: { name: 'weather', arguments: '' } }]);
  acc.push([{ index: 0, function: { name: 'weather.get', arguments: '' } }]);
  assert.equal(acc.calls()[0].function.name, 'weather.get');
});

test('解析：一帧里的 tool_calls 与正文都认', () => {
  const parsed = parseFrame(
    JSON.stringify({
      choices: [{ delta: { content: '好的', tool_calls: [{ index: 0, id: 'c1', function: { name: 'x' } }] } }],
    })
  );
  assert.equal(parsed.content, '好的');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].id, 'c1');
});

test('流式：tool_calls 被正确累积出来', async () => {
  const frames = [
    JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] } }] }),
  ];
  const result = await chatCompletionStream(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    { fetchImpl: async () => sseResponse(frames) },
  );
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { city: '北京' });
});

test('流式：只调工具、没有正文时**不算**「接口没有返回内容」', async () => {
  const frames = [
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{"city":"北京"}' } }] } }] }),
  ];
  const result = await chatCompletionStream(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    { fetchImpl: async () => sseResponse(frames) },
  );
  assert.equal(result.text, '');
  assert.equal(result.toolCalls.length, 1);
});

test('非流式：正文为空但有 tool_calls 时不报错', async () => {
  const body = {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather.get', arguments: '{"city":"北京"}' } }],
        },
      },
    ],
  };
  const result = await chatCompletion(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    async () => jsonResponse(body),
  );
  assert.equal(result.text, '');
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { city: '北京' });
});

test('非流式：并行 tool_calls 不会被合并成一条', async () => {
  // **非流式的 tool_calls 里没有 index 字段**——
  // 拿流式那套「按 index 累积」的堆去装它们，两条并行调用会挤进同一堆，
  // 名字拼成 "weather.getfs.list"、参数拼成两段 JSON，agent 循环当场断掉。
  const body = {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'weather.get', arguments: '{"city":"北京"}' } },
            { id: 'call_2', type: 'function', function: { name: 'fs.list', arguments: '{"path":"src"}' } },
          ],
        },
      },
    ],
  };
  const result = await chatCompletion(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    async () => jsonResponse(body),
  );
  assert.equal(result.toolCalls.length, 2, '两条并行调用要各自成一条');
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].function.name, 'weather.get');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { city: '北京' });
  assert.equal(result.toolCalls[1].id, 'call_2');
  assert.equal(result.toolCalls[1].function.name, 'fs.list');
  assert.deepEqual(JSON.parse(result.toolCalls[1].function.arguments), { path: 'src' });
});

test('流式：服务端无视 stream 回整段 JSON 时，并行 tool_calls 也要各自成一条', async () => {
  const body = {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'weather.get', arguments: '{"city":"北京"}' } },
            { id: 'call_2', type: 'function', function: { name: 'fs.list', arguments: '{"path":"src"}' } },
          ],
        },
      },
    ],
  };
  const res = {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
  };
  const result = await chatCompletionStream(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    { fetchImpl: async () => res },
  );
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'weather.get');
  assert.equal(result.toolCalls[1].function.name, 'fs.list');
  assert.deepEqual(JSON.parse(result.toolCalls[1].function.arguments), { path: 'src' });
});

test('地址探测：流里已经吐过工具调用后中断，不要换个地址重来', async () => {
  // 换地址重发会让用户看到重复的动作——模型已经决定要调什么工具了。
  const frames = [
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{}' } }] } }],
    }),
  ];
  const body = frames.map((f) => `data: ${f}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  let step = 0;
  const failing = {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader() {
        return {
          read: async () => {
            if (step === 0) {
              step += 1;
              return { done: false, value: bytes };
            }
            throw new Error('连接断了');
          },
          releaseLock() {},
        };
      },
    },
    text: async () => body,
  };
  let calls = 0;
  await assert.rejects(() =>
    chatCompletionStreamWithProbe(
      { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [] },
      {
        fetchImpl: async () => {
          calls += 1;
          return failing;
        },
        baseUrls: ['https://a/v1', 'https://b/v1'],
      },
    ),
  );
  assert.equal(calls, 1, '已经吐过东西就不该换个地址重发');
});
