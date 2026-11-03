import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT,
  MOOD_RANGE,
  applyEvent,
  boredomLevel,
  clampMood,
  createEmotionState,
  decayMood,
  expressionNameFor,
  touch,
} from '../../src/renderer/pet/emotion.js';

/** 一份「映射齐全」的清单：语义键 → 模型自己的表情名。 */
const MANIFEST = {
  expressions: {
    normal: 'F01',
    happy: 'F05',
    smile: 'F08',
    shy: 'F07',
    angry: 'F02',
    surprised: 'F06',
    sad: 'F03',
    tired: 'F04',
  },
};

test('初始状态是中性心情', () => {
  const s = createEmotionState(1000);
  assert.equal(s.mood, 0);
  assert.equal(s.emotion, 'neutral');
});

test('摸头让心情变好，情绪变开心', () => {
  const s = applyEvent(createEmotionState(), EVENT.TAP_HEAD);
  assert.equal(s.mood, 12);
  assert.equal(s.emotion, 'happy');
});

test('点击身体也涨心情，但涨得少', () => {
  const s = applyEvent(createEmotionState(), EVENT.TAP_BODY);
  assert.ok(s.mood > 0);
  assert.ok(s.mood < applyEvent(createEmotionState(), EVENT.TAP_HEAD).mood);
});

test('被拖拽时心情变差、脸是惊讶', () => {
  const s = applyEvent(createEmotionState(), EVENT.DRAG_START);
  assert.ok(s.mood < 0);
  assert.equal(s.emotion, 'surprised');
});

test('连续猛点会生气', () => {
  const s = applyEvent(createEmotionState(), EVENT.SPAM);
  assert.equal(s.emotion, 'angry');
  assert.ok(s.mood < 0);
});

test('心情值被夹在区间内', () => {
  assert.equal(clampMood(999), MOOD_RANGE.max);
  assert.equal(clampMood(-999), MOOD_RANGE.min);
  assert.equal(clampMood(NaN), 0);
  assert.equal(clampMood('abc'), 0);
  // 连续叠加也不会越界
  let s = createEmotionState();
  for (let i = 0; i < 50; i += 1) s = applyEvent(s, EVENT.PRAISE);
  assert.equal(s.mood, MOOD_RANGE.max);
});

test('applyEvent 不修改传入的状态', () => {
  const before = createEmotionState();
  const snapshot = { ...before };
  applyEvent(before, EVENT.TAP_HEAD);
  assert.deepEqual(before, snapshot);
});

test('未知的事件原样返回，不抛错', () => {
  const before = createEmotionState();
  const after = applyEvent(before, 'no-such-event');
  assert.deepEqual(after, before);
});

test('心情随时间回落，但只朝 0 回落', () => {
  // 正心情会掉到 0 就停，不会掉成负数
  assert.equal(decayMood(10, 10 * 60000), 0);
  assert.equal(decayMood(-10, 10 * 60000), 0);
  // 一分钟掉 6 点
  assert.equal(decayMood(60, 60000), 54);
  // 时间倒流或非法输入时不改
  assert.equal(decayMood(60, -1000), 60);
  assert.equal(decayMood(60, NaN), 60);
});

test('长时间没互动会先难过、再困倦', () => {
  const s = touch(createEmotionState(0), 0);
  // 刚 interacted 完：不难过也不困
  assert.equal(boredomLevel(s, 1000), null);
  // 过了 1 分钟：难过
  assert.equal(boredomLevel(s, 61 * 1000), EVENT.IDLE_LONG);
  // 过了 3 分钟：困倦（优先级更高，不返回难过）
  assert.equal(boredomLevel(s, 181 * 1000), EVENT.TIMEOUT);
});

test('情绪 → 表情名按清单解析，没映射就返回 null', () => {
  assert.equal(expressionNameFor(MANIFEST, 'happy'), 'F05');
  assert.equal(expressionNameFor(MANIFEST, 'tired'), 'F04');
  assert.equal(expressionNameFor(MANIFEST, 'neutral'), 'F01');
  // 清单里没有 tired：返回 null，交给上层「只播动作」
  const noTired = { expressions: { normal: 'Normal', happy: 'Smile' } };
  assert.equal(expressionNameFor(noTired, 'tired'), null);
  // 完全不认识的情绪
  assert.equal(expressionNameFor(MANIFEST, 'confused'), null);
});
