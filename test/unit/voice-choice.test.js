import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveVoiceId, applyVoiceChoice } from '../../src/shared/voiceChoice.js';

/**
 * 「音色」两个控件的优先级规则。
 *
 * 下拉框选常用音色，输入框填清单以外的 id。
 * 两个都在的时候算哪个——这条规则只写一遍，写在 shared/voiceChoice.js 里。
 */

const KNOWN = ['female-shaonv', 'female-yujie', 'Chinese (Mandarin)_News_Anchor'];

test('自定义框填了：它说了算', () => {
  assert.equal(resolveVoiceId('my-own-voice', 'female-yujie'), 'my-own-voice');
});

test('自定义框是空的：用下拉框选的', () => {
  assert.equal(resolveVoiceId('', 'female-yujie'), 'female-yujie');
});

test('自定义框只有空格：也算空的', () => {
  // 用户手滑敲了几个空格，不该把下拉框里的音色顶掉。
  assert.equal(resolveVoiceId('   ', 'female-yujie'), 'female-yujie');
});

test('自定义框和下拉框都空：没有音色', () => {
  assert.equal(resolveVoiceId('', ''), '');
  assert.equal(resolveVoiceId(null, undefined), '');
});

test('回填：存的 id 在清单里 → 下拉框选它，自定义框留空', () => {
  const r = applyVoiceChoice('female-yujie', KNOWN);
  assert.equal(r.select, 'female-yujie');
  assert.equal(r.custom, '');
});

test('回填：存的 id 不在清单里 → 自定义框显示它', () => {
  // 用户自己填过一个清单里没有的 id：它得留在屏幕上，不能被悄悄换成别的音色。
  const r = applyVoiceChoice('my-own-voice', KNOWN);
  assert.equal(r.custom, 'my-own-voice');
  assert.equal(r.select, KNOWN[0]);
});

test('回填：存的 id 是空的 → 自定义框空着，下拉框用第一项', () => {
  const r = applyVoiceChoice('', KNOWN);
  assert.equal(r.custom, '');
  assert.equal(r.select, KNOWN[0]);
});

test('回填 + 生效：算出来还是原来那个音色', () => {
  for (const id of [...KNOWN, 'my-own-voice', '']) {
    const { custom, select } = applyVoiceChoice(id, KNOWN);
    const effective = resolveVoiceId(custom, select);
    if (id) assert.equal(effective, id, `回填后变成了 ${effective}`);
  }
});
