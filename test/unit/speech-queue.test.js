// 语音排队的单元测试。
//
// 排队是为了解决「两次回复的语音叠在一起」：
// 前台那段回复还没念完，后台那件事做完又报一句，两句话糊在一块儿。
//
// 这里盯三件事：
//   1. 后来的一段**等**前面那段结束才开始；
//   2. 顺序不变（先来的先说）；
//   3. 前面那段失败不挡后面那段。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSpeechQueue } from '../../src/renderer/pet/speechQueue.js';

/** 造一个「播一段语音」的动作：记下起止时刻。 */
function speaker(log, name, ms = 10, { fail = false } = {}) {
  return async () => {
    log.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}:end`);
    if (fail) throw new Error(`${name} 播不出来`);
  };
}

test('后来的一段等前面那段播完才开始', async () => {
  const queue = createSpeechQueue();
  const log = [];

  const first = queue.run(speaker(log, 'a', 20));
  const second = queue.run(speaker(log, 'b', 10));

  await Promise.all([first, second]);

  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('排队时返回的 promise 在这一段真的播完之后才兑现', async () => {
  const queue = createSpeechQueue();
  let ended = false;

  const played = queue.run(async () => {
    await new Promise((r) => setTimeout(r, 30));
    ended = true;
  });

  await Promise.resolve();
  assert.equal(ended, false, '这一段还没播完就兑现了');
  await played;
  assert.equal(ended, true);
});

test('前面那段失败不挡后面那段', async () => {
  const queue = createSpeechQueue();
  const log = [];

  const first = queue.run(speaker(log, 'a', 5, { fail: true }));
  const second = queue.run(speaker(log, 'b', 5));

  await assert.rejects(first, /播不出来/);
  await second;

  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('后面排着的语音不会因为前面失败而被丢掉', async () => {
  const queue = createSpeechQueue();
  const log = [];

  const first = queue.run(speaker(log, 'a', 5, { fail: true }));
  const second = queue.run(speaker(log, 'b', 5));

  await assert.rejects(first);
  await second;

  assert.ok(log.includes('b:start'), '后面那段没有播');
});
