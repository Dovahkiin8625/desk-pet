import test from 'node:test';
import assert from 'node:assert/strict';

import { createTapVoiceGate } from '../../src/renderer/pet/tapVoiceGate.js';
import { DOUBLE_TAP_INTERVAL_MS } from '../../src/renderer/pet/doubleTap.js';
import { decideTapVoice } from '../../src/shared/tapVoice.js';

/** 假时钟：自己管「到了哪一刻」，让用例不用真的等。 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimer(handle) {
      timers.delete(handle);
    },
    /** 往前推 ms 毫秒，把到点的定时器都跑掉。 */
    advance(ms) {
      now += ms;
      for (const [handle, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(handle);
          t.fn();
        }
      }
    },
  };
}

/**
 * 台词的闸门。
 *
 * 双击桌宠是「打开输入框」，不该顺带念一句「摸摸头」。
 * 但第一下落下时还不知道后面有没有第二下——所以台词要押后一个
 * 双击窗口，窗口内没有第二下才真的念。
 */
test('押后：到了时间才念', () => {
  const clock = fakeClock();
  const gate = createTapVoiceGate({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  const said = [];
  gate.schedule(() => said.push('你好呀'));
  clock.advance(100);
  assert.deepEqual(said, [], '还没到时间，不该念');

  clock.advance(1000);
  assert.deepEqual(said, ['你好呀']);
});

test('作废：双击来了就不念', () => {
  const clock = fakeClock();
  const gate = createTapVoiceGate({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  const said = [];
  gate.schedule(() => said.push('你好呀'));
  clock.advance(100);
  gate.cancel();
  clock.advance(1000);
  assert.deepEqual(said, [], '双击的时候不该念台词');
});

test('再押一次：旧的作废，只念后来的那一句', () => {
  const clock = fakeClock();
  const gate = createTapVoiceGate({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  const said = [];
  gate.schedule(() => said.push('第一句'));
  clock.advance(100);
  gate.schedule(() => said.push('第二句'));
  clock.advance(1000);
  assert.deepEqual(said, ['第二句'], '一次点击只念一句');
});

test('没押着的时候作废不会出事', () => {
  const gate = createTapVoiceGate();
  gate.cancel();
  assert.equal(gate.pendingSince(), null);
});

test('pendingSince：押着的时候是点的时刻，念完/作废后是 null', () => {
  const clock = fakeClock();
  const gate = createTapVoiceGate({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  gate.schedule(() => {});
  assert.equal(gate.pendingSince(), 0);
  clock.advance(1000);
  assert.equal(gate.pendingSince(), null);

  gate.schedule(() => {});
  gate.cancel();
  assert.equal(gate.pendingSince(), null);
});

test('押后得比双击窗口长：边界上的那一下不能先跑', () => {
  const clock = fakeClock();
  const gate = createTapVoiceGate({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  gate.schedule(() => {});
  // 双击判定到 500ms 那一刻才截止（见 doubleTap.js）：
  // 闸门必须还在押着，等着接住那一下。
  clock.advance(DOUBLE_TAP_INTERVAL_MS);
  assert.notEqual(gate.pendingSince(), null, '双击窗口没关，闸门不能先放行');
});

/**
 * 冷却。
 *
 * 押着的那句马上就要念出来了——冷却要把它算进去，
 * 不然连点两下会排两句，叠在一起听不清。
 */
test('押着的那句算「刚念过」：连点两下不会排两句', () => {
  const clock = fakeClock();
  const gate = createTapVoiceGate({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  let lastVoiceAt = null;
  const decide = () =>
    decideTapVoice({
      voiceEnabled: true,
      modelSound: false,
      lineCount: 1,
      cooldownMs: 3000,
      now: clock.now(),
      lastVoiceAt: gate.pendingSince() ?? lastVoiceAt,
    });

  gate.schedule(() => {
    lastVoiceAt = clock.now();
  });
  assert.equal(decide(), 'none', '冷却期内不该再排一句');

  // 念完了，冷却照样管着（3 秒内不再念）。
  clock.advance(1000);
  assert.equal(decide(), 'none', '念完也在冷却期内');
  clock.advance(3000);
  assert.equal(decide(), 'voice', '冷却过了才轮到下一句');
});
