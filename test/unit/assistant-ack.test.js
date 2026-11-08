// 「先应一声」的单元测试。
//
// 这个功能的价值全在**时机**上：应答早了是打扰，应答晚了是白搭。
// 所以这里盯住三件事：
//   1. 到点没人说话 → 应一声；
//   2. 正文先到了 → 不应（打扰用户）；
//   3. 应答念完 → 才放行答案（用户要的是「先应一声，答完再给结果」）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAck, pickAckLine, ACK_LINES } from '../../src/main/assistant/chat/ack.js';

/** 等一小会儿（让计时器有机会到点）。 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('应答：到点了还没正文，就应一声', async () => {
  const spoken = [];
  const ack = createAck({ delayMs: 5, speak: async (line) => spoken.push(line) });
  ack.arm();
  await ack.whenReady();
  assert.equal(spoken.length, 1, '没有应答');
  assert.ok(ACK_LINES.includes(spoken[0]), '应答不在短句池里');
});

test('应答：正文先到了就不应——打扰用户比慢更要紧', async () => {
  const spoken = [];
  const ack = createAck({ delayMs: 20, speak: async (line) => spoken.push(line) });
  ack.arm();
  ack.noteText();
  await ack.whenReady();
  await wait(30);
  assert.equal(spoken.length, 0, '模型答得快还多嘴了');
});

test('应答：念完才放行答案', async () => {
  let release = null;
  const ack = createAck({
    delayMs: 5,
    speak: () => new Promise((resolve) => {
      release = resolve;
    }),
  });
  ack.arm();
  await wait(20);
  assert.equal(ack.fired, true, '应答没有发出');

  let ready = false;
  void ack.whenReady().then(() => {
    ready = true;
  });
  await wait(10);
  assert.equal(ready, false, '还在念的时候就把答案放出来了');

  release();
  await ack.whenReady();
  assert.equal(ready, true);
});

test('应答：语音永远不结束也不能把答案卡住', async () => {
  const ack = createAck({
    delayMs: 5,
    maxWaitMs: 30,
    speak: () => new Promise(() => {}),
  });
  ack.arm();
  await ack.whenReady();
  assert.equal(ack.fired, true);
});

test('应答：这一轮被取代了就立刻放行', async () => {
  const spoken = [];
  const ack = createAck({ delayMs: 5, speak: async (line) => spoken.push(line) });
  ack.arm();
  ack.cancel();
  await ack.whenReady();
  await wait(20);
  assert.equal(spoken.length, 0, '被取代的这一轮不该再出声');
});

test('应答：随机挑一句，但永远在短句池里', () => {
  assert.equal(pickAckLine(() => 0), ACK_LINES[0]);
  assert.equal(pickAckLine(() => 0.999999), ACK_LINES[ACK_LINES.length - 1]);
  // 随机数给得离谱时也不能越界。
  assert.ok(ACK_LINES.includes(pickAckLine(() => 5)));
  assert.ok(ACK_LINES.includes(pickAckLine(() => -1)));
});

test('应答：没上计时器（主动搭话）时，正文到了也得放行', async () => {
  const spoken = [];
  const ack = createAck({ delayMs: 5, speak: async (line) => spoken.push(line) });
  // **不 arm()**：主动搭话那一轮不该应答，但答案也不能卡住。
  ack.noteText();
  await ack.whenReady();
  assert.equal(spoken.length, 0, '没上计时器却应了一声');
});

test('应答：答案好了但还没轮到应答：直接放行', async () => {
  const spoken = [];
  const ack = createAck({ delayMs: 1000, speak: async (line) => spoken.push(line) });
  ack.arm();
  ack.release();
  await ack.whenReady();
  await wait(30);
  assert.equal(spoken.length, 0, '都放行了还去应一声');
});

test('应答：已经应答了就不放行——那一声得念完', async () => {
  let release = null;
  const ack = createAck({
    delayMs: 5,
    speak: () => new Promise((resolve) => {
      release = resolve;
    }),
  });
  ack.arm();
  await wait(20);
  assert.equal(ack.fired, true);

  let ready = false;
  void ack.whenReady().then(() => {
    ready = true;
  });
  ack.release();
  await wait(10);
  assert.equal(ready, false, '应答还在念就把答案放出来了');

  release();
  await ack.whenReady();
  assert.equal(ready, true);
});
