// think 模式的单元测试。
//
// 盯住四件事：
//   1. 开关与档位落到请求体上是什么形状；
//   2. **思考内容绝不进气泡**（服务端不拆开的时候它会内联在正文里）；
//   3. 模型不认这些参数时要自动退回去，并且告诉调用方一声；
//   4. 磁盘上认不出来的值要退回合法值。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequestBody,
  buildThinkFields,
  createReasoningStripper,
  chatCompletionStreamWithProbe,
} from '../../src/main/assistant/llm/openai.js';
import { sanitizeAssistant } from '../../src/main/assistant/state.js';

/** 造一个只记录请求的假接口。 */
function fakeFetch({ reply = '好的', rejectThink = false } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (rejectThink && body.thinking) {
      return new Response(
        JSON.stringify({ error: { message: 'unknown parameter: thinking', code: 1000 } }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const MESSAGES = [{ role: 'user', content: '你好' }];

test('think 打开：请求里带上思考参数与深度', () => {
  const body = buildRequestBody({
    model: 'm',
    messages: MESSAGES,
    think: { mode: 'on', level: 'high' },
  });
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.reasoning_split, true);
  assert.equal(body.reasoning_effort, 'high');
});

test('think 关掉：明确告诉模型不要思考', () => {
  const body = buildRequestBody({
    model: 'm',
    messages: MESSAGES,
    think: { mode: 'off', level: 'medium' },
  });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  // 关掉时不发深度与拆分：那是「让模型思考」时才用的。
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.reasoning_split, undefined);
});

test('think 退路：什么都不发', () => {
  assert.equal(buildThinkFields({ mode: 'none' }), null);
  assert.equal(buildThinkFields(null), null);
  const body = buildRequestBody({ model: 'm', messages: MESSAGES, think: { mode: 'none' } });
  assert.equal(body.thinking, undefined);
});

test('think 深度认不出来时当「中」', () => {
  const fields = buildThinkFields({ mode: 'on', level: '胡说' });
  assert.equal(fields.reasoning_effort, 'medium');
});

test('思考内容不会混进正文', () => {
  const stripper = createReasoningStripper();
  assert.equal(stripper.push('你好<reasoning_content>我想想'), '你好');
  assert.equal(stripper.push('</reasoning_content>完了'), '完了');
  assert.equal(stripper.finish(), '');
  assert.equal(stripper.text, '你好完了');
});

test('思考标签跨 chunk 也能剥干净', () => {
  const stripper = createReasoningStripper();
  // 标签被切成两半：先按住前半截，别把半个标签吐出去。
  assert.equal(stripper.push('答案<reason'), '答案');
  assert.equal(stripper.push('ing_content>想了点事'), '');
  assert.equal(stripper.push('</reasoning_content>好了'), '好了');
  assert.equal(stripper.finish(), '');
});

test('模型不认 think 参数：去掉参数重试，并告诉调用方', async () => {
  const { calls, fetchImpl } = fakeFetch({ rejectThink: true });
  const unsupported = [];
  const result = await chatCompletionStreamWithProbe(
    {
      apiKey: 'k',
      model: 'm',
      messages: MESSAGES,
      think: { mode: 'on', level: 'medium', onUnsupported: (info) => unsupported.push(info) },
    },
    { fetchImpl, baseUrls: ['https://example.test/v1'] }
  );

  assert.equal(result.text, '好的', '重试之后应该拿到回复');
  assert.equal(result.thinkUnsupported, true);
  assert.equal(calls.length, 2, '应该重试一次');
  assert.equal(calls[0].thinking.type, 'adaptive');
  assert.equal(calls[1].thinking, undefined, '重试时不该再带 think 参数');
  assert.equal(unsupported.length, 1, '没有通知调用方');
  assert.equal(unsupported[0].model, 'm');
  // 通知里要带上「原来是怎么发的」：关着的时候提醒的语气不一样。
  assert.equal(unsupported[0].mode, 'on');
});

test('模型不认 think 参数（关着的时候也一样）：照样退回去', async () => {
  const { calls, fetchImpl } = fakeFetch({ rejectThink: true });
  const unsupported = [];
  const result = await chatCompletionStreamWithProbe(
    {
      apiKey: 'k',
      model: 'm',
      messages: MESSAGES,
      think: { mode: 'off', level: 'medium', onUnsupported: (info) => unsupported.push(info) },
    },
    { fetchImpl, baseUrls: ['https://example.test/v1'] }
  );

  assert.equal(result.thinkUnsupported, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].thinking, { type: 'disabled' });
  assert.equal(calls[1].thinking, undefined);
  assert.equal(unsupported[0].mode, 'off');
});

test('模型不认 think 参数时，回复正文照样干净', async () => {
  const { fetchImpl } = fakeFetch({ reply: '答案<reasoning_content>心里想</reasoning_content>好了' });
  const result = await chatCompletionStreamWithProbe(
    { apiKey: 'k', model: 'm', messages: MESSAGES },
    { fetchImpl, baseUrls: ['https://example.test/v1'] }
  );
  assert.equal(result.text, '答案好了');
});

test('状态：think 与深度认不出来时退回合法值', () => {
  const state = sanitizeAssistant({ llm: { think: 'yes', thinkLevel: '胡说' } });
  assert.equal(state.llm.think, true);
  assert.equal(state.llm.thinkLevel, 'medium');

  const off = sanitizeAssistant({ llm: {} });
  assert.equal(off.llm.think, false);
  assert.equal(off.llm.thinkLevel, 'medium');
});
