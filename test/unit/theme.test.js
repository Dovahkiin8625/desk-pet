// 主题：设置里选的那一套，全应用都跟着它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES,
  DEFAULT_MODE,
  MODE_LABELS,
  DEFAULT_THEME,
  normalizeMode,
  resolveMode,
} from '../../src/shared/theme.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../src/main/settings.js';

test('明暗：三种模式，各有名字', () => {
  assert.deepEqual([...MODES], ['light', 'dark', 'system']);
  for (const mode of MODES) {
    assert.ok(MODE_LABELS[mode], `${mode} 没有名字`);
  }
});

test('明暗：认不出来的回默认值', () => {
  assert.equal(normalizeMode('dark'), 'dark');
  assert.equal(normalizeMode('system'), 'system');
  assert.equal(normalizeMode('深色'), DEFAULT_MODE);
  assert.equal(normalizeMode(undefined), DEFAULT_MODE);
  assert.equal(normalizeMode(null), DEFAULT_MODE);
});

test('明暗：「跟随系统」在主进程就定成浅色或深色', () => {
  assert.equal(resolveMode('system', true), 'dark');
  assert.equal(resolveMode('system', false), 'light');
  // 用户明确选的那一套不受系统影响。
  assert.equal(resolveMode('light', true), 'light');
  assert.equal(resolveMode('dark', false), 'dark');
});

test('设置：默认是浅色 + 默认主题', () => {
  assert.equal(DEFAULT_SETTINGS.mode, 'light');
  assert.equal(sanitizeSettings({}).mode, 'light');
  assert.equal(DEFAULT_SETTINGS.theme, DEFAULT_THEME);
});

test('设置：合法的明暗存得住', () => {
  for (const mode of MODES) {
    assert.equal(sanitizeSettings({ mode }).mode, mode);
  }
});

test('设置：非法的明暗回默认值，不把垃圾写进磁盘', () => {
  assert.equal(sanitizeSettings({ mode: '深色' }).mode, 'light');
  assert.equal(sanitizeSettings({ mode: 42 }).mode, 'light');
  assert.equal(sanitizeSettings({ mode: null }).mode, 'light');
});

test('设置：主题是主题 id（认不出来的由主进程退回第一个）', () => {
  assert.equal(sanitizeSettings({ theme: 'ink' }).theme, 'ink');
  assert.equal(sanitizeSettings({ theme: 42 }).theme, DEFAULT_THEME);
  assert.equal(sanitizeSettings({ theme: '' }).theme, DEFAULT_THEME);
});
