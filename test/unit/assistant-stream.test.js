// 回复气泡的单元测试。
//
// 这个模块的价值全在**时序**上：
//   1. 气泡还没开的时候正文要攒着（不能先冒半句再冒另一半）；
//   2. 攒够了再一次性倒出去；
//   3. 定稿要走 endStream（不然气泡不会自动消失）；
//   4. 出错或被取代时要收干净。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplyBubble } from '../../src/main/assistant/chat/stream.js';

/** 造一个只记录调用的假气泡。 */
function fakeBubble() {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    openStream(opts) {
      const id = nextId++;
      calls.push(['openStream', id, opts]);
      return id;
    },
    appendStream(id, delta) {
      calls.push(['appendStream', id, delta]);
    },
    endStream(id, opts) {
      calls.push(['endStream', id, opts]);
    },
    cancelStream(opts) {
      calls.push(['cancelStream', opts]);
    },
  };
}

test('回复气泡：没开之前先攒着，开了再一次性倒出去', () => {
  const bubble = fakeBubble();
  const reply = createReplyBubble({ bubble });

  reply.push('你好');
  reply.push('，世界');
  assert.deepEqual(bubble.calls, [], '还没开就把正文吐出去了');

  reply.open();
  assert.equal(reply.isOpen, true);
  assert.deepEqual(bubble.calls, [
    ['openStream', 1, { kind: 'chat' }],
    ['appendStream', 1, '你好，世界'],
  ]);
});

test('回复气泡：开了之后正文直接追加', () => {
  const bubble = fakeBubble();
  const reply = createReplyBubble({ bubble });

  reply.open();
  reply.push('后面');
  assert.deepEqual(bubble.calls, [
    ['openStream', 1, { kind: 'chat' }],
    ['appendStream', 1, '后面'],
  ]);
});

test('回复气泡：重复 open 不会开第二个流', () => {
  const bubble = fakeBubble();
  const reply = createReplyBubble({ bubble });

  reply.open();
  reply.open();
  assert.equal(bubble.calls.filter(([name]) => name === 'openStream').length, 1);
});

test('回复气泡：定稿把最终正文交给 endStream', () => {
  const bubble = fakeBubble();
  const reply = createReplyBubble({ bubble });

  reply.push('半句');
  reply.open();
  reply.finish({ text: '完整答案', emotion: 'happy' });

  const last = bubble.calls.at(-1);
  assert.equal(last[0], 'endStream');
  assert.deepEqual(last[2], { text: '完整答案', emotion: 'happy' });
});

test('回复气泡：没开就定稿等于没发生（不会凭空开一个空气泡）', () => {
  const bubble = fakeBubble();
  const reply = createReplyBubble({ bubble });

  reply.finish({ text: '答案' });
  assert.deepEqual(bubble.calls, []);
});

test('回复气泡：作废时收掉流，攒着的正文也不倒出去', () => {
  const bubble = fakeBubble();
  const reply = createReplyBubble({ bubble });

  reply.push('不要了');
  reply.cancel();
  assert.equal(reply.isOpen, false);

  // 作废之后再 open：旧的正文不该被倒出去。
  reply.open();
  assert.equal(bubble.calls.filter(([name]) => name === 'appendStream').length, 0);
});

test('回复气泡：作废时把已经开着的流收掉', () => {
  const bubble = fakeBubble();
  const reply = createReplyBubble({ bubble });

  reply.open();
  reply.cancel();

  assert.equal(reply.isOpen, false);
  assert.ok(bubble.calls.some(([name]) => name === 'cancelStream'));
});
