import test from 'node:test';
import assert from 'node:assert/strict';

import { SUGGESTED_VOICES, voiceLabel } from '../../src/main/assistant/tts/voices.js';
import { DEFAULT_TTS } from '../../src/shared/assistant.js';

/**
 * 音色建议清单的形状检查。
 *
 * 清单里的 id 都是**用真实接口验过**的（见 scripts/verify-voices.mjs），
 * 这条测试管不了「验没验」，只管形状——
 * 形状不对的话，下拉框里就会出现空白项或者重复项。
 */

test('建议清单里没有重复的 id', () => {
  const ids = SUGGESTED_VOICES.map((v) => v.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], `重复的 id：${dup.join('、')}`);
});

test('每条建议都有非空标签', () => {
  for (const v of SUGGESTED_VOICES) {
    assert.equal(typeof v.label, 'string', `${v.id} 的 label 不是字符串`);
    assert.notEqual(v.label.trim(), '', `${v.id} 的 label 是空的`);
  }
});

test('默认音色在建议清单里', () => {
  // 不在的话，用户第一次打开设置看到的是空的建议列表，
  // 而默认音色又不在里面——等于凭空多出一个「隐藏选项」。
  const ids = SUGGESTED_VOICES.map((v) => v.id);
  assert.ok(ids.includes(DEFAULT_TTS.voiceId), `${DEFAULT_TTS.voiceId} 不在建议清单里`);
});

test('voiceLabel：已知 id 给中文标签', () => {
  assert.equal(voiceLabel('female-shaonv'), '少女音色');
});

test('voiceLabel：未知 id 回显 id 本身', () => {
  // 用户可以自己填任何合法的 voice_id（清单不是白名单），
  // 这种 id 也得有能显示的名字。
  assert.equal(voiceLabel('some-new-voice-id'), 'some-new-voice-id');
});
