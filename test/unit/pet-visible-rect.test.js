// 「桌宠本体的可见矩形」这套几何的单元测试。
//
// 背景：桌宠窗口是一块固定大小的画布，Live2D 贴图四周通常留着一大片
// 透明边。夹紧位置、恢复位置都得按**看得见的那个形象**算，
// 否则小模型永远差一截才贴得到屏幕边，往上拖也拖不到顶。
//
// 这些函数是纯几何（不 import Electron），所以能直接用 node --test 跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hasVisibleRect,
  visibleRectOnScreen,
  windowRectForVisible,
  scaleVisibleRect,
} from '../../src/shared/petRect.js';
import { clampToDisplays, restorePosition } from '../../src/main/display.js';

const DISPLAYS = [
  {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  },
];

// 一块 300×560 的画布，形象只占底下这一块（上方是透明留白）。
const WINDOW = { x: 60, y: 200, width: 300, height: 560 };
const VISIBLE = { x: 30, y: 300, width: 240, height: 260 };

test('可见矩形的换算是可逆的', () => {
  assert.equal(hasVisibleRect(VISIBLE), true);
  assert.equal(hasVisibleRect(null), false);
  assert.equal(hasVisibleRect({ x: 0, y: 0, width: 0, height: 10 }), false);

  const onScreen = visibleRectOnScreen(WINDOW, VISIBLE);
  assert.deepEqual(onScreen, { x: 90, y: 500, width: 240, height: 260 });

  const back = windowRectForVisible(onScreen, VISIBLE);
  assert.deepEqual(back, { x: 60, y: 200 });
});

test('没有可见矩形时退回整块窗口', () => {
  assert.deepEqual(visibleRectOnScreen(WINDOW, null), WINDOW);
  assert.deepEqual(windowRectForVisible({ x: 10, y: 20 }, null), { x: 10, y: 20 });
});

test('按比例缩放可见矩形（窗口尺寸变了的时候）', () => {
  const scaled = scaleVisibleRect(VISIBLE, 2, 2);
  assert.deepEqual(scaled, { x: 60, y: 600, width: 480, height: 520 });
  // 没有可见矩形时原样返回。
  assert.equal(scaleVisibleRect(null, 2, 2), null);
});

test('夹紧按形象算：窗口可以有一部分在屏幕外', () => {
  // 往上拖到形象正好贴着屏幕顶：窗口的上半截（透明留白）在屏幕外。
  const dragged = clampToDisplays(60, -300, 300, 560, DISPLAYS, VISIBLE);
  assert.deepEqual(dragged, { x: 60, y: -300 });

  // 不给可见矩形时就是旧行为：整个窗口必须留在屏幕内。
  const legacy = clampToDisplays(60, -300, 300, 560, DISPLAYS);
  assert.deepEqual(legacy, { x: 60, y: 0 });
});

test('夹紧按形象算：拖过头了也只让形象贴边，不会跑到屏幕外', () => {
  const dragged = clampToDisplays(60, -400, 300, 560, DISPLAYS, VISIBLE);
  // 形象的上边被夹在屏幕顶：-300 + 300 = 0。
  assert.equal(dragged.y, -300);
  const onScreen = visibleRectOnScreen({ x: dragged.x, y: dragged.y, width: 300, height: 560 }, VISIBLE);
  assert.equal(onScreen.y, 0);
  assert.ok(onScreen.y + onScreen.height <= DISPLAYS[0].workArea.height);
});

test('恢复位置按形象算：窗口有一部分在屏幕外仍然算有效', () => {
  const saved = { x: 60, y: -300 };
  // 按窗口判：不在屏幕内 → 会回落到主显示器右下角。
  assert.deepEqual(restorePosition(saved, 300, 560, DISPLAYS), {
    x: DISPLAYS[0].workArea.x + DISPLAYS[0].workArea.width - 300,
    y: DISPLAYS[0].workArea.y + DISPLAYS[0].workArea.height - 560,
  });
  // 按形象判：形象完整在屏幕内 → 原样恢复。
  assert.deepEqual(restorePosition(saved, 300, 560, DISPLAYS, VISIBLE), saved);
});

test('恢复位置：显示器真的没了才回落（按形象判也一样）', () => {
  // 可见矩形落在另一块（已经不存在的）显示器上 → 回落。
  const saved = { x: 3000, y: 200 };
  assert.deepEqual(restorePosition(saved, 300, 560, DISPLAYS, VISIBLE), {
    x: DISPLAYS[0].workArea.x + DISPLAYS[0].workArea.width - 300,
    y: DISPLAYS[0].workArea.y + DISPLAYS[0].workArea.height - 560,
  });
});
