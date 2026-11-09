import test from 'node:test';
import assert from 'node:assert/strict';

import { LAYER } from '../../src/shared/assistant.js';
import { buildChatMessages } from '../../src/main/assistant/chat/prompt.js';
import { createPlainBackend } from '../../src/main/assistant/chat/plain.js';
import { createAgentBackend } from '../../src/main/assistant/chat/agent.js';
import { createAgentTasks } from '../../src/main/assistant/agent/tasks.js';
import { createInteractionBackend } from '../../src/main/assistant/layer/interaction.js';
import { createTaskTools } from '../../src/main/assistant/layer/taskTools.js';
import { runForeground, FALLBACK_NOTICE } from '../../src/main/assistant/layer/foreground.js';
import { LlmError, LLM_ERRORS } from '../../src/main/assistant/llm/openai.js';

/**
 * 两层接线的端到端（规格 §7）。
 *
 * 这里盯的是**那条硬 bug**：用户在任务跑着的时候又说了句话，
 * 任务的结果就没了。现在前台对话与后台任务彻底分开，
 * 两者的序号互不干涉。
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

/** 等某个条件成立。 */
async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

/** 按主进程的样子把两层接起来（不引 electron）。 */
function wire({ interactionFetch, executionFetch }) {
  const records = [];
  const notices = [];

  const execRegistry = fakeRegistry([
    {
      name: 'fs.list',
      label: '列目录',
      description: '列目录',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      run: async () => ({ text: 'a.txt' }),
    },
  ]);

  const agentBackend = createAgentBackend({
    // **要的是那个函数**：`fakeFetch()` 返回的是 {calls, fetchImpl}，
    // 直接把那个对象塞进来，调用时会炸「fetchImpl is not a function」。
    fetchImpl: executionFetch.fetchImpl,
    getTools: () => execRegistry,
    getGate: () => null,
    getMaxSteps: () => 5,
  });

  const tasks = createAgentTasks({
    backend: agentBackend,
    appendRecord: (entry) => records.push(entry),
    notify: (n) => notices.push(n),
    getMessages: (prompt) =>
      buildChatMessages({ history: [], userText: prompt, layer: LAYER.EXECUTION }),
  });

  const interaction = createInteractionBackend({
    fetchImpl: interactionFetch.fetchImpl,
    getRegistry: () => fakeRegistry([]),
    getTaskTools: (turn) =>
      createTaskTools({
        tasks,
        turn,
        dispatchEnabled: true,
        appendRecord: (entry) => records.push(entry),
        now: () => 1,
      }),
    getTaskCounts: () => tasks.counts(),
  });

  return { tasks, interaction, records, notices };
}

test('派单 → 后台跑 → 完成通知', async () => {
  const interactionFetch = fakeFetch([
    toolCall('task.submit', { title: '查视频', brief: '看看 F:\\video 下有什么' }),
    say('我去看看。'),
  ]);
  const executionFetch = fakeFetch([say('F:\\video 下有 3 个视频。')]);
  const { interaction, records, notices } = wire({ interactionFetch, executionFetch });

  const result = await interaction.chat({
    messages: buildChatMessages({ history: [], userText: 'F 盘 video 下有什么', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: 'F 盘 video 下有什么', config: CONFIG },
  });
  assert.equal(result.text, '我去看看。');

  const notice = await waitFor(() => notices[0]);
  assert.ok(notice, '任务做完了要通知用户');
  assert.match(notice.text, /3 个视频/);

  // 派单记录里有任务号：交互层下一轮要靠它说「停掉刚才那个」。
  const dispatch = records.find((r) => r.kind === 'dispatch');
  assert.ok(dispatch, '派单要有记录');
  assert.ok(dispatch.meta.taskId, '派单记录要带任务号');
});

test('用户中途又说话：任务不受影响，结果照样送到', async () => {
  const interactionFetch = fakeFetch([
    toolCall('task.submit', { title: '查视频', brief: '看看' }),
    say('我去看看。'),
    say('你好。'),
  ]);
  const executionFetch = fakeFetch([say('查完了。')]);
  const { interaction, tasks, notices } = wire({ interactionFetch, executionFetch });

  await interaction.chat({
    messages: buildChatMessages({ history: [], userText: 'F 盘 video 下有什么', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: 'F 盘 video 下有什么', config: CONFIG },
  });

  // 用户又说话了：这是**另一轮前台对话**，不该碰到后台任务。
  await interaction.chat({
    messages: buildChatMessages({ history: [], userText: '顺便问一句', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: '顺便问一句', config: CONFIG },
  });

  const notice = await waitFor(() => notices[0]);
  assert.ok(notice, '结果被新对话吞掉了');
  assert.match(notice.text, /查完了/);
  assert.equal(tasks.list()[0].status, 'done');
});

test('模型不支持工具调用：这一轮退回普通对话，并告诉用户', async () => {
  const plainFetch = fakeFetch([say('你好呀。')]);
  const plain = createPlainBackend({ fetchImpl: plainFetch.fetchImpl });

  // 用真的错误来跑：isToolsUnsupportedError 只认 LlmError + BAD_REQUEST
  // 且原文里提到工具，普通 Error 它不认（那样就不该退回）。
  const interaction = {
    async chat() {
      throw new LlmError(FALLBACK_NOTICE, {
        code: LLM_ERRORS.BAD_REQUEST,
        status: 400,
        body: 'tools is not supported',
      });
    },
  };

  let fallback = null;
  const result = await runForeground({
    interaction,
    plain,
    ctx: {
      system: '你是小桌',
      messages: [{ role: 'user', content: '你好' }],
      config: CONFIG,
    },
    onFallback: (err) => {
      fallback = err;
    },
  });

  assert.equal(result.text, '你好呀。');
  assert.ok(fallback, '要告诉用户这个模型不支持工具调用');
});

test('前台这一轮的轮数：模型往返了几次', async () => {
  const interactionFetch = fakeFetch([say('你好。')]);
  const { interaction } = wire({ interactionFetch, executionFetch: fakeFetch([say('x')]) });
  const plain = createPlainBackend({ fetchImpl: fakeFetch([say('x')]).fetchImpl });

  const result = await runForeground({
    interaction,
    plain,
    ctx: {
      system: '你是小桌',
      messages: buildChatMessages({ history: [], userText: '你好', layer: LAYER.INTERACTION }),
      config: CONFIG,
      turn: { history: [], userText: '你好', config: CONFIG },
    },
  });

  assert.equal(result.steps, 1, '模型回了一句话，就是一轮');
});

test('前台这一轮的轮数：派单也算一轮', async () => {
  const interactionFetch = fakeFetch([
    toolCall('task.submit', { title: '查视频', brief: '看看' }),
    say('我去看看。'),
  ]);
  const { interaction } = wire({ interactionFetch, executionFetch: fakeFetch([say('查完了。')]) });
  const plain = createPlainBackend({ fetchImpl: fakeFetch([say('x')]).fetchImpl });

  const result = await runForeground({
    interaction,
    plain,
    ctx: {
      system: '你是小桌',
      messages: buildChatMessages({ history: [], userText: 'F 盘 video 下有什么', layer: LAYER.INTERACTION }),
      config: CONFIG,
      turn: { history: [], userText: 'F 盘 video 下有什么', config: CONFIG },
    },
  });

  assert.equal(result.text, '我去看看。');
  assert.equal(result.steps, 2, '派单那一轮 + 答复那一轮 = 两轮');
});

test('退回普通对话：也算一轮——模型确实被调了一次', async () => {
  const plain = createPlainBackend({ fetchImpl: fakeFetch([say('你好呀。')]).fetchImpl });
  const interaction = {
    async chat() {
      throw new LlmError(FALLBACK_NOTICE, {
        code: LLM_ERRORS.BAD_REQUEST,
        status: 400,
        body: 'tools is not supported',
      });
    },
  };

  const result = await runForeground({
    interaction,
    plain,
    ctx: { system: '你是小桌', messages: [{ role: 'user', content: '你好' }], config: CONFIG },
  });

  // 这一轮模型没有正文，不会产生 model 记录——数条数会算成 0。
  assert.equal(result.steps, 1, '退回普通对话也算一轮');
});

test('退回普通对话时说的那句话：不是空的，而且提到「工具」', () => {
  // 这句话是规格 §10.4 的落点（「用户被告知」）。
  // 它被改坏（变空串 / 不再提工具）时，这条用例要红。
  assert.ok(FALLBACK_NOTICE, '退回时要有一句话告诉用户');
  assert.match(FALLBACK_NOTICE, /工具/, '这句话要说明是工具调用不被支持');
});

test('别的错误不退回：还是把错误抛出去', async () => {
  const plainFetch = fakeFetch([say('你好呀。')]);
  const plain = createPlainBackend({ fetchImpl: plainFetch.fetchImpl });

  const interaction = {
    async chat() {
      throw new LlmError('接口超时了', { code: LLM_ERRORS.TIMEOUT, status: 504, body: '' });
    },
  };

  await assert.rejects(
    () =>
      runForeground({
        interaction,
        plain,
        ctx: { system: '你是小桌', messages: [{ role: 'user', content: '你好' }], config: CONFIG },
      }),
    /接口超时了/,
    '不是「模型不支持工具」的错误就别退回'
  );
});

test('任务被取消：不弹「这件事没做成」', async () => {
  // 执行层的接口**永远不回来**：任务会一直跑着，直到被取消。
  // （这是唯一能确定「任务还在跑」的办法——真接口可能秒回。）
  const executionFetch = {
    calls: [],
    fetchImpl: async (url, options) => {
      executionFetch.calls.push({ url, body: JSON.parse(options.body) });
      return new Promise(() => {});
    },
  };
  const interactionFetch = fakeFetch([
    toolCall('task.submit', { title: '查视频', brief: '看看' }),
    say('我去看看。'),
  ]);
  const { interaction, tasks, records, notices } = wire({ interactionFetch, executionFetch });

  await interaction.chat({
    messages: buildChatMessages({ history: [], userText: 'F 盘 video 下有什么', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: 'F 盘 video 下有什么', config: CONFIG },
  });

  const dispatch = records.find((r) => r.kind === 'dispatch');
  assert.ok(dispatch?.meta.taskId, '派单记录要带任务号');

  const res = tasks.cancel(dispatch.meta.taskId);
  assert.equal(res.ok, true, '取消要成功');

  // 取消是异步收尾的：等它走完。
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notices.length, 0, `取消的任务不该弹通知：${JSON.stringify(notices)}`);
});
