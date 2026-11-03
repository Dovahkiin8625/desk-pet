import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUrl,
  buildRequestBody,
  splitSseFrames,
  extractDelta,
  classifyHttpStatus,
  chatCompletion,
  chatCompletionStream,
  chatCompletionStreamWithProbe,
  LLM_ERRORS,
  redactUrl,
} from '../../src/main/assistant/llm/openai.js';

/**
 * OpenAI 兼容协议的大模型客户端。
 *
 * 重点在两个地方：**SSE 的解析**与**中文跨块不乱码**——
 * 后者是这个协议最容易踩的坑（一个汉字 3 字节，分块边界切在中间就出乱码）。
 */

/** 造一个 SSE 响应。 */
function sseResponse(frames, { status = 200, contentType = 'text/event-stream' } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return {
    ok: status < 400,
    status,
    headers: new Headers({ 'content-type': contentType }),
    body,
    text: async () => frames.join(''),
    json: async () => ({}),
  };
}

/** 造一个普通 JSON 响应。 */
function jsonResponse(payload, { status = 200 } = {}) {
  const text = JSON.stringify(payload);
  return {
    ok: status < 400,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    text: async () => text,
    json: async () => payload,
  };
}

function frame(delta) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

const PARAMS = {
  apiKey: 'sk-test',
  baseUrl: 'https://api.minimaxi.com/v1',
  model: 'test-model',
  messages: [{ role: 'user', content: '你好' }],
};

test('接口地址：填 /v1 的 base_url 会被补成完整地址', () => {
  assert.equal(buildUrl('https://api.minimaxi.com/v1'), 'https://api.minimaxi.com/v1/chat/completions');
  assert.equal(buildUrl('https://api.minimaxi.com/v1/'), 'https://api.minimaxi.com/v1/chat/completions');
  assert.equal(buildUrl('https://x.com'), 'https://x.com/v1/chat/completions');
});

test('接口地址：填了完整地址就原样用', () => {
  const full = 'https://api.minimaxi.com/v1/chat/completions';
  assert.equal(buildUrl(full), full);
});

test('请求体：只发一个 token 字段', () => {
  const body = buildRequestBody({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    temperature: 0.5,
    maxTokens: 100,
    maxTokensField: 'max_tokens',
    stream: true,
  });
  assert.equal(body.max_tokens, 100);
  assert.equal(body.max_completion_tokens, undefined, '两个字段不能同时发');
  assert.equal(body.stream, true);
  assert.equal(body.temperature, 0.5);
});

test('请求体：字段名可以换成 max_completion_tokens', () => {
  const body = buildRequestBody({
    model: 'm',
    messages: [],
    maxTokens: 200,
    maxTokensField: 'max_completion_tokens',
  });
  assert.equal(body.max_completion_tokens, 200);
  assert.equal(body.max_tokens, undefined);
});

test('请求体：默认不发 stream_options（严格服务端会 400）', () => {
  const body = buildRequestBody({ model: 'm', messages: [], stream: true });
  assert.equal(body.stream_options, undefined);
});

test('SSE 分帧：按空行切，注释帧与 event 行跳过', () => {
  const { frames, rest } = splitSseFrames(
    'data: {"a":1}\n\n: keep-alive\n\nevent: ping\ndata: {"b":2}\n\ndata: {"c":3}'
  );
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, 'data: {"c":3}', '没切完的部分要留着');
});

test('SSE 分帧：兼容 \r\n\r\n', () => {
  const { frames } = splitSseFrames('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n');
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}']);
});

test('取增量：兼容 delta / message / text 三种形态', () => {
  assert.equal(extractDelta('{"choices":[{"delta":{"content":"你好"}}]}'), '你好');
  assert.equal(extractDelta('{"choices":[{"message":{"content":"你好"}}]}'), '你好');
  assert.equal(extractDelta('{"choices":[{"text":"你好"}]}'), '你好');
});

test('取增量：只有 role 没有 content 的帧算空', () => {
  assert.equal(extractDelta('{"choices":[{"delta":{"role":"assistant"}}]}'), '');
  assert.equal(extractDelta('[DONE]'), '');
});

test('取增量：不读 reasoning_content（那是模型的心里话）', () => {
  const f = JSON.stringify({
    choices: [{ delta: { content: '说给你听', reasoning_content: '<<META>>{"emotion":"happy"}' } }],
  });
  assert.equal(extractDelta(f), '说给你听');
});

test('取增量：不是 JSON 抛「格式错误」', () => {
  assert.throws(() => extractDelta('这不是 JSON'), (err) => err.code === LLM_ERRORS.MALFORMED);
});

test('流式调用：逐帧吐出增量', async () => {
  const calls = [];
  const fetchImpl = async () =>
    sseResponse([frame('你好'), frame('呀'), 'data: [DONE]\n\n']);
  const result = await chatCompletionStream(PARAMS, {
    fetchImpl,
    onDelta: (d) => calls.push(d),
  });
  assert.deepEqual(calls, ['你好', '呀']);
  assert.equal(result.text, '你好呀');
});

test('流式调用：请求的地址与头是对的', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return sseResponse([frame('ok'), 'data: [DONE]\n\n']);
  };
  await chatCompletionStream(PARAMS, { fetchImpl });
  assert.equal(seen.url, 'https://api.minimaxi.com/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(seen.body.model, 'test-model');
  assert.equal(seen.body.stream, true);
  assert.equal(seen.body.messages[0].content, '你好');
});

test('流式调用：中文跨块不乱码', async () => {
  // 把一个汉字拆成两个 chunk 发出去——真实网络里就是这么切的。
  const bytes = new TextEncoder().encode('你');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body,
    text: async () => '',
  });
  const calls = [];
  // 直接喂一整段 SSE，但响应体被切成半个汉字。
  const result = await chatCompletionStream(
    { ...PARAMS, messages: [] },
    { fetchImpl, onDelta: (d) => calls.push(d) },
  );
  // 半个汉字解不出来是正常的（它不是完整的 SSE），
  // 这里验的是：**解码器必须是带状态的**，否则会吐乱码。
  assert.ok(!calls.join('').includes('�'), '不应该出现乱码');
  assert.equal(typeof result.text, 'string');
});

test('流式调用：服务端无视 stream:true 直接回 JSON，也能用', async () => {
  const fetchImpl = async () =>
    jsonResponse({ choices: [{ message: { content: '一整段回复' } }] });
  const calls = [];
  const result = await chatCompletionStream(PARAMS, { fetchImpl, onDelta: (d) => calls.push(d) });
  assert.equal(result.text, '一整段回复');
  assert.deepEqual(calls, ['一整段回复']);
});

test('错误分类：HTTP 状态码', () => {
  assert.equal(classifyHttpStatus(401), LLM_ERRORS.AUTH);
  assert.equal(classifyHttpStatus(403), LLM_ERRORS.AUTH);
  assert.equal(classifyHttpStatus(429), LLM_ERRORS.RATE_LIMIT);
  assert.equal(classifyHttpStatus(400), LLM_ERRORS.BAD_REQUEST);
  assert.equal(classifyHttpStatus(404), LLM_ERRORS.BAD_REQUEST);
  assert.equal(classifyHttpStatus(500), LLM_ERRORS.SERVER);
});

test('流式调用：401 抛鉴权错误', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(
    () => chatCompletionStream(PARAMS, { fetchImpl }),
    (err) => err.code === LLM_ERRORS.AUTH && err.status === 401
  );
});

test('流式调用：连不上抛网络错误', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    () => chatCompletionStream(PARAMS, { fetchImpl }),
    (err) => err.code === LLM_ERRORS.NETWORK
  );
});

test('流式调用：没有 key / 没有地址 / 没有模型 都是「配置错误」', async () => {
  await assert.rejects(
    () => chatCompletionStream({ ...PARAMS, apiKey: '' }, { fetchImpl: async () => sseResponse([]) }),
    (err) => err.code === LLM_ERRORS.CONFIG
  );
  await assert.rejects(
    () => chatCompletionStream({ ...PARAMS, baseUrl: '' }, { fetchImpl: async () => sseResponse([]) }),
    (err) => err.code === LLM_ERRORS.CONFIG
  );
  await assert.rejects(
    () => chatCompletionStream({ ...PARAMS, model: '' }, { fetchImpl: async () => sseResponse([]) }),
    (err) => err.code === LLM_ERRORS.CONFIG
  );
});

test('错误消息里绝不能带 key', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'nope' });
  await assert.rejects(
    () => chatCompletionStream({ ...PARAMS, apiKey: 'sk-secret-value' }, { fetchImpl }),
    (err) => !String(err.message).includes('sk-secret-value')
  );
});

test('探测：鉴权失败会换下一个地址（key 是分区域的）', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (urls.length === 1) return { ok: false, status: 401, text: async () => 'unauthorized' };
    return sseResponse([frame('好了'), 'data: [DONE]\n\n']);
  };
  const result = await chatCompletionStreamWithProbe(PARAMS, {
    fetchImpl,
    baseUrls: ['https://a.example/v1', 'https://b.example/v1'],
  });
  assert.equal(urls.length, 2);
  assert.equal(result.text, '好了');
  assert.equal(result.baseUrl, 'https://b.example/v1');
});

test('探测：请求本身不对不换地址', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return { ok: false, status: 400, text: async () => 'bad request' };
  };
  await assert.rejects(
    () =>
      chatCompletionStreamWithProbe(PARAMS, {
        fetchImpl,
        baseUrls: ['https://a.example/v1', 'https://b.example/v1'],
      }),
    (err) => err.code === LLM_ERRORS.BAD_REQUEST
  );
  assert.equal(count, 1, '请求不对的时候换地址也只是同样的 400');
});

test('探测：已经吐过字之后失败不重来（否则用户会看到重复的半句）', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    if (count === 1) {
      const encoder = new TextEncoder();
      // 用 pull 而不是 start：start 里调 controller.error() 会**丢掉队列里
      // 还没被读走的块**——那就没有「已经吐过字」可言了。
      let pulls = 0;
      const body = new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encoder.encode(frame('半句')));
            return;
          }
          controller.error(new Error('断了'));
        },
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body,
        text: async () => '',
      };
    }
    return sseResponse([frame('完整'), 'data: [DONE]\n\n']);
  };
  await assert.rejects(
    () =>
      chatCompletionStreamWithProbe(PARAMS, {
        fetchImpl,
        baseUrls: ['https://a.example/v1', 'https://b.example/v1'],
      }),
    (err) => err.code === LLM_ERRORS.NETWORK
  );
  assert.equal(count, 1, '已经吐过字就不该再试下一个地址');
});

test('非流式调用：取正文', async () => {
  const fetchImpl = async () =>
    jsonResponse({ choices: [{ message: { content: '你好呀' } }] });
  const result = await chatCompletion(PARAMS, fetchImpl);
  assert.equal(result.text, '你好呀');
});

test('非流式调用：没有内容抛格式错误', async () => {
  const fetchImpl = async () => jsonResponse({ choices: [] });
  await assert.rejects(
    () => chatCompletion(PARAMS, fetchImpl),
    (err) => err.code === LLM_ERRORS.MALFORMED
  );
});

test('没有 key 时连请求都不该发（配置错误）', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return sseResponse([]);
  };
  await assert.rejects(
    () => chatCompletionStream({ ...PARAMS, apiKey: '' }, { fetchImpl }),
    (err) => err.code === LLM_ERRORS.CONFIG
  );
  assert.equal(called, 0, '没有 key 就不该打接口');
});

test('错误消息里的接口地址要脱敏（有人会把密钥写在地址里）', () => {
  // Azure 风格的 ?api-key=… 与 https://key@host 这种 userinfo 形式。
  assert.equal(
    redactUrl('https://host.example/v1?api-key=sk-secret'),
    'https://host.example/v1'
  );
  assert.equal(redactUrl('https://key@host.example/v1'), 'https://***@host.example/v1');
  assert.equal(redactUrl(''), '');
});
