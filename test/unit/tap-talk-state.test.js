import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeAssistant, DEFAULT_ASSISTANT } from '../../src/main/assistant/state.js';
import { DEFAULT_TAP_LINES } from '../../src/shared/assistant.js';
import { MAX_TAP_LINES, MAX_TAP_LINE_LENGTH } from '../../src/shared/tapVoice.js';

/**
 * 「点桌宠时说话」这一组偏好的清洗规则。
 *
 * 磁盘上的 assistant.json 是用户与旧版本写出来的：
 * 形状可能对不上、台词可能超长超多——这里保证内存里的状态永远是合法的。
 */

test('默认：点桌宠时说话开着，模型自带声音关着，台词是内置的那几句', () => {
  const state = sanitizeAssistant({});
  assert.equal(state.tapTalk.enabled, true);
  assert.equal(state.tapTalk.modelSound, false);
  assert.deepEqual(state.tapTalk.lines, [...DEFAULT_TAP_LINES]);
  assert.ok(DEFAULT_TAP_LINES.length > 0, '得有几句内置台词');
});

test('默认状态里也有 tapTalk', () => {
  assert.ok(DEFAULT_ASSISTANT.tapTalk, '默认状态里得有一份 tapTalk');
  assert.equal(DEFAULT_ASSISTANT.tapTalk.enabled, true);
  assert.equal(DEFAULT_ASSISTANT.tapTalk.modelSound, false);
});

test('清洗：开关按布尔取，台词去空去重', () => {
  const state = sanitizeAssistant({
    tapTalk: { enabled: false, modelSound: true, lines: ['你好', '  ', '你好', '世界'] },
  });
  assert.equal(state.tapTalk.enabled, false);
  assert.equal(state.tapTalk.modelSound, true);
  assert.deepEqual(state.tapTalk.lines, ['你好', '世界']);
});

test('清洗：台词最多 20 句、每句最多 60 字', () => {
  const many = Array.from({ length: 50 }, (_, i) => `第${i}句`);
  const state = sanitizeAssistant({ tapTalk: { lines: many } });
  assert.equal(state.tapTalk.lines.length, MAX_TAP_LINES);

  const long = sanitizeAssistant({ tapTalk: { lines: ['x'.repeat(200)] } });
  assert.equal(long.tapTalk.lines[0].length, MAX_TAP_LINE_LENGTH);
});

test('清洗：形状不对就退回默认', () => {
  const state = sanitizeAssistant({ tapTalk: '乱写' });
  assert.deepEqual(state.tapTalk.lines, [...DEFAULT_TAP_LINES]);

  const noLines = sanitizeAssistant({ tapTalk: { lines: '不是数组' } });
  assert.deepEqual(noLines.tapTalk.lines, [...DEFAULT_TAP_LINES]);
});
