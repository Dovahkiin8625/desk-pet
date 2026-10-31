import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToDisplays, defaultPosition, restorePosition } from '../../src/main/display.js';

const PRIMARY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const SECOND = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
};

test('位置完整落在某显示器工作区内时保持不变', () => {
  const r = clampToDisplays(100, 100, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 100, y: 100 });
});

test('副显示器上的位置同样被保留', () => {
  const r = clampToDisplays(3000, 200, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 3000, y: 200 });
});

test('位置超出所有显示器时回落到最近的显示器并夹紧', () => {
  const r = clampToDisplays(99999, 99999, 300, 560, [PRIMARY]);
  assert.ok(r.x >= 0 && r.x <= PRIMARY.workArea.width - 300);
  assert.ok(r.y >= 0 && r.y <= PRIMARY.workArea.height - 560);
});

test('显示器被拔掉后坐标回落到主显示器内', () => {
  const r = clampToDisplays(3000, 200, 300, 560, [PRIMARY]);
  assert.ok(r.x >= 0 && r.x <= PRIMARY.workArea.width - 300);
  assert.ok(r.y >= 0 && r.y <= PRIMARY.workArea.height - 560);
});

test('负坐标被夹紧回可见区域', () => {
  const r = clampToDisplays(-500, -500, 300, 560, [PRIMARY]);
  assert.ok(r.x >= 0 && r.y >= 0);
});

test('默认位置落在主显示器右下角', () => {
  const r = defaultPosition(300, 560, [PRIMARY, SECOND]);
  assert.equal(r.x, PRIMARY.workArea.width - 300);
  assert.equal(r.y, PRIMARY.workArea.height - 560);
});

test('没有显示器时返回原点', () => {
  assert.deepEqual(defaultPosition(300, 560, []), { x: 0, y: 0 });
});

test('默认位置以数组第一块屏幕为主显示器', () => {
  // 前置条件：displays[0] 必须是主显示器（Task 3 的 currentDisplays 负责把主屏排在首位，
  // Electron 的 getAllDisplays() 并不保证这一点）。本用例把该前置条件钉死：
  // 传入 [SECOND, PRIMARY] 时结果必须跟随第一块屏幕，而不是自动挑主屏。
  const r = defaultPosition(300, 560, [SECOND, PRIMARY]);
  assert.equal(r.x, SECOND.workArea.x + SECOND.workArea.width - 300);
  assert.equal(r.y, SECOND.workArea.y + SECOND.workArea.height - 560);
});

test('恢复位置：位置可见时原样返回', () => {
  const r = restorePosition({ x: 100, y: 100 }, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 100, y: 100 });
});

test('恢复位置：副显示器上的位置同样原样返回', () => {
  const r = restorePosition({ x: 3000, y: 200 }, 300, 560, [PRIMARY, SECOND]);
  assert.deepEqual(r, { x: 3000, y: 200 });
});

test('恢复位置：显示器被拔掉时回落到主显示器右下角', () => {
  const r = restorePosition({ x: 3000, y: 200 }, 300, 560, [PRIMARY]);
  assert.deepEqual(r, { x: PRIMARY.workArea.width - 300, y: PRIMARY.workArea.height - 560 });
});

test('恢复位置：没有保存位置时回落到主显示器右下角', () => {
  const r = restorePosition(null, 300, 560, [PRIMARY]);
  assert.deepEqual(r, { x: PRIMARY.workArea.width - 300, y: PRIMARY.workArea.height - 560 });
});

test('拖拽夹紧与启动恢复语义不同', () => {
  const saved = { x: 3000, y: 200 };
  // 副显示器被拔掉后
  const clamped = clampToDisplays(saved.x, saved.y, 300, 560, [PRIMARY]);
  const restored = restorePosition(saved, 300, 560, [PRIMARY]);
  // 拖拽：停在主显示器可见区域边缘，不跳回右下角
  assert.notDeepEqual(clamped, restored);
  assert.ok(clamped.x >= 0 && clamped.y >= 0);
  // 启动恢复：回到主显示器右下角
  assert.deepEqual(restored, { x: PRIMARY.workArea.width - 300, y: PRIMARY.workArea.height - 560 });
});

// ---------------------------------------------------------------------------
// 最近显示器的选择：distanceToRect（到矩形边界的距离）而不是到中心的距离。
//
// 多显示器是 spec §1.8 的要求，而「选哪块屏幕」这条规则此前没有任何用例钉住：
// 现有用例要么位置完整落在某块屏幕内，要么只有一块屏幕，
// 把 distanceToRect 换成 distanceToCenter 仍然会全绿。
// ---------------------------------------------------------------------------

const TOP = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1040 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const BOTTOM = {
  id: 2,
  bounds: { x: 0, y: 1040, width: 1920, height: 1040 },
  workArea: { x: 0, y: 1040, width: 1920, height: 1040 },
};

test('点在两块上下叠放的屏幕下方时，夹到更近的那块（下屏）', () => {
  const r = clampToDisplays(100, 2500, 300, 560, [TOP, BOTTOM]);
  // 下屏更近：夹到下屏的可见区域里。
  assert.equal(r.x, 100);
  assert.equal(r.y, BOTTOM.workArea.y + BOTTOM.workArea.height - 560);
  // 换一块中心更近的规则（到屏幕中心的距离）会得到别的结果：
  assert.notDeepEqual(r, { x: 100, y: TOP.workArea.height - 560 });
});

test('矩形距离与中心距离给出不同答案时，选矩形更近的那块', () => {
  // 主屏 1920 宽；下方挂一块 960 宽的小屏，横向居中偏左（x=480）。
  const small = {
    id: 3,
    bounds: { x: 480, y: 1040, width: 960, height: 1040 },
    workArea: { x: 480, y: 1040, width: 960, height: 1040 },
  };
  // 点在两块屏幕之间的缝隙里，且靠左：到主屏矩形 20px，到小屏矩形 380px。
  const r = clampToDisplays(100, 1060, 300, 560, [TOP, small]);
  // 矩形距离 → 主屏更近 → 夹到主屏下边缘。
  assert.deepEqual(r, { x: 100, y: TOP.workArea.height - 560 });
  // 若改用「到屏幕中心距离」：到小屏中心更近（995 < 1016），
  // 结果会变成 { x: 480, y: 1060 } —— 本用例正是为了钉住这个区别。
});
