import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionBackend } from '../../src/main/assistant/layer/interaction.js';
import { AGENT_OUTCOME } from '../../src/main/assistant/agent/loop.js';
import { TOOL_RISK } from '../../src/shared/assistant.js';

/**
 * 交互层（规格 §4）。
 *
 * 三件事最容易做错：
 * 1. **快工具整轮只有一次**——不靠提示词自觉，靠执行器强制；
 * 2. **配额按尝试计数**——失败的快工具也算用掉了，
 *    失败之后的唯一出路是转派后台任务，不是重试；
 * 3. **实时状态写在提示词里**——「现在几点」「还有几个任务在跑」
 *    不该花一次工具调用。
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

/** 一个能列目录的假工具。 */
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

test('快工具：整轮只能用一次，第二次被拒', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('clock.now'),
    toolCall('fs.list'),
    say('现在十点。'),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '现在几点' }],
    config: CONFIG,
  });

  assert.equal(result.steps, 3);
  // 第二次快工具被拒了：那一句拒绝要喂回模型。
  //
  // **看的是第三次请求**：拒绝发生在第二步（跑工具的时候），
  // 它的内容要等下一次调模型才进上下文——所以在第三次请求里。
  const third = calls[2].body.messages;
  assert.ok(
    third.some((m) => String(m.content).includes('这一轮只能用一次快工具')),
    '第二次快工具没有被拒'
  );
  assert.equal(result.text, '现在十点。');
});

test('快工具：失败的也算用掉配额', async () => {
  const failing = listTool({
    run: async () => {
      throw new Error('列不了那个目录');
    },
  });
  const { calls, fetchImpl } = fakeFetch([
    toolCall('fs.list'),
    toolCall('fs.list'),
    say('那个目录我打不开。'),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([failing]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '列一下 D 盘' }],
    config: CONFIG,
  });

  // 第一次失败；第二次**不是**再试一次，而是被配额拦住。
  //
  // **看的是第三次请求**：配额拒绝是在第二步跑工具时发生的，
  // 它的内容要等下一次调模型才进上下文。
  const third = calls[2].body.messages;
  assert.ok(
    third.some((m) => String(m.content).includes('这一轮只能用一次快工具')),
    '失败的快工具没有消耗掉配额'
  );
});

test('提示词：预置了时间与在跑的任务数', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
    getTaskCounts: () => ({ running: 2, queued: 1 }),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '有几次任务在跑' }],
    config: CONFIG,
  });

  const system = calls[0].body.messages[0].content;
  assert.ok(
    system.includes('后台正在跑 2 个任务，排队 1 个'),
    `提示词里没有实时状态：\n${system}`
  );
  // 现在几点不用花工具调用：日期就写在提示词里。
  assert.match(system, /\d{4} 年 \d{1,2} 月 \d{1,2} 日/);
});

test('提示词：写着先自己答一次，别动不动就派单', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
  });
  const system = calls[0].body.messages[0].content;
  assert.ok(system.includes('先自己答一次'), `提示词没写清楚派单条件：\n${system}`);
});

test('轮次上限：3 步还没给答复就收尾，不空着', async () => {
  // 每次都调工具：模型一直没交卷。
  //
  // **两个工具轮流调**（不是同一个调三次）：
  // 循环里「同一个错误连着出三次就停」的计数是按「工具名 + 错误」算的，
  // 同一个工具连错三次会走 `repeated_errors` 那条路，
  // 收尾的话变成「这个工具连着出了几次错」——
  // 那就不是这条测试要验的「步数用尽」了。
  // 轮流调 → 每次的错都不一样 → 循环走到步数上限才停。
  const { fetchImpl } = fakeFetch([toolCall('clock.now'), toolCall('fs.list')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '做点什么' }],
    config: CONFIG,
  });
  assert.equal(result.steps, 3);
  assert.match(result.text, /没能在这 3 步之内/);
});

test('步数用尽：不再多跑一轮总结（交互层要秒级）', async () => {
  const { calls, fetchImpl } = fakeFetch([toolCall('clock.now'), toolCall('fs.list')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '做点什么' }],
    config: CONFIG,
  });
  // 3 步用尽之后**不该有第 4 次请求**——
  // 那一轮是「让模型总结」，交互层不要它（多一次往返就慢一倍）。
  assert.equal(calls.length, 3, '步数用尽后还多跑了一轮总结');
  assert.equal(result.outcome, AGENT_OUTCOME.MAX_STEPS);
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
    getRegistry: () => fakeRegistry([listTool()]),
    getTaskTools: () => [
      {
        name: 'task.submit',
        label: '派单',
        description: '派一个后台任务',
        parameters: { type: 'object', properties: {} },
        risk: TOOL_RISK.WRITE,
        run: async () => ({ text: '派了' }),
      },
    ],
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

test('请求：没配 maxTokens 时按 800 兜底', async () => {
  // 少了这个兜底，`Number(undefined) || 0` 会算出 0，
  // 而 0 是「合法数字」——于是真的发出去 max_tokens: 0。
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  const { apiKey, baseUrls, model, temperature, maxTokensField } = CONFIG;
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: { apiKey, baseUrls, model, temperature, maxTokensField },
  });
  assert.equal(calls[0].body.max_tokens, 800);
});

test('提示词：只报这一轮实际可用的快工具', async () => {
  // 注册表里没有的工具不能报：报了模型就会去调，
  // 循环回一句「没有这个工具」——白烧一步。
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
  });
  const system = calls[0].body.messages[0].content;
  assert.ok(system.includes('fs.list'), `提示词里没有 fs.list：\n${system}`);
  assert.ok(!system.includes('fs.read'), `提示词里报了没注册的工具 fs.read：\n${system}`);
});

test('提示词：注册表里没有 fs.list 时就不报它', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
  });
  const system = calls[0].body.messages[0].content;
  assert.ok(!system.includes('fs.list'), `提示词里报了没注册的工具 fs.list：\n${system}`);
});

test('交互层把这一回合的过程写成记录', async () => {
  const written = [];
  const backend = createInteractionBackend({
    fetchImpl: fakeFetch([
      toolCall('clipboard.read', {}),
      say('在你剪贴板里'),
    ]).fetchImpl,
    getRegistry: () =>
      fakeRegistry([{ name: 'clipboard.read', risk: 'read', run: async () => ({ text: '内容' }) }]),
    getTaskTools: () => [],
    appendRecord: (entry) => written.push(entry),
    getPersona: () => ({}),
    getFacts: () => [],
    getNow: () => new Date(),
    getTaskCounts: () => ({ running: 0, queued: 0 }),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '剪贴板里是什么' }],
    // 配置用整个 CONFIG：模型名就是 'stub-model'，别的字段（apiKey 等）也要有。
    config: CONFIG,
  });

  const model = written.filter((e) => e.kind === 'model');
  assert.equal(model.length, 1);
  assert.equal(model[0].text, '在你剪贴板里');
  assert.equal(model[0].meta.model, 'stub-model');
  assert.equal(model[0].meta.index, 2, '轮号是模型往返的次序：工具轮也占一个号');

  const call = written.filter((e) => e.kind === 'step');
  assert.equal(call.length, 1);
  assert.equal(call[0].meta.tool, 'clipboard.read');
  assert.equal(call[0].meta.layer, 'interaction');
});

test('任务管理工具不记 step——它们已经是派单记录了', async () => {
  // 记两遍的话，页面上会出现两行说同一件事的话。
  const written = [];
  const { fetchImpl } = fakeFetch([toolCall('task.submit', { title: '查视频' }), say('派出去了。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([]),
    getTaskTools: () => [
      {
        name: 'task.submit',
        label: '派单',
        description: '派一个后台任务',
        parameters: { type: 'object', properties: {} },
        risk: TOOL_RISK.READ,
        run: async () => ({ text: '已派出任务 t-1' }),
      },
    ],
    appendRecord: (entry) => written.push(entry),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '帮我查下视频' }],
    config: CONFIG,
  });

  assert.equal(
    written.filter((e) => e.kind === 'step').length,
    0,
    'task.* 工具不该再记一条 step'
  );
});
