import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../src/main/settings.js';

test('空输入返回默认设置', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(sanitizeSettings('nonsense'), DEFAULT_SETTINGS);
});

test('非法字段回退默认值', () => {
  const s = sanitizeSettings({ scale: 'abc', opacity: 99, modelId: 42, position: 'x,y' });
  assert.equal(s.scale, DEFAULT_SETTINGS.scale);
  assert.equal(s.opacity, DEFAULT_SETTINGS.opacity);
  assert.equal(s.modelId, DEFAULT_SETTINGS.modelId);
  assert.equal(s.position, null);
});

test('合法值被保留', () => {
  const s = sanitizeSettings({
    position: { x: 100, y: 200 },
    modelId: 'natori',
    scale: 1.5,
    opacity: 0.5,
    visible: false,
  });
  assert.deepEqual(s.position, { x: 100, y: 200 });
  assert.equal(s.modelId, 'natori');
  assert.equal(s.scale, 1.5);
  assert.equal(s.opacity, 0.5);
  assert.equal(s.visible, false);
});

test('未知字段被丢弃', () => {
  const s = sanitizeSettings({ scale: 1, evil: 'payload' });
  assert.equal(s.evil, undefined);
});

test('数值被夹紧到合法区间', () => {
  assert.equal(sanitizeSettings({ scale: 99 }).scale, 2);
  assert.equal(sanitizeSettings({ scale: 0.01 }).scale, 0.5);
  assert.equal(sanitizeSettings({ opacity: -1 }).opacity, 0.2);
});
