import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDoubleTapDetector,
  inDoubleTapWindow,
  DOUBLE_TAP_INTERVAL_MS,
  DOUBLE_TAP_DISTANCE_PX,
} from '../../src/renderer/pet/doubleTap.js';

/**
 * 双击判定。
 *
 * 桌宠的单击是摸头，**双击**才弹输入框（插件面板）。
 * 判错的后果都不小：
 * - 把两次单独的点击当成双击 → 用户想摸头却弹了搜索框；
 * - 把双击当成两次点击 → 输入框永远弹不出来。
 */
test('第一下不是双击', () => {
  const detector = createDoubleTapDetector();
  assert.equal(detector.isDoubleTap(100, 100, 1000), false);
});

test('挨得近的两下是双击', () => {
  const detector = createDoubleTapDetector();
  detector.isDoubleTap(100, 100, 1000);
  assert.equal(detector.isDoubleTap(104, 103, 1200), true);
});

test('隔太久的两下不是双击', () => {
  const detector = createDoubleTapDetector();
  detector.isDoubleTap(100, 100, 1000);
  assert.equal(
    detector.isDoubleTap(100, 100, 1000 + DOUBLE_TAP_INTERVAL_MS + 1),
    false,
    '超过间隔就不是双击了'
  );
});

test('离得太远的两下不是双击', () => {
  const detector = createDoubleTapDetector();
  detector.isDoubleTap(100, 100, 1000);
  assert.equal(
    detector.isDoubleTap(100 + DOUBLE_TAP_DISTANCE_PX + 1, 100, 1100),
    false,
    '点在两个地方不算双击'
  );
});

test('成对之后清零：第三下不算又一次双击', () => {
  const detector = createDoubleTapDetector();
  detector.isDoubleTap(100, 100, 1000);
  assert.equal(detector.isDoubleTap(100, 100, 1100), true, '第二下是双击');
  // 连点三下：第三下要是又被当成双击，摸头的手感就全乱了。
  assert.equal(detector.isDoubleTap(100, 100, 1200), false, '第三下从头算');
});

test('reset 之后上一记不算数', () => {
  const detector = createDoubleTapDetector();
  detector.isDoubleTap(100, 100, 1000);
  detector.reset();
  assert.equal(detector.isDoubleTap(100, 100, 1100), false);
});

test('间隔与距离都可以调', () => {
  const detector = createDoubleTapDetector({ intervalMs: 100, distance: 5 });
  detector.isDoubleTap(100, 100, 1000);
  assert.equal(detector.isDoubleTap(103, 102, 1050), true, '100ms 内、5px 内算双击');
  assert.equal(detector.isDoubleTap(103, 102, 1200), false, '超过 100ms 不算');
});

/**
 * 「刚点过」的宽限期。
 *
 * 桌宠窗口在透明处不吃鼠标事件，而摸头之后头会动——
 * 刚才点的像素可能已经不是形象了。宽限期就是给双击的第二下留的：
 * 这段时间里窗口保持可点。
 */
test('刚点过：宽限期内算「刚点过」', () => {
  assert.equal(inDoubleTapWindow(1000, 1000), true, '刚点的那一下也算');
  assert.equal(inDoubleTapWindow(1000, 1000 + DOUBLE_TAP_INTERVAL_MS - 1), true, '宽限期之内');
});

test('刚点过：过了宽限期就不算', () => {
  assert.equal(
    inDoubleTapWindow(1000, 1000 + DOUBLE_TAP_INTERVAL_MS),
    false,
    '宽限期一过就恢复穿透'
  );
});

test('刚点过：从来没点过就不算', () => {
  assert.equal(inDoubleTapWindow(0, 1000), false, '没点过就没有宽限期');
});
