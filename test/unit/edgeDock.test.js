import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCK_SLIP,
  SNAP_THRESHOLD,
  MIN_DOCK_PUSH,
  edgeGaps,
  snapToEdge,
  dockPosition,
  flushPosition,
  dockedRange,
  clampDocked,
  isFullyTucked,
  chooseDockSide,
} from '../../src/main/edgeDock.js';

// 一块 1000×800 的工作区，原点在 (0,0)。
const WA = { x: 0, y: 0, width: 1000, height: 800 };
// 一扇 300×560 的窗口。
const W = 300;
const H = 560;

test('间隙：正数是还差多少，负数是越出屏幕多少', () => {
  const g = edgeGaps(100, 50, W, H, WA);
  assert.equal(g.left, 100);
  assert.equal(g.top, 50);
  assert.equal(g.right, 1000 - (100 + W));
  assert.equal(g.bottom, 800 - (50 + H));
});

test('吸附：间隙在阈值内且位移朝那条边 → 贴齐', () => {
  // 距右边 10px，往右推 → 贴到右边缘。
  const x = WA.x + WA.width - W - 10;
  const out = snapToEdge(x, 200, W, H, WA, { dx: 5, dy: 0 });
  assert.equal(out.side, 'right');
  assert.equal(out.x, WA.x + WA.width - W);
  assert.equal(out.y, 200);
});

test('吸附：位移朝反方向时不吸附（窗口能离开边缘）', () => {
  // 这条是「窗口粘在边缘拽不动」的防线：
  // 往左拖时不该再被吸回去。
  const x = WA.x + WA.width - W - 10;
  const out = snapToEdge(x, 200, W, H, WA, { dx: -5, dy: 0 });
  assert.equal(out.side, null);
  assert.equal(out.x, x);
});

test('吸附：间隙超过阈值不吸附', () => {
  const x = WA.x + WA.width - W - (SNAP_THRESHOLD + 1);
  const out = snapToEdge(x, 200, W, H, WA, { dx: 5, dy: 0 });
  assert.equal(out.side, null);
  assert.equal(out.x, x);
});

test('吸附：四条边各自贴齐到正确的位置', () => {
  const nearLeft = WA.x + 5;
  const l = snapToEdge(nearLeft, 200, W, H, WA, { dx: -1, dy: 0 });
  assert.equal(l.side, 'left');
  assert.equal(l.x, WA.x);

  const nearTop = WA.y + 5;
  const t = snapToEdge(200, nearTop, W, H, WA, { dx: 0, dy: -1 });
  assert.equal(t.side, 'top');
  assert.equal(t.y, WA.y);

  const nearBottom = WA.y + WA.height - H - 5;
  const b = snapToEdge(200, nearBottom, W, H, WA, { dx: 0, dy: 1 });
  assert.equal(b.side, 'bottom');
  assert.equal(b.y, WA.y + WA.height - H);
});

test('停靠位置：只露出 DOCK_SLIP 宽', () => {
  const d = dockPosition('right', 100, 200, W, H, WA);
  assert.equal(d.x, WA.x + WA.width - DOCK_SLIP);
  assert.equal(d.y, 200);

  const l = dockPosition('left', 100, 200, W, H, WA);
  assert.equal(l.x, WA.x + DOCK_SLIP - W);

  const t = dockPosition('top', 100, 200, W, H, WA);
  assert.equal(t.y, WA.y + DOCK_SLIP - H);

  const b = dockPosition('bottom', 100, 200, W, H, WA);
  assert.equal(b.y, WA.y + WA.height - DOCK_SLIP);
});

test('完全可见贴齐位与停靠位差 W - DOCK_SLIP', () => {
  const flush = flushPosition('right', 100, 200, W, H, WA);
  const dock = dockPosition('right', 100, 200, W, H, WA);
  assert.equal(flush.x, WA.x + WA.width - W);
  assert.equal(dock.x - flush.x, W - DOCK_SLIP);
});

test('停靠区间：从完全贴齐到完全藏起', () => {
  const r = dockedRange('right', W, H, WA);
  assert.equal(r.min, WA.x + WA.width - W);
  assert.equal(r.max, WA.x + WA.width - DOCK_SLIP);
  assert.ok(r.min < r.max);
});

test('停靠夹紧：沿停靠轴放宽，垂直轴照常', () => {
  // 想往右再推 200px：夹紧后停在「完全藏起」那一端。
  const c = clampDocked(WA.x + WA.width + 200, 100, W, H, WA, 'right');
  assert.equal(c.x, WA.x + WA.width - DOCK_SLIP);
  assert.equal(c.y, 100);

  // 垂直方向仍然被工作区夹住。
  const c2 = clampDocked(100, WA.y + WA.height + 50, W, H, WA, 'right');
  assert.equal(c2.y, WA.y + WA.height - H);
});

test('停靠夹紧：把窗口从藏起处拉回来', () => {
  const c = clampDocked(WA.x + WA.width - DOCK_SLIP - 200, 100, W, H, WA, 'right');
  assert.equal(c.x, WA.x + WA.width - DOCK_SLIP - 200);
});

test('完全藏起判定', () => {
  const dock = dockPosition('right', 100, 200, W, H, WA);
  assert.equal(isFullyTucked(dock.x, dock.y, W, H, WA, 'right'), true);
  const half = dockPosition('right', 100, 200, W, H, WA);
  half.x -= 100;
  assert.equal(isFullyTucked(half.x, half.y, W, H, WA, 'right'), false);
});

test('停靠判定：贴齐 + 朝该边推 → 命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W, 100, W, H, WA);
  assert.equal(gaps.right, 0);
  assert.equal(chooseDockSide(gaps, { dx: 200, dy: 0 }), 'right');
});

test('停靠判定：反方向推不命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W, 100, W, H, WA);
  assert.equal(chooseDockSide(gaps, { dx: -200, dy: 0 }), null);
});

test('停靠判定：位移太小不命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W, 100, W, H, WA);
  assert.equal(chooseDockSide(gaps, { dx: MIN_DOCK_PUSH - 1, dy: 0 }), null);
});

test('停靠判定：没贴齐就不命中', () => {
  const gaps = edgeGaps(WA.x + WA.width - W - 30, 100, W, H, WA);
  assert.equal(chooseDockSide(gaps, { dx: 200, dy: 0 }), null);
});

test('停靠判定：两个方向都贴齐时取位移大的那个', () => {
  // 窗口同时贴着右边和下边（默认位置就在右下角）。
  const gaps = edgeGaps(WA.x + WA.width - W, WA.y + WA.height - H, W, H, WA);
  assert.equal(gaps.right, 0);
  assert.equal(gaps.bottom, 0);
  assert.equal(chooseDockSide(gaps, { dx: 10, dy: 300 }), 'bottom');
  assert.equal(chooseDockSide(gaps, { dx: 300, dy: 10 }), 'right');
});
