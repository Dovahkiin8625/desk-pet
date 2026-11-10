import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentLoop } from '../../src/main/assistant/agent/loop.js';
import { createAgentTasks } from '../../src/main/assistant/agent/tasks.js';

/**
 * steer：给跑着的任务追加一句（规格 §5.2）。
 *
 * 三条最容易做错的：
 * 1. **注入点是步骤边界**：正在执行的工具调用不被打断，
 *    追加的要求在**下一步**开头才进上下文；
 * 2. **取走即清空**：一条指令只读一次——留在队列里的会被再读一遍，
 *    模型会当成新要求重复执行；
 * 3. **取消后队列作废**：取消是明确的用户意图，
 *    留着它们只会在任务万一复活时冒出来。
 */

/** 造一个假工具：每调一次就记一笔。 */
function fakeTool(log) {
  return {
    name: 'fs.list',
    label: '列目录',
    description: '列目录',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => {
      log.push('tool');
      return { text: 'a.txt' };
    },
  };
}

/** 造一句「调工具」的模型回答。 */
function toolCall(name = 'fs.list') {
  return {
    text: '',
    toolCalls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: '{}' } }],
  };
}

test('steer：追加的要求在下一个步骤边界进上下文', async () => {
  const log = [];
  const seen = [];
  const pending = [];

  const loop = createAgentLoop({
    callModel: async ({ messages }) => {
      // 每一步看到的上下文都记下来。
      seen.push(messages.map((m) => String(m.content || '')).join('\n'));
      // **在假模型里追加**：整个循环都在微任务队列里跑完，
      // 用 setTimeout 追加的话，定时器要等循环结束才触发——
      // 那句要求永远进不了上下文，测试就成了假绿。
      // 第一步调工具，之后给答复。
      if (seen.length === 1) {
        pending.push('顺便看看 D 盘');
        return toolCall();
      }
      return { text: '好了' };
    },
    resolveTool: () => fakeTool(log),
    // 队列取走即清空。
    steer: () => pending.splice(0),
  });

  const result = await loop.run({
    system: 's',
    messages: [{ role: 'user', content: '查视频' }],
  });

  assert.equal(result.text, '好了');
  // 第一步的上下文里没有那句追加（它还没到）。
  assert.ok(!seen[0].includes('顺便看看 D 盘'), '追加的要求不该出现在第一步');
  // 第二步看得到。
  assert.ok(
    seen[1]?.includes('顺便看看 D 盘'),
    `追加的要求没有进上下文：\n${seen[1]}`
  );
});

test('steer：一条指令只注入一次', async () => {
  const seen = [];
  const pending = ['顺便看看 D 盘'];
  const loop = createAgentLoop({
    callModel: async ({ messages }) => {
      seen.push(messages.map((m) => String(m.content || '')).join('\n'));
      if (seen.length < 3) return toolCall();
      return { text: '好了' };
    },
    resolveTool: () => fakeTool([]),
    steer: () => pending.splice(0),
  });
  await loop.run({ system: 's', messages: [{ role: 'user', content: '查视频' }] });
  // **只看最后一步的上下文**：每一步看到的都是整段对话，
  // 注入过一次的句子在后面的每一步里都会出现——
  // 数「出现过几步」数出来的不是注入次数。
  const last = seen[seen.length - 1];
  const count = last.split('顺便看看 D 盘').length - 1;
  assert.equal(count, 1, `追加的要求被注入了 ${count} 次`);
});

test('steer：正在执行的工具调用不被中途打断', async () => {
  const order = [];
  let release = null;
  const pending = [];

  const loop = createAgentLoop({
    callModel: async ({ messages }) => {
      // 第二步起给答复，循环才会结束。
      if (messages.some((m) => String(m.content || '').includes('顺便看看 D 盘'))) {
        return { text: '好了' };
      }
      return toolCall();
    },
    resolveTool: () => ({
      name: 'fs.list',
      label: '列目录',
      description: '列目录',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      run: async () => {
        order.push('tool-start');
        // **只有第一次调用会卡住**：之后放行，
        // 不然循环里的每次调用都在等一个再也不会来的 resolve。
        if (!release) {
          await new Promise((r) => {
            release = r;
          });
        }
        order.push('tool-end');
        return { text: 'a.txt' };
      },
    }),
    steer: () => pending.splice(0),
  });

  const running = loop.run({ system: 's', messages: [{ role: 'user', content: '查视频' }] });
  // 工具跑起来了，这时候追加一条要求。
  while (!release) await new Promise((r) => setTimeout(r, 0));
  pending.push('顺便看看 D 盘');
  release();
  await running;

  // 工具完整跑完了（没有中途被要求打断）。
  assert.deepEqual(order, ['tool-start', 'tool-end']);
});

test('steer：任务被取消后队列作废', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let notes = null;
  const tasks = createAgentTasks({
    backend: {
      id: 'fake',
      async chat(ctx) {
        // 等闸门：这段时间里任务还在跑。
        await gate;
        notes = ctx.steer ? ctx.steer() : [];
        return { text: '好了' };
      },
    },
  });

  const task = tasks.submit({ prompt: '查视频', messages: [] });
  await new Promise((r) => setTimeout(r, 0));

  const res = tasks.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, true);

  tasks.cancel(task.taskId);
  release();

  await task.done.catch(() => {});
  // 取消之后队列空了：那条追加的要求作废了。
  assert.deepEqual(notes, [], '取消后队列里还留着要求');
});

test('steer：任务已经结束的，追加的要求丢弃且不报错', async () => {
  const tasks = createAgentTasks({
    backend: { id: 'fake', async chat() { return { text: '好了' }; } },
  });
  const task = tasks.submit({ prompt: '查视频', messages: [] });
  await task.done;
  const res = tasks.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, true);
  assert.equal(res.dropped, true);
});
