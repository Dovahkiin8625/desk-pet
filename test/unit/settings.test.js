import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeSettings, loadSettings, saveSettings, DEFAULT_SETTINGS } from '../../src/main/settings.js';

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

test('配置文件缺失时回退默认值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-settings-'));
  try {
    assert.deepEqual(await loadSettings(dir), DEFAULT_SETTINGS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置文件损坏时回退默认值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-settings-'));
  try {
    await writeFile(join(dir, 'settings.json'), '{ 这不是合法 JSON', 'utf8');
    assert.deepEqual(await loadSettings(dir), DEFAULT_SETTINGS);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('保存后能读回，且会创建不存在的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-settings-'));
  const dir = join(root, 'nested', 'deeper');
  try {
    const saved = await saveSettings(dir, {
      modelId: 'natori',
      scale: 1.5,
      opacity: 0.8,
      position: { x: 10, y: 20 },
    });
    assert.equal(saved.modelId, 'natori');
    const loaded = await loadSettings(dir);
    assert.equal(loaded.modelId, 'natori');
    assert.equal(loaded.scale, 1.5);
    assert.equal(loaded.opacity, 0.8);
    assert.deepEqual(loaded.position, { x: 10, y: 20 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
