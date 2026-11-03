import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
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

test('保存是原子的：不留临时文件，且旧内容不会先被截断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-settings-'));
  try {
    // 先写一份旧配置：直接 writeFile 会把它截断成 0 字节，
    // 写到一半被强杀就留下 0 字节文件——下次启动静默重置全部设置。
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ modelId: 'haru' }), 'utf8');
    await saveSettings(dir, { modelId: 'natori', scale: 1.25 });

    // 临时文件必须已经被改名掉，不能留在目录里。
    const files = await readdir(dir);
    assert.deepEqual(files, ['settings.json']);

    // 内容完整可解析：不是 0 字节、不是半个 JSON。
    const raw = await readFile(join(dir, 'settings.json'), 'utf8');
    assert.ok(raw.length > 0);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.modelId, 'natori');
    assert.equal(parsed.scale, 1.25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('六个新字段有默认值', () => {
  assert.equal(DEFAULT_SETTINGS.autoLaunch, false);
  assert.equal(DEFAULT_SETTINGS.hotkey, 'Control+Shift+D');
  assert.equal(DEFAULT_SETTINGS.clickThrough, false);
  assert.equal(DEFAULT_SETTINGS.edgeSnap, true);
  assert.equal(DEFAULT_SETTINGS.dockEnabled, false);
  assert.equal(DEFAULT_SETTINGS.dock, null);
});

test('新字段的合法值被保留', () => {
  const s = sanitizeSettings({
    autoLaunch: true,
    hotkey: 'Control+Alt+P',
    clickThrough: true,
    edgeSnap: false,
    dockEnabled: true,
    dock: 'right',
  });
  assert.equal(s.autoLaunch, true);
  assert.equal(s.hotkey, 'Control+Alt+P');
  assert.equal(s.clickThrough, true);
  assert.equal(s.edgeSnap, false);
  assert.equal(s.dockEnabled, true);
  assert.equal(s.dock, 'right');
});

test('新字段的类型不对时回退默认值', () => {
  const s = sanitizeSettings({
    autoLaunch: 'yes',
    clickThrough: 1,
    edgeSnap: 'no',
    dockEnabled: null,
    hotkey: 42,
  });
  assert.equal(s.autoLaunch, false);
  assert.equal(s.clickThrough, false);
  assert.equal(s.edgeSnap, true);
  assert.equal(s.dockEnabled, false);
  assert.equal(s.hotkey, 'Control+Shift+D');
});

test('dock 只认四个合法边名', () => {
  assert.equal(sanitizeSettings({ dock: 'up' }).dock, null);
  assert.equal(sanitizeSettings({ dock: '' }).dock, null);
  assert.equal(sanitizeSettings({ dock: 'top' }).dock, 'top');
  assert.equal(sanitizeSettings({ dock: 'bottom' }).dock, 'bottom');
  assert.equal(sanitizeSettings({ dock: 'left' }).dock, 'left');
});

test('过长的 hotkey 回退默认值而不是截断', () => {
  // 截断出来的加速键串是个语法错误的东西，注册必然失败；
  // 回退默认值至少是「能用的那一组」。
  const s = sanitizeSettings({ hotkey: 'Control+Shift+'.padEnd(200, 'A') });
  assert.equal(s.hotkey, 'Control+Shift+D');
});

test('空的 hotkey 回退默认值', () => {
  assert.equal(sanitizeSettings({ hotkey: '' }).hotkey, 'Control+Shift+D');
  assert.equal(sanitizeSettings({ hotkey: '   ' }).hotkey, 'Control+Shift+D');
});
