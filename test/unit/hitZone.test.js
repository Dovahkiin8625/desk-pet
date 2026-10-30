import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZone, geometricZone, hitZoneAt } from '../../src/renderer/pet/hitZone.js';

const BOUNDS = { x: 0, y: 0, width: 300, height: 560 };

/** 造一个命中区行为可控的假模型。 */
function stubModel({ hit = [], areas = { Head: {}, Body: {} }, bounds = BOUNDS } = {}) {
  return {
    internalModel: { hitAreas: areas },
    hitTest: () => hit,
    getBounds: () => bounds,
  };
}

test('命中区名归一化', () => {
  assert.equal(normalizeZone('Head'), 'head');
  assert.equal(normalizeZone('head'), 'head');
  assert.equal(normalizeZone('Body'), 'body');
  assert.equal(normalizeZone('BODY'), 'body');
  assert.equal(normalizeZone('ribon'), 'other');
  assert.equal(normalizeZone(''), 'other');
  assert.equal(normalizeZone(undefined), 'other');
});

test('几何兜底：上 35% 判为头部', () => {
  assert.equal(geometricZone(BOUNDS, 150, 50), 'head');
  assert.equal(geometricZone(BOUNDS, 150, 190), 'head');
  assert.equal(geometricZone(BOUNDS, 150, 250), 'body');
  assert.equal(geometricZone(BOUNDS, 150, 500), 'body');
});

test('几何兜底：包围盒之外的点返回 other', () => {
  // 桌宠周围的空白处点击不应该触发反应——用户点了桌子，桌宠不该摸头。
  assert.equal(geometricZone(BOUNDS, 150, -20), 'other');
  assert.equal(geometricZone(BOUNDS, -10, 150), 'other');
  assert.equal(geometricZone(BOUNDS, 400, 150), 'other');
  assert.equal(geometricZone(BOUNDS, 150, 700), 'other');
});

test('包围盒无效时返回 other', () => {
  assert.equal(geometricZone(null, 10, 10), 'other');
  assert.equal(geometricZone({ x: 0, y: 0, width: 0, height: 0 }, 10, 10), 'other');
});

test('hitZoneAt 优先使用模型原生命中区', () => {
  // 关键用例：y=150 在几何判定下是 body（rel=0.27 <= 0.35 → head，实际 head），
  // 这里选一个几何判定会答 body、原生会答 head 的点，证明原生优先。
  const model = stubModel({ hit: ['Head'] });
  assert.equal(hitZoneAt(model, 150, 400), 'head');
  const model2 = stubModel({ hit: ['Body'] });
  assert.equal(hitZoneAt(model2, 150, 60), 'body');
});

test('hitZoneAt 在原生命中区未命中时退回几何判定', () => {
  const model = stubModel({ hit: [] });
  assert.equal(hitZoneAt(model, 150, 50), 'head');
  assert.equal(hitZoneAt(model, 150, 400), 'body');
});

test('hitZoneAt 在模型之外返回 other', () => {
  const model = stubModel({ hit: [] });
  assert.equal(hitZoneAt(model, 150, -20), 'other');
  assert.equal(hitZoneAt(model, -10, 150), 'other');
  assert.equal(hitZoneAt(model, 150, 700), 'other');
});

test('hitZoneAt 在模型没有命中区时退回几何判定', () => {
  const model = stubModel({ hit: [], areas: {} });
  assert.equal(hitZoneAt(model, 150, 50), 'head');
  assert.equal(hitZoneAt(model, 150, 400), 'body');
});
