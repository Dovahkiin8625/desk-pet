import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeSignals } from '../../src/main/assistant/llm/openai.js';

/**
 * 取消信号与超时信号必须**合成一个**。
 *
 * 只留取消信号：一个挂死的请求会永远挂着；
 * 只留超时信号：用户点了取消也没用（超时是 120 秒，太久）。
 */

test('没有取消信号时：给一个会自己超时的信号', async () => {
  const signal = mergeSignals(null, 30);
  assert.equal(signal.aborted, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(signal.aborted, true, '超时没有生效');
});

test('取消信号已经取消时：合成出来的信号立刻就是取消的', () => {
  const controller = new AbortController();
  controller.abort();
  const signal = mergeSignals(controller.signal, 5000);
  assert.equal(signal.aborted, true);
});

test('取消信号触发时：合成出来的信号也跟着取消', () => {
  const controller = new AbortController();
  const signal = mergeSignals(controller.signal, 5000);
  assert.equal(signal.aborted, false);
  controller.abort();
  assert.equal(signal.aborted, true, '取消没有传下去');
});
