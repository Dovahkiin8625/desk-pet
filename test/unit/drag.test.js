import test from 'node:test';
import assert from 'node:assert/strict';
import { createDragController, DRAG_THRESHOLD } from '../../src/renderer/ui/drag.js';

function ev(x, y, pointerId = 1, button = 0) {
  return { clientX: x, clientY: y, pointerId, button };
}

test('位移未超过阈值判定为点击', () => {
  let tapped = null;
  let dragged = false;
  const c = createDragController({ onTap: (x, y) => { tapped = [x, y]; }, onDragStart: () => { dragged = true; } });
  c.pointerDown(ev(100, 100));
  c.pointerMove(ev(100 + DRAG_THRESHOLD, 100));
  c.pointerUp(ev(100 + DRAG_THRESHOLD, 100));
  assert.equal(dragged, false);
  assert.deepEqual(tapped, [100 + DRAG_THRESHOLD, 100]);
});

test('位移超过阈值判定为拖拽', () => {
  let tapped = null;
  const moves = [];
  const c = createDragController({
    onTap: () => { tapped = true; },
    onDragMove: (m) => { moves.push(m); },
  });
  c.pointerDown(ev(100, 100));
  c.pointerMove(ev(140, 100));
  assert.equal(c.dragging, true);
  c.pointerMove(ev(150, 100));
  c.pointerUp(ev(150, 100));
  assert.equal(tapped, null);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0], { clientX: 140, clientY: 100, deltaX: 40, deltaY: 0 });
  assert.deepEqual(moves[1], { clientX: 150, clientY: 100, deltaX: 10, deltaY: 0 });
});

test('拖拽增量是可累加的，不会重复计入起点位移', () => {
  const moves = [];
  const c = createDragController({ onDragMove: (m) => { moves.push(m); } });
  c.pointerDown(ev(100, 100));
  c.pointerMove(ev(120, 100));
  c.pointerMove(ev(130, 100));
  const total = moves.reduce((sum, m) => sum + m.deltaX, 0);
  assert.equal(total, 30);
});

test('非左键不触发拖拽', () => {
  const c = createDragController({});
  c.pointerDown(ev(100, 100, 1, 2));
  c.pointerMove(ev(300, 300));
  assert.equal(c.dragging, false);
});

test('多指情况下忽略非触发指针的事件', () => {
  const c = createDragController({});
  c.pointerDown(ev(100, 100, 1));
  c.pointerMove(ev(300, 300, 2));
  assert.equal(c.dragging, false);
});

test('拖拽进行中，第二根手指的 pointerdown 不打断它', () => {
  // 第二根手指按下时若覆盖了 down/last，锚点会跳到第二根手指上，
  // 正在进行的拖拽被作废、窗口突然位移。
  const moves = [];
  let starts = 0;
  const c = createDragController({
    onDragStart: () => { starts++; },
    onDragMove: (m) => { moves.push(m); },
  });
  c.pointerDown(ev(100, 100, 1));
  c.pointerMove(ev(140, 100, 1));
  assert.equal(c.dragging, true);
  assert.equal(starts, 1);

  c.pointerDown(ev(300, 300, 2));
  assert.equal(c.dragging, true);

  // 第一根手指继续移动：增量仍相对它自己上一次的位置。
  c.pointerMove(ev(150, 100, 1));
  assert.equal(starts, 1);
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[1], { clientX: 150, clientY: 100, deltaX: 10, deltaY: 0 });
});
