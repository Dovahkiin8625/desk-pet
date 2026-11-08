import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentBackend } from '../../src/main/assistant/chat/agent.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';
import { sanitizeAssistant } from '../../src/main/assistant/state.js';

/** 造一个只记录请求、返回固定回复的假接口。 */
function fakeFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

/** 造一个工具表。 */
function registryWithTool() {
  const registry = createToolRegistry();
  registry.register({
    name: 'fs.read',
    label: '读文件',
    description: '读文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    risk: 'read',
    async run() {
      return { text: '文件内容' };
    },
  });
  return registry;
}

const CONFIG = {
  apiKey: 'k',
  model: 'm',
  baseUrls: ['https://example.test/v1'],
  temperature: 0.7,
  maxTokens: 800,
  maxTokensField: 'max_tokens',
};

test('agent 后端：请求里带了工具表', async () => {
  const { calls, fetchImpl } = fakeFetch('好的');
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
    onDelta: () => {},
  });
  assert.ok(calls[0].body.tools, '请求里没有 tools');
  assert.equal(calls[0].body.tools[0].function.name, 'fs.read');
  // label 与 risk 不能发出去：有的服务端见到不认识的字段直接 400。
  assert.equal(calls[0].body.tools[0].function.risk, undefined);
  assert.equal(calls[0].body.tools[0].function.label, undefined);
});

test('agent 后端：回复要过 parseReply，情绪与记忆都拿得到', async () => {
  const reply = '搞定了\n<<META>>{"emotion":"happy","mood":5,"memories":["用户喜欢喝美式"]}';
  const { fetchImpl } = fakeFetch(reply);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
    onDelta: () => {},
  });
  assert.equal(result.text, '搞定了');
  assert.equal(result.emotion, 'happy');
  assert.equal(result.mood, 5);
  assert.deepEqual(result.memories, ['用户喜欢喝美式']);
});

test('agent 后端：模型不支持工具调用时，要说人话', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'tools is not supported' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  await assert.rejects(
    () =>
      backend.chat({
        messages: [{ role: 'user', content: '你好' }],
        config: CONFIG,
        onDelta: () => {},
      }),
    (err) => {
      assert.match(err.message, /工具/);
      assert.match(err.message, /普通对话/);
      return true;
    }
  );
});

test('agent 后端：后端 id 是 agent', () => {
  const backend = createAgentBackend({});
  assert.equal(backend.id, 'agent');
});

test('agent 后端：400 与工具无关时，不要翻译成「模型不支持工具调用」', async () => {
  // **不能见 400 就说「模型不支持工具调用」**：上下文超长也是 400，
  // 照着「换个模型」去折腾，用户的问题根本没被说到。
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'context length exceeded' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  await assert.rejects(
    () =>
      backend.chat({
        messages: [{ role: 'user', content: '你好' }],
        config: CONFIG,
        onDelta: () => {},
      }),
    (err) => {
      assert.doesNotMatch(err.message, /不支持工具调用/);
      assert.match(err.message, /400/);
      return true;
    }
  );
});

test('agent 后端：每步的 token 上限要留得下工具参数', async () => {
  // 工具参数（JSON）和正文**共用**同一个额度：上限太小，
  // 参数会被截断成非法 JSON，于是每一轮都在「参数坏了」上白转。
  const { calls, fetchImpl } = fakeFetch('好的');
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: { ...CONFIG, maxTokens: 800 },
    onDelta: () => {},
  });
  assert.ok(
    calls[0].body.max_tokens >= 2048,
    `每步的 token 上限只有 ${calls[0].body.max_tokens}，工具参数会被截断`
  );
});

test('后端取值：只认 chat 与 agent，别的当普通对话', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'agent' } }).llm.backend, 'agent');
  assert.equal(sanitizeAssistant({ llm: { backend: 'chat' } }).llm.backend, 'chat');
  // 磁盘上的值可能是旧版本留下的，也可能是手改的：认不出来就不能用。
  assert.equal(sanitizeAssistant({ llm: { backend: 'bogus' } }).llm.backend, 'chat');
  assert.equal(sanitizeAssistant({ llm: { backend: 123 } }).llm.backend, 'chat');
  assert.equal(sanitizeAssistant({ llm: {} }).llm.backend, 'chat');
});
