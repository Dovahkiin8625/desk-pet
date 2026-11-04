import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebScript } from './helpers/load-web-script.js';

const { ScreenRecorderGeometry: G } = await loadWebScript(
  '../../../plugins/screen-recorder/web/geometry.js'
);

/**
 * 摊平成普通对象再比较。
 *
 * 脚本是在 vm 的新上下文里跑的，那边的对象原型跟本进程的不是一回事，
 * deepStrictEqual 会因为「原型不同」而失败——比的不是数值，是出身。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('拖拽起止点归一化成矩形：往左往上都算数', () => {
  assert.deepEqual(plain(G.normalizeRect({ x: 100, y: 80 }, { x: 300, y: 200 })), {
    x: 100,
    y: 80,
    width: 200,
    height: 120,
  });
  assert.deepEqual(plain(G.normalizeRect({ x: 300, y: 200 }, { x: 100, y: 80 })), {
    x: 100,
    y: 80,
    width: 200,
    height: 120,
  });
});

test('没有拖动（起止同一点）得到空矩形', () => {
  const r = G.normalizeRect({ x: 50, y: 50 }, { x: 50, y: 50 });
  assert.equal(r.width, 0);
  assert.equal(r.height, 0);
});

test('缩放：100% 时原样，150% 时按比例放大', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(plain(G.scaleRect(rect, { width: 800, height: 600 }, { width: 800, height: 600 })), rect);
  const scaled = G.scaleRect(rect, { width: 800, height: 600 }, { width: 1200, height: 900 });
  assert.deepEqual(plain(scaled), { x: 15, y: 30, width: 150, height: 75 });
});

test('缩放：200% 缩放比下，CSS 坐标换算到物理像素', () => {
  // 显示器 bounds 是 DIP（1280×800），截图与捕获轨是物理像素（2560×1600）。
  const css = { x: 100, y: 50, width: 200, height: 100 };
  const dip = { width: 1280, height: 800 };
  const physical = { width: 2560, height: 1600 };
  const rect = G.scaleRect(css, dip, physical);
  assert.deepEqual(plain(rect), { x: 200, y: 100, width: 400, height: 200 });
});

test('夹在边界内：拖出窗口的部分被切掉', () => {
  const clamped = G.clampRect({ x: -50, y: -20, width: 5000, height: 3000 }, { width: 800, height: 600 });
  assert.equal(clamped.x, 0);
  assert.equal(clamped.y, 0);
  assert.equal(clamped.width, 800);
  assert.equal(clamped.height, 600);
});
