import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveExplicitMemory, mergeFacts, normalizeMemory, pickMemories } from '../../src/main/assistant/chat/memory.js';

test('记忆的两种形态都认：对象与裸字符串', () => {
  assert.deepEqual(normalizeMemory({ text: ' 用户喜欢喝美式 ', kind: 'preference' }), {
    text: '用户喜欢喝美式',
    kind: 'preference',
  });
  // 不认识的 kind 当 fact：内容不能因为类型名不对就丢了。
  assert.deepEqual(normalizeMemory({ text: '用户住南京', kind: '瞎写的' }), {
    text: '用户住南京',
    kind: 'fact',
  });
  assert.deepEqual(normalizeMemory('用户喜欢喝美式'), { text: '用户喜欢喝美式', kind: 'fact' });
  assert.equal(normalizeMemory({ text: '   ' }), null);
  assert.equal(normalizeMemory(null), null);
});

test('临时的事不记', () => {
  const kept = pickMemories([
    { text: '用户今天要交周报', kind: 'fact' },
    { text: '用户刚才问了个问题', kind: 'fact' },
    { text: '用户对花生过敏', kind: 'fact' },
  ]);
  assert.deepEqual(kept, ['用户对花生过敏']);
});

test('重要的事才记，用户明确要求的一定记', () => {
  const kept = pickMemories([
    { text: '用户对花生过敏', kind: 'preference' },
    { text: '用户每周三要复盘', kind: 'plan' },
  ]);
  assert.deepEqual(kept, ['用户对花生过敏', '用户每周三要复盘']);
});

test('用户说了「记住…」而模型没报时，我们自己记上', () => {
  const kept = pickMemories([], { userText: '记住明天下午三点要交周报' });
  assert.deepEqual(kept, ['用户要求记住：明天下午三点要交周报']);
});

test('模型已经报了显式记忆时，不重复兜底', () => {
  const kept = pickMemories([{ text: '用户要求记住：明天下午三点交周报', kind: 'explicit' }], {
    userText: '记住明天下午三点要交周报',
  });
  assert.equal(kept.length, 1);
  assert.match(kept[0], /^用户要求记住：/);
});

test('指代含糊的「记住刚才说的」不记', () => {
  assert.equal(deriveExplicitMemory('记住刚才说的'), '');
  assert.equal(deriveExplicitMemory('记住那个'), '');
  assert.equal(deriveExplicitMemory('今天天气不错'), '');
});

test('「帮我记一下」这种带助词的说法要切对', () => {
  assert.equal(deriveExplicitMemory('帮我记一下我周三有约'), '用户要求记住：我周三有约');
  assert.equal(deriveExplicitMemory('记住明天下午三点交周报'), '用户要求记住：明天下午三点交周报');
  assert.equal(deriveExplicitMemory('你记住一下'), '');
});

test('「笔记下来了」里的「记下」不是请求', () => {
  assert.equal(deriveExplicitMemory('我把笔记下来了'), '');
});

test('一轮最多记两条，模型报多了要砍', () => {
  const kept = pickMemories([
    { text: '用户喜欢美式', kind: 'preference' },
    { text: '用户喜欢拿铁', kind: 'preference' },
    { text: '用户对花生过敏', kind: 'fact' },
  ]);
  assert.equal(kept.length, 2);
});

test('合并记忆时去重', () => {
  const facts = mergeFacts(['用户喜欢美式'], ['用户喜欢美式', '用户喜欢拿铁']);
  assert.deepEqual(facts, ['用户喜欢美式', '用户喜欢拿铁']);
});
