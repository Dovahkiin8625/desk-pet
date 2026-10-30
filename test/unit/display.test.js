import test from 'node:test';
import assert from 'node:assert/strict';
import { clampToDisplays, defaultPosition } from '../../src/main/display.js';

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
