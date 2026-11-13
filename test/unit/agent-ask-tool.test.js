import test from 'node:test';
import assert from 'node:assert/strict';

import { createAskTools, MAX_ASK_OPTIONS } from '../../src/main/assistant/agent/tools/ask.js';

/**
 * 「问用户」这个工具。
 *
 * 盯的是三件事：
 * - 用户选的那个选项**原样**回到模型手里（模型才知道该往哪走）；
 * - 没有选项就问不成（用户没法回答一个没法回答的问题）；
 * - 任务被取消时不能干等着——要给出「没人回答」。
 */

/** 造出这个工具（只有一个）。 */
function tool(ask) {
  const list = createAskTools({ ask });
  assert.equal(list.length, 1);
  return list[0];
}

test('问用户：用户选的那个选项回到模型手里', async () => {
  const t = tool(async ({ question, options }) => {
    assert.equal(question, '你要看面板还是放歌？');
    assert.deepEqual(options, ['看面板', '放歌']);
    return '放歌';
  });
  const out = await t.run(
    { question: '你要看面板还是放歌？', options: ['看面板', '放歌'] },
    { taskId: 't1' }
  );
  assert.match(out.text, /放歌/);
  assert.equal(out.data.choice, '放歌');
  assert.equal(out.data.answered, true);
});

test('问用户：风险是只读（它不动用户的东西）', () => {
  assert.equal(tool(async () => 'x').risk, 'read');
});

test('问用户：没给选项就问不成', async () => {
  const t = tool(async () => 'x');
  await assert.rejects(
    () => t.run({ question: '你要哪个？' }, {}),
    /选项/
  );
});

test('问用户：选项是空的（只有空串）也算没给', async () => {
  const t = tool(async () => 'x');
  await assert.rejects(
    () => t.run({ question: '你要哪个？', options: ['  ', ''] }, {}),
    /选项/
  );
});

test('问用户：没有问的渠道就明确说做不了', async () => {
  const t = createAskTools({})[0];
  await assert.rejects(
    () => t.run({ question: '你要哪个？', options: ['甲'] }, {}),
    /没法问用户/
  );
});

test('问用户：任务被取消了就说没人回答，不许当成用户选了什么', async () => {
  const controller = new AbortController();
  const t = tool(() => new Promise(() => {}));
  const pending = t.run({ question: '你要哪个？', options: ['甲'] }, { signal: controller.signal });
  controller.abort();
  const out = await pending;
  assert.equal(out.data.answered, false);
  assert.match(out.text, /没有回答/);
});

test('问用户：等答复的时候让出并发槽，答完再拿回来', async () => {
  const events = [];
  const hooks = {
    wait: async () => {
      events.push('wait');
    },
    wake: () => {
      events.push('wake');
    },
  };
  let release = null;
  const t = tool(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = t.run({ question: '你要哪个？', options: ['甲'] }, { hooks });
  // 等挂起发生之后才放答案。
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ['wait']);
  release('甲');
  const out = await pending;
  assert.equal(out.data.choice, '甲');
  assert.deepEqual(events, ['wait', 'wake']);
});

test('问用户：选项太多时只留前几个', async () => {
  const many = Array.from({ length: MAX_ASK_OPTIONS + 3 }, (_, i) => `选项${i}`);
  let seen = null;
  const t = tool(async ({ options }) => {
    seen = options;
    return options[0];
  });
  await t.run({ question: '你要哪个？', options: many }, {});
  assert.equal(seen.length, MAX_ASK_OPTIONS);
});
