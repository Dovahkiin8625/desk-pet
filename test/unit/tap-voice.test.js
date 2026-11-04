import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseTapLines,
  pickTapLine,
  decideTapVoice,
  buildTapVoicePayload,
  tapTalkNeedsPrewarm,
  TAP_VOICE_COOLDOWN_MS,
} from '../../src/shared/tapVoice.js';

/**
 * 「点桌宠时的声音」的池子逻辑。
 *
 * 池子里有两种东西：
 * - **生成台词**：设置里那几行字，用设置中的音色预先合成好；
 * - **模型自带声音**：Live2D 动作里带的那个 wav（Haru 的 TapBody）。
 *
 * 抽签在**渲染层**做：静音模型声音的决定必须赶在动作启动之前，
 * 而动作是点击那一刻同步触发的——主进程来不及回话。
 * 所以这里必须是纯函数，主进程只负责把「池子里有什么」推下去。
 */

test('台词解析：按行拆、去空行、去重', () => {
  const lines = parseTapLines('  你好  \n\n  世界 \n你好\n   \n再见');
  assert.deepEqual(lines, ['你好', '世界', '再见']);
});

test('台词解析：上限是 20 句、每句 60 字', () => {
  const many = Array.from({ length: 30 }, (_, i) => `第${i}句`).join('\n');
  assert.equal(parseTapLines(many).length, 20);

  const long = 'x'.repeat(100);
  assert.equal(parseTapLines(long)[0].length, 60);
});

test('台词解析：空输入得到空数组', () => {
  assert.deepEqual(parseTapLines(''), []);
  assert.deepEqual(parseTapLines(null), []);
  assert.deepEqual(parseTapLines(undefined), []);
});

test('挑台词：从池子里挑一句，索引不会越界', () => {
  const lines = ['a', 'b', 'c'];
  assert.equal(pickTapLine(lines, () => 0), 'a');
  assert.equal(pickTapLine(lines, () => 0.99), 'c');
  // random() 返回 1 是越界的（数学上不该发生，但要防一手）。
  assert.equal(pickTapLine(lines, () => 1), 'c');
  assert.equal(pickTapLine([], () => 0), '');
  assert.equal(pickTapLine(null, () => 0), '');
});

test('池子里只有台词：每次点击都念台词', () => {
  const decision = decideTapVoice({
    voiceEnabled: true,
    modelSound: false,
    lineCount: 3,
    cooldownMs: 3000,
    now: 10000,
    lastVoiceAt: null,
    random: () => 0.999,
  });
  assert.equal(decision, 'voice');
});

test('池子里有台词也有模型声音：按 1/(N+1) 抽', () => {
  const base = {
    voiceEnabled: true,
    modelSound: true,
    lineCount: 3,
    cooldownMs: 3000,
    now: 10000,
    lastVoiceAt: null,
  };
  // random() 小于 1/4 → 抽中模型自带声音。
  assert.equal(decideTapVoice({ ...base, random: () => 0.1 }), 'model');
  // 大于 1/4 → 抽中台词。
  assert.equal(decideTapVoice({ ...base, random: () => 0.5 }), 'voice');
});

test('冷却期内不念台词：模型声音开着就让模型自己出声', () => {
  const base = {
    voiceEnabled: true,
    lineCount: 3,
    cooldownMs: 3000,
    now: 10000,
    lastVoiceAt: 9000,
    random: () => 0.999,
  };
  assert.equal(decideTapVoice({ ...base, modelSound: true }), 'model');
  assert.equal(decideTapVoice({ ...base, modelSound: false }), 'none');
});

test('冷却期过了：又能念台词了', () => {
  const decision = decideTapVoice({
    voiceEnabled: true,
    modelSound: true,
    lineCount: 3,
    cooldownMs: 3000,
    now: 12000,
    lastVoiceAt: 9000,
    random: () => 0.999,
  });
  assert.equal(decision, 'voice');
});

test('不能念台词时（没 Key / 没开）：退回模型自带的声音', () => {
  const base = {
    voiceEnabled: false,
    lineCount: 3,
    cooldownMs: 3000,
    now: 10000,
    lastVoiceAt: null,
    random: () => 0.999,
  };
  // 模型自带的声音是**兜底**：生成的语音顶不上来时，它照旧响。
  // （不然没配 Key 的用户点了桌宠就没声音了——那是平白少一个声音。）
  assert.equal(decideTapVoice({ ...base, modelSound: true }), 'model');
  assert.equal(decideTapVoice({ ...base, modelSound: false }), 'model');
});

test('台词池是空的：不能念台词，模型自带的声音顶上', () => {
  const decision = decideTapVoice({
    voiceEnabled: true,
    modelSound: true,
    lineCount: 0,
    cooldownMs: 3000,
    now: 10000,
    lastVoiceAt: null,
    random: () => 0.999,
  });
  assert.equal(decision, 'model');
});

test('要不要重新预生成：音色、语速、台词变了都要重新生成', () => {
  const before = {
    tts: { voiceId: 'a', speed: 1, model: 'speech-02-hd', vol: 1, pitch: 0 },
    tapTalk: { enabled: true, modelSound: false, lines: ['一', '二'] },
  };
  const changed = (tts, tapTalk) => ({
    tts: { ...before.tts, ...tts },
    tapTalk: { ...before.tapTalk, ...tapTalk },
  });

  assert.equal(tapTalkNeedsPrewarm(before, changed({ voiceId: 'b' })), true, '换音色');
  assert.equal(tapTalkNeedsPrewarm(before, changed({ speed: 1.5 })), true, '换语速');
  assert.equal(tapTalkNeedsPrewarm(before, changed({ model: 'speech-02' })), true, '换模型');
  assert.equal(tapTalkNeedsPrewarm(before, changed({}, { lines: ['一', '三'] })), true, '换台词');
  assert.equal(tapTalkNeedsPrewarm(before, changed({}, { enabled: false })), true, '关掉开关');
});

test('要不要重新预生成：跟音频无关的改动不用重新生成', () => {
  const before = {
    tts: { voiceId: 'a', speed: 1, model: 'speech-02-hd', vol: 1, pitch: 0 },
    tapTalk: { enabled: true, modelSound: false, lines: ['一', '二'] },
  };
  // 「模型自带的声音」开关只影响**抽签**，不影响音频。
  const after = {
    tts: { ...before.tts },
    tapTalk: { ...before.tapTalk, modelSound: true },
  };
  assert.equal(tapTalkNeedsPrewarm(before, after), false);
  assert.equal(tapTalkNeedsPrewarm(before, before), false);
});

test('推给渲染层的池子成分：能不能念台词取决于开关与 Key', () => {
  const tapTalk = { enabled: true, modelSound: true, lines: ['a', 'b'] };
  const payload = buildTapVoicePayload({ tapTalk, ttsEnabled: true, hasKey: true });
  assert.equal(payload.voiceEnabled, true);
  assert.equal(payload.modelSound, true);
  assert.equal(payload.lineCount, 2);
  assert.equal(payload.cooldownMs, TAP_VOICE_COOLDOWN_MS);

  // 没 Key → 念不了台词。
  assert.equal(
    buildTapVoicePayload({ tapTalk, ttsEnabled: true, hasKey: false }).voiceEnabled,
    false
  );
  // 语音总开关关着 → 念不了。
  assert.equal(
    buildTapVoicePayload({ tapTalk, ttsEnabled: false, hasKey: true }).voiceEnabled,
    false
  );
  // 「点击桌宠时说话」关着 → 念不了。
  assert.equal(
    buildTapVoicePayload({
      tapTalk: { ...tapTalk, enabled: false },
      ttsEnabled: true,
      hasKey: true,
    }).voiceEnabled,
    false
  );
});
