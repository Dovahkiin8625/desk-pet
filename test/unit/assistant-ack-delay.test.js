// 「先应一声」可配置的状态测试。
//
// 这个设置有两个坑，都得在这儿钉住：
//   1. **老文件里没有这两个字段**——Boolean(undefined) 是 false，
//      直接 Boolean() 会把默认开启的应答悄悄关掉；
//   2. **磁盘上的值可能被手改过**——等待时长要夹住，
//      否则一个负数会让计时器立刻炸出应答，一个超大值会让它永远不应。
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeAssistant, DEFAULT_ASSISTANT } from '../../src/main/assistant/state.js';
import {
  DEFAULT_ACK_DELAY_MS,
  MAX_ACK_DELAY_MS,
  ACK_DELAY_PRESETS,
  ACK_DELAY_OFF,
  ackPrefsFromValue,
  ackValueFromPrefs,
} from '../../src/shared/assistant.js';

test('应答：默认是开着、等 1 秒', () => {
  const state = sanitizeAssistant({});
  assert.equal(state.llm.ackEnabled, true);
  assert.equal(state.llm.ackDelayMs, DEFAULT_ACK_DELAY_MS);
});

test('应答：老版本写出来的文件里没有这两个字段，要沿用默认值', () => {
  const state = sanitizeAssistant({ llm: { enabled: true, model: 'MiniMax-Text-01' } });
  assert.equal(state.llm.ackEnabled, true, '老文件把应答关掉了');
  assert.equal(state.llm.ackDelayMs, DEFAULT_ACK_DELAY_MS);
});

test('应答：可以关掉', () => {
  const state = sanitizeAssistant({ llm: { ackEnabled: false } });
  assert.equal(state.llm.ackEnabled, false);
});

test('应答：等待时长按写下来的值来', () => {
  for (const preset of ACK_DELAY_PRESETS) {
    const state = sanitizeAssistant({ llm: { ackDelayMs: preset.value } });
    assert.equal(state.llm.ackDelayMs, preset.value, `预设 ${preset.label} 没生效`);
  }
});

test('应答：等待时长夹在 [0, 上限] 里', () => {
  assert.equal(sanitizeAssistant({ llm: { ackDelayMs: -5 } }).llm.ackDelayMs, 0);
  assert.equal(
    sanitizeAssistant({ llm: { ackDelayMs: 999999 } }).llm.ackDelayMs,
    MAX_ACK_DELAY_MS
  );
});

test('应答：等待时长不是数字时退回默认值', () => {
  assert.equal(sanitizeAssistant({ llm: { ackDelayMs: '胡说' } }).llm.ackDelayMs, DEFAULT_ACK_DELAY_MS);
  assert.equal(sanitizeAssistant({ llm: { ackDelayMs: null } }).llm.ackDelayMs, DEFAULT_ACK_DELAY_MS);
});

test('应答：默认状态的常量与共享契约一致', () => {
  assert.equal(DEFAULT_ASSISTANT.llm.ackDelayMs, DEFAULT_ACK_DELAY_MS);
  assert.equal(DEFAULT_ASSISTANT.llm.ackEnabled, true);
});

test('应答：下拉框的值与状态对得上', () => {
  // 「关闭」不是时长，是另一件事。
  assert.deepEqual(ackPrefsFromValue(ACK_DELAY_OFF), {
    ackEnabled: false,
    ackDelayMs: DEFAULT_ACK_DELAY_MS,
  });
  assert.equal(ackValueFromPrefs(false, 2000), ACK_DELAY_OFF);

  for (const preset of ACK_DELAY_PRESETS) {
    assert.deepEqual(ackPrefsFromValue(String(preset.value)), {
      ackEnabled: true,
      ackDelayMs: preset.value,
    });
    assert.equal(ackValueFromPrefs(true, preset.value), String(preset.value));
  }
});

test('应答：下拉框的值认不出来时退回默认值', () => {
  const prefs = ackPrefsFromValue('胡说');
  assert.equal(prefs.ackEnabled, true);
  assert.equal(prefs.ackDelayMs, DEFAULT_ACK_DELAY_MS);
});
