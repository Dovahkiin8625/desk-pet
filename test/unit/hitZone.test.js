import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZone, geometricZone } from '../../src/renderer/pet/hitZone.js';

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
  const bounds = { x: 0, y: 0, width: 300, height: 560 };
  assert.equal(geometricZone(bounds, 150, 50), 'head');
  assert.equal(geometricZone(bounds, 150, 190), 'head');
  assert.equal(geometricZone(bounds, 150, 250), 'body');
  assert.equal(geometricZone(bounds, 150, 500), 'body');
});

test('包围盒无效时返回 other', () => {
  assert.equal(geometricZone(null, 10, 10), 'other');
  assert.equal(geometricZone({ x: 0, y: 0, width: 0, height: 0 }, 10, 10), 'other');
});
