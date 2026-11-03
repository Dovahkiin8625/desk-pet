import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PET_VIEWPORT,
  SCALE_RANGE,
  clampScale,
  scaledWindowSize,
  fitWindowSize,
  anchoredPosition,
} from '../../src/shared/viewport.js';

test('缩放被夹在合法区间内', () => {
  assert.equal(clampScale(1.5), 1.5);
  assert.equal(clampScale(SCALE_RANGE.max + 1), SCALE_RANGE.max);
  assert.equal(clampScale(SCALE_RANGE.min - 1), SCALE_RANGE.min);
  // 非法值回退默认值，而不是变成 NaN。
  assert.equal(clampScale(Number.NaN), 1);
  assert.equal(clampScale(undefined), 1);
  assert.equal(clampScale('1.5'), 1);
});

test('窗口尺寸按缩放等比放大', () => {
  assert.deepEqual(scaledWindowSize(1), {
    width: PET_VIEWPORT.width,
    height: PET_VIEWPORT.height,
  });
  assert.deepEqual(scaledWindowSize(2), {
    width: PET_VIEWPORT.width * 2,
    height: PET_VIEWPORT.height * 2,
  });
  assert.deepEqual(scaledWindowSize(0.5), {
    width: PET_VIEWPORT.width * 0.5,
    height: PET_VIEWPORT.height * 0.5,
  });
});

test('越界的缩放按夹紧后的值算尺寸', () => {
  assert.deepEqual(scaledWindowSize(99), scaledWindowSize(SCALE_RANGE.max));
  assert.deepEqual(scaledWindowSize(0), scaledWindowSize(SCALE_RANGE.min));
});

test('窗口尺寸被夹到显示器的可见工作区内', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  // 高度超了屏幕：夹到屏幕高度，桌宠的头才不会跑到屏幕外面去。
  assert.deepEqual(fitWindowSize(2, workArea), { width: 600, height: 1040 });
  // 屏幕够大：原样保留。
  assert.deepEqual(fitWindowSize(1, workArea), { width: 300, height: 560 });
  // 没有工作区信息（显示器列表读不到）：不夹。
  assert.deepEqual(fitWindowSize(2, null), { width: 600, height: 1120 });
});

test('放大时窗口的下边缘中心保持不动', () => {
  // 桌宠是站在地上的角色：脚下的位置不动，个头往上长。
  const pos = anchoredPosition(100, 200, 300, 560, { width: 600, height: 1120 });
  assert.equal(pos.x, 100 + 150 - 300);
  assert.equal(pos.y, 200 + 560 - 1120);
  // 下边缘中心确实没动。
  assert.equal(pos.x + 600 / 2, 100 + 300 / 2);
  assert.equal(pos.y + 1120, 200 + 560);
});

test('缩小同样绕下边缘中心展开', () => {
  const pos = anchoredPosition(100, 200, 600, 1120, { width: 300, height: 560 });
  assert.equal(pos.x + 150, 100 + 300);
  assert.equal(pos.y + 560, 200 + 1120);
});
