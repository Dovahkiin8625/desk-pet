import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setMasterVolume,
  getMasterVolume,
  getSpeechOutput,
} from '../../src/renderer/pet/audio.js';

/**
 * 渲染层的总音量。
 *
 * 这里的夹紧是 `src/main/assistant/state.js` 里 `clampNumber` 的**第二份实现**：
 * 两侧行为一致只靠约定，所以这一侧也得被测试钉住。
 */
test('总音量被夹进 [0,1]，非数值回退 0.8', () => {
  assert.equal(setMasterVolume(0.5), 0.5);
  assert.equal(getMasterVolume(), 0.5);
  assert.equal(setMasterVolume(5), 1);
  assert.equal(setMasterVolume(-1), 0);
  assert.equal(setMasterVolume('x'), 0.8);
  assert.equal(setMasterVolume(undefined), 0.8);
});

test('还没播过语音时，输出节点是 null', () => {
  assert.equal(getSpeechOutput(), null);
});
