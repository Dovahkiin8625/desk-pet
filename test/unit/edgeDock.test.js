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

// ---------------------------------------------------------------------------
// 四条边的对称性。
//
// 这些期望值是**写死的数字**，不是照着实现再写一遍公式——
// 照公式写等于自己验自己，写反了也发现不了。
// ---------------------------------------------------------------------------

const SIDES = [
  { side: 'left', axis: 'x', min: -276, max: 0, dock: -276, pull: 100 },
  { side: 'right', axis: 'x', min: 700, max: 976, dock: 976, pull: -100 },
  { side: 'top', axis: 'y', min: -536, max: 0, dock: -536, pull: 100 },
  { side: 'bottom', axis: 'y', min: 240, max: 776, dock: 776, pull: -100 },
];

test('停靠区间：四条边的 min/max 都不写反', () => {
  for (const s of SIDES) {
    const r = dockedRange(s.side, W, H, WA);
    assert.equal(r.min, s.min, `${s.side} 的 min`);
    assert.equal(r.max, s.max, `${s.side} 的 max`);
    assert.ok(r.min < r.max, `${s.side} 的区间方向`);
  }
});

test('停靠区间：左右、上下互为镜像', () => {
  const left = dockedRange('left', W, H, WA);
  const right = dockedRange('right', W, H, WA);
  const top = dockedRange('top', W, H, WA);
  const bottom = dockedRange('bottom', W, H, WA);

  // 跨度：从完全贴齐到完全藏起，正好是「窗口大小 - 露出的宽度」。
  assert.equal(left.max - left.min, W - DOCK_SLIP);
  assert.equal(right.max - right.min, W - DOCK_SLIP);
  assert.equal(top.max - top.min, H - DOCK_SLIP);
  assert.equal(bottom.max - bottom.min, H - DOCK_SLIP);

  // 镜像：把右边的位置沿工作区中线翻过去，应当落在左边的区间里，
  // 而且两端互换（min ↔ max）——「某条边写反了」正是从这里露馅。
  const mirrorX = (x) => WA.x + WA.width - (x + W);
  const mirrorY = (y) => WA.y + WA.height - (y + H);
  assert.equal(mirrorX(right.max), left.min);
  assert.equal(mirrorX(right.min), left.max);
  assert.equal(mirrorY(bottom.max), top.min);
  assert.equal(mirrorY(bottom.min), top.max);
});

test('停靠夹紧：四条边的停靠轴都夹到对应端', () => {
  for (const s of SIDES) {
    const over = s.axis === 'x' ? { x: s.max + 500, y: 100 } : { x: 100, y: s.max + 500 };
    assert.equal(clampDocked(over.x, over.y, W, H, WA, s.side)[s.axis], s.max, `${s.side} 超出上界`);

    const under = s.axis === 'x' ? { x: s.min - 500, y: 100 } : { x: 100, y: s.min - 500 };
    assert.equal(clampDocked(under.x, under.y, W, H, WA, s.side)[s.axis], s.min, `${s.side} 超出下界`);
  }
});

test('停靠夹紧：四条边的垂直轴按普通工作区夹', () => {
  const maxX = WA.x + WA.width - W;
  const maxY = WA.y + WA.height - H;
  for (const s of SIDES) {
    const perp = s.axis === 'x' ? 'y' : 'x';

    // 垂直轴推得太远 → 被工作区夹住（与停靠轴无关）。
    const far = s.axis === 'x' ? { x: s.dock, y: WA.y + WA.height + 100 } : { x: WA.x + WA.width + 100, y: s.dock };
    assert.equal(clampDocked(far.x, far.y, W, H, WA, s.side)[perp], s.axis === 'x' ? maxY : maxX);

    // 垂直轴越出另一边 → 夹回工作区内。
    const near = s.axis === 'x' ? { x: s.dock, y: WA.y - 100 } : { x: WA.x - 100, y: s.dock };
    assert.equal(clampDocked(near.x, near.y, W, H, WA, s.side)[perp], s.axis === 'x' ? WA.y : WA.x);
  }
});

test('完全藏起判定：四条边', () => {
  for (const s of SIDES) {
    const pos = s.axis === 'x' ? { x: s.dock, y: 200 } : { x: 200, y: s.dock };
    assert.equal(isFullyTucked(pos.x, pos.y, W, H, WA, s.side), true, `${s.side} 停在停靠位`);

    const pulled = s.axis === 'x' ? { x: s.dock + s.pull, y: 200 } : { x: 200, y: s.dock + s.pull };
    assert.equal(isFullyTucked(pulled.x, pulled.y, W, H, WA, s.side), false, `${s.side} 拉出后`);
  }
});

test('未知 side：夹紧退化成普通夹紧，不把窗口推出屏幕', () => {
  const c = clampDocked(5000, 5000, W, H, WA, 'diagonal');
  assert.equal(c.x, WA.x + WA.width - W);
  assert.equal(c.y, WA.y + WA.height - H);

  const c2 = clampDocked(-5000, -5000, W, H, WA, 'diagonal');
  assert.equal(c2.x, WA.x);
  assert.equal(c2.y, WA.y);
});

test('缺 workArea 时 edgeGaps 明确抛错，不返回假间隙', () => {
  assert.throws(() => edgeGaps(0, 0, W, H, undefined), TypeError);
  assert.throws(() => edgeGaps(0, 0, W, H, null), TypeError);
});

test('停靠夹紧：带小数的输入取整后仍落在区间内', () => {
  // 整数边界：结果必须是区间内的整数。
  const r = dockedRange('right', W, H, WA);
  const c = clampDocked(r.max + 0.6, 100.4, W, H, WA, 'right');
  assert.ok(c.x >= r.min && c.x <= r.max, `${c.x} 应当落在 [${r.min}, ${r.max}] 内`);
  assert.equal(Number.isInteger(c.x), true);
  assert.equal(Number.isInteger(c.y), true);

  // 分数边界（自定义 slip）：取整在前、夹紧在后，结果一定在区间内。
  // 先夹再取整的话，这里会得到 976 —— 比上界 975.5 还多露 1px。
  const slip = 24.5;
  const rf = dockedRange('right', W, H, WA, slip);
  const cf = clampDocked(976.4, 100.4, W, H, WA, 'right', slip);
  assert.ok(cf.x >= rf.min && cf.x <= rf.max, `${cf.x} 应当落在 [${rf.min}, ${rf.max}] 内`);
});
