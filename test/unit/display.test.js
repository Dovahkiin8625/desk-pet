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
