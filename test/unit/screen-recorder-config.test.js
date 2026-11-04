import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CONFIG,
  MODES,
  FORMATS,
  configPath,
  normalizeConfig,
  readConfig,
  writeConfig,
} from '../../plugins/screen-recorder/lib/config.js';
import { recordingFileName, uniquePath } from '../../plugins/screen-recorder/lib/naming.js';

test('规整后的配置：认得的字段留下，认不出的退回默认', () => {
  const c = normalizeConfig({
    mode: 'region',
    format: 'gif',
    mic: 'yes',
    speaker: false,
    fps: 999,
    gifWidth: 10,
    gifFps: 60,
    hotkey: '  Control+Shift+R  ',
    outputDir: 123,
  });
  assert.equal(c.mode, 'region');
  assert.equal(c.format, 'gif');
  assert.equal(c.mic, true, '真值都当开');
  assert.equal(c.speaker, false);
  assert.equal(c.fps, 60, '帧率夹到上限 60');
  assert.equal(c.gifWidth, 160, 'GIF 宽度夹到下限 160');
  assert.equal(c.gifFps, 30, 'GIF 帧率夹到上限 30');
  assert.equal(c.hotkey, 'Control+Shift+R', '快捷键两边空白去掉');
  assert.equal(c.outputDir, '', '不是字符串就当没设');
});

test('认不出的模式与格式退回默认', () => {
  const c = normalizeConfig({ mode: '投影仪', format: 'avi' });
  assert.ok(MODES.includes(c.mode));
  assert.ok(FORMATS.includes(c.format));
  assert.equal(c.mode, DEFAULT_CONFIG.mode);
  assert.equal(c.format, DEFAULT_CONFIG.format);
});

test('配置读写往返：写完再读回来一模一样', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    const saved = await writeConfig(dir, { mode: 'window', mic: true, outputDir: 'D:\\录屏' });
    assert.equal(saved.mode, 'window');
    const raw = JSON.parse(await readFile(configPath(dir), 'utf8'));
    assert.equal(raw.mode, 'window');
    assert.equal(raw.mic, true);
    const back = await readConfig(dir);
    assert.equal(back.outputDir, 'D:\\录屏');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('配置读不到时退回默认值，不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    await writeFile(configPath(dir), '{ 这不是 JSON', 'utf8');
    const c = await readConfig(dir);
    assert.equal(c.mode, DEFAULT_CONFIG.mode);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写不留临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    await writeConfig(dir, { mode: 'screen' });
    const raw = await readFile(configPath(dir), 'utf8');
    assert.ok(!raw.includes('.tmp'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件名：录屏_年月日_时分秒', () => {
  const d = new Date(2026, 10, 4, 23, 15, 30);
  assert.equal(recordingFileName(d, 'mp4'), '录屏_20261104_231530.mp4');
  assert.equal(recordingFileName(d, 'gif'), '录屏_20261104_231530.gif');
});

test('重名时自动加 _2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-rec-'));
  try {
    const name = recordingFileName(new Date(2026, 10, 4, 23, 15, 30), 'mp4');
    const first = await uniquePath(dir, name);
    assert.equal(first, join(dir, name));
    await writeFile(first, 'x');
    const second = await uniquePath(dir, name);
    assert.equal(second, join(dir, '录屏_20261104_231530_2.mp4'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
