import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentLoop } from '../../src/main/assistant/agent/loop.js';
import { TOOL_RISK } from '../../src/shared/assistant.js';

/**
 * 工具的**事件通道**（规格 §9）。
 *
 * 外部 harness 可能跑很久：工具不能占着 agent 循环等到它结束，
 * 它得能**异步地**把过程往记录里送。
 */

/** 闸门：放行（外部 harness 是 exec 级的，没闸门就不给跑）。 */
const allowGate = { request: async () => ({ decision: 'allow' }) };

/** 造一个只会调一次工具的假模型。 */
function fakeModel(toolName = 'harness.run') {
  let calls = 0;
  return {
    calls: () => calls,
    callModel: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: toolName, arguments: '{}' } }],
        };
      }
      return { text: '好了' };
    },
  };
}

test('工具能异步地往事件里塞东西', async () => {
  const events = [];
  const model = fakeModel();
  const loop = createAgentLoop({
    callModel: model.callModel,
    gate: allowGate,
    resolveTool: () => ({
      name: 'harness.run',
      risk: TOOL_RISK.EXEC,
      async run(args, ctx) {
        // **工具返回之后**才发事件——这正是 harness 的形态。
        setTimeout(() => {
          ctx.onEvent?.({ tool: 'harness.run', label: 'claude code 调了 Read', result: '文件内容' });
        }, 5);
        return { text: '已启动' };
      },
    }),
    gate: allowGate,
    onEvent: (e) => events.push(e),
  });

  const run = await loop.run({ messages: [{ role: 'user', content: '干活' }], taskId: 't1' });
  assert.equal(run.outcome, 'done');

  // 等异步事件到达。
  await new Promise((r) => setTimeout(r, 30));

  const step = events.find(
    (e) => e.type === 'step' && String(e.label || '').includes('claude code')
  );
  assert.ok(step, '异步事件没有变成 step 事件');
  assert.equal(step.result, '文件内容');
  assert.equal(step.tool, 'harness.run');
});

test('工具拿得到任务号（写日志要用）', async () => {
  const model = fakeModel();
  let seen = null;
  const loop = createAgentLoop({
    callModel: model.callModel,
    gate: allowGate,
    resolveTool: () => ({
      name: 'harness.run',
      risk: TOOL_RISK.EXEC,
      async run(args, ctx) {
        seen = ctx.taskId;
        return { text: '已启动' };
      },
    }),
  });
  await loop.run({ messages: [{ role: 'user', content: '干活' }], taskId: 'task-42' });
  assert.equal(seen, 'task-42');
});

test('没有任务号时是空串，不是 undefined', async () => {
  const model = fakeModel();
  let seen = '没拿到';
  const loop = createAgentLoop({
    callModel: model.callModel,
    gate: allowGate,
    resolveTool: () => ({
      name: 'harness.run',
      risk: TOOL_RISK.EXEC,
      async run(args, ctx) {
        seen = ctx.taskId;
        return { text: '已启动' };
      },
    }),
  });
  await loop.run({ messages: [{ role: 'user', content: '干活' }] });
  assert.equal(seen, '');
});
