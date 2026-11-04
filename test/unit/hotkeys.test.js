import test from 'node:test';
import assert from 'node:assert/strict';

import { HOTKEY_SLOTS, HOTKEY_SLOT_KEYS, getHotkeySlot } from '../../src/shared/hotkeys.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../../src/main/settings.js';

test('槽位清单：两个快捷键，字段名固定', () => {
  assert.deepEqual(HOTKEY_SLOT_KEYS, ['hotkey', 'panelHotkey']);
  // 槽位名是设置文件里的字段名：少一个字段，主进程就少注册一个快捷键。
  for (const slot of HOTKEY_SLOTS) {
    assert.equal(typeof slot.key, 'string');
    assert.equal(typeof slot.label, 'string');
    assert.equal(typeof slot.allowEmpty, 'boolean');
  }
});

test('默认值：呼出/隐藏桌宠有组合，唤醒输入框不设', () => {
  assert.equal(DEFAULT_SETTINGS.hotkey, 'Control+Shift+D');
  // 「唤醒输入框」默认**不设**：多抢一个全局组合不是用户要求的行为。
  assert.equal(DEFAULT_SETTINGS.panelHotkey, '');
});

test('getHotkeySlot：认得出槽位，认不出就返回 null', () => {
  assert.equal(getHotkeySlot('panelHotkey')?.key, 'panelHotkey');
  assert.equal(getHotkeySlot('hotkey')?.key, 'hotkey');
  // 槽位名是渲染层传进来的，陌生名字不能把设置写坏。
  assert.equal(getHotkeySlot('nope'), null);
  assert.equal(getHotkeySlot(undefined), null);
  assert.equal(getHotkeySlot(42), null);
});

test('sanitizeSettings：合法的输入框快捷键原样留下', () => {
  const out = sanitizeSettings({ panelHotkey: 'Control+Shift+F' });
  assert.equal(out.panelHotkey, 'Control+Shift+F');
});

test('sanitizeSettings：空的输入框快捷键是合法的（= 不设）', () => {
  const out = sanitizeSettings({ panelHotkey: '' });
  assert.equal(out.panelHotkey, '');
});

test('sanitizeSettings：空白的输入框快捷键按「不设」处理', () => {
  const out = sanitizeSettings({ panelHotkey: '   ' });
  assert.equal(out.panelHotkey, '');
});

test('sanitizeSettings：非法值一律回退默认，绝不抛错', () => {
  // 太长：回退默认值而不是截断——截断出来的加速键串注册必然失败。
  assert.equal(sanitizeSettings({ panelHotkey: 'x'.repeat(65) }).panelHotkey, '');
  // 不是字符串：忽略。
  assert.equal(sanitizeSettings({ panelHotkey: 123 }).panelHotkey, '');
  assert.equal(sanitizeSettings({ panelHotkey: null }).panelHotkey, '');
  assert.equal(sanitizeSettings({ panelHotkey: {} }).panelHotkey, '');
});

test('sanitizeSettings：「呼出/隐藏桌宠」那个不能为空', () => {
  // 空了就没有召回手段：回退默认值。
  assert.equal(sanitizeSettings({ hotkey: '' }).hotkey, 'Control+Shift+D');
  assert.equal(sanitizeSettings({ hotkey: '   ' }).hotkey, 'Control+Shift+D');
  assert.equal(sanitizeSettings({ hotkey: 42 }).hotkey, 'Control+Shift+D');
});

test('sanitizeSettings：两个快捷键互不影响', () => {
  const out = sanitizeSettings({ hotkey: 'Alt+K', panelHotkey: 'Alt+J' });
  assert.equal(out.hotkey, 'Alt+K');
  assert.equal(out.panelHotkey, 'Alt+J');
});
