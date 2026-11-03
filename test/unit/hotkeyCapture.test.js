import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHotkeyCapture } from '../../src/main/hotkeyCapture.js';

/**
 * 快捷键录制的按键捕获。
 *
 * 这段接线是「全局快捷键」唯一的按键入口（before-input-event），
 * 而它在浏览器里按不出来——Playwright 的合成按键不经过 webContents
 * 的 before-input-event。所以这里直接调处理器，把「主进程真的把
 * payload 交过去了」这件事钉住。
 */

/** 造一个事件替身：只记 preventDefault 有没有被调。 */
function fakeEvent() {
  const calls = [];
  return {
    calls,
    preventDefault: () => calls.push('preventDefault'),
  };
}

/** 造一个控制器替身：录制的开关与收到的按键。 */
function fakeController({ recording = true } = {}) {
  const received = [];
  return {
    received,
    isRecording: () => recording,
    handleInput: (input) => received.push(input),
  };
}

test('录制中：拦下这次按键，并把 payload 交给控制器', () => {
  const controller = fakeController();
  const capture = makeHotkeyCapture(controller);
  const event = fakeEvent();
  const input = { key: 'k', control: true, alt: true, shift: false, meta: false };

  capture(event, input);

  // 必须拦：不然那一次按键会漏进页面的输入框（规格 §4.3②）。
  assert.deepEqual(event.calls, ['preventDefault']);
  // 必须交过去：录制的按键只有这一条路能进来。
  assert.equal(controller.received.length, 1);
  assert.equal(controller.received[0], input, '交过去的必须是同一个 input');
});

test('没在录制：不拦按键，也不碰控制器', () => {
  // 设置窗口里别的输入框还要正常打字——
  // 没在录制时一律放行。
  const controller = fakeController({ recording: false });
  const capture = makeHotkeyCapture(controller);
  const event = fakeEvent();

  capture(event, { key: 'a' });

  assert.deepEqual(event.calls, []);
  assert.deepEqual(controller.received, []);
});

test('控制器不存在时不报错', () => {
  const capture = makeHotkeyCapture(undefined);
  const event = fakeEvent();
  assert.doesNotThrow(() => capture(event, { key: 'a' }));
  assert.deepEqual(event.calls, []);
});
