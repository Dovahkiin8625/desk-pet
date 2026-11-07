import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequestBody,
  createToolCallAccumulator,
  parseFrame,
  toRequestTools,
  chatCompletion,
  chatCompletionStream,
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
