import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  buildChatMessages,
  parseReply,
  createStreamSplitter,
  META_MARKER,
} from '../../src/main/assistant/chat/prompt.js';

/**
 * 人设、提示词与回复解析。
 *
 * 解析要能认四种形态，而且**元数据坏了不能丢掉正文**——
 * 丢情绪比丢回复好得多。
 */

test('标准形态：正文 + 标记 + JSON', () => {
  const r = parseReply(`你好呀，我在这儿呢\n\n${META_MARKER}{"emotion":"happy","mood":5,"memories":["用户叫小明"]}`);
  assert.equal(r.text, '你好呀，我在这儿呢');
  assert.equal(r.emotion, 'happy');
  assert.equal(r.mood, 5);
  assert.deepEqual(r.memories, ['用户叫小明']);
});

test('模型没听话：整个回复就是一个 JSON 对象', () => {
  const r = parseReply('{"text":"你好","emotion":"shy","mood":-3,"memories":[]}');
  assert.equal(r.text, '你好');
  assert.equal(r.emotion, 'shy');
  assert.equal(r.mood, -3);
});

test('模型没听话：JSON 用了 reply 字段', () => {
  const r = parseReply('{"reply":"你好呀","emotion":"happy"}');
  assert.equal(r.text, '你好呀');
  assert.equal(r.emotion, 'happy');
});

test('模型没听话：JSON 被代码块围栏包着', () => {
  const r = parseReply('```json\n{"text":"你好","emotion":"happy","mood":2}\n```');
  assert.equal(r.text, '你好');
  assert.equal(r.emotion, 'happy');
  assert.equal(r.mood, 2);
});

test('兜底：就是一段普通文字', () => {
  const r = parseReply('就是一句话');
  assert.equal(r.text, '就是一句话');
  assert.equal(r.emotion, 'neutral');
  assert.equal(r.mood, 0);
  assert.deepEqual(r.memories, []);
});

test('元数据坏了，正文仍然要保住', () => {
  const r = parseReply(`前半句${META_MARKER}{坏掉的 JSON`);
  assert.equal(r.text, '前半句');
  assert.equal(r.emotion, 'neutral');
  assert.deepEqual(r.memories, []);
});

test('未知的情绪退回 neutral（发错标签表情会静默失效）', () => {
  const r = parseReply(`正文${META_MARKER}{"emotion":"excited"}`);
  assert.equal(r.emotion, 'neutral');
  assert.equal(r.text, '正文');
});

test('心情增量被夹在 -10..10', () => {
  assert.equal(parseReply(`x${META_MARKER}{"mood":999}`).mood, 10);
  assert.equal(parseReply(`x${META_MARKER}{"mood":-999}`).mood, -10);
  assert.equal(parseReply(`x${META_MARKER}{"mood":"不是数字"}`).mood, 0);
});

test('记忆只留字符串、去掉空的、最多两条', () => {
  const r = parseReply(
    `x${META_MARKER}{"memories":["第一条","第二条","第三条","", 42]}`
  );
  assert.deepEqual(r.memories, ['第一条', '第二条']);
});

test('记忆不是数组就当没有', () => {
  assert.deepEqual(parseReply(`x${META_MARKER}{"memories":"不是数组"}`).memories, []);
});

test('系统提示词：含人设、记忆与输出契约', () => {
  const prompt = buildSystemPrompt({
    persona: { name: '小哈', style: '活泼但有点毒舌', backstory: '住在你的任务栏里' },
    facts: ['用户喜欢喝美式'],
    now: new Date('2026-11-02T15:04:00'),
  });
  assert.match(prompt, /小哈/);
  assert.match(prompt, /活泼但有点毒舌/);
  assert.match(prompt, /住在你的任务栏里/);
  assert.match(prompt, /用户喜欢喝美式/);
  assert.match(prompt, /META/);
  // 情绪标签要写全，少一个模型就可能挑一个渲染层不认的。
  for (const emotion of ['neutral', 'happy', 'shy', 'surprised', 'sad', 'angry', 'tired']) {
    assert.match(prompt, new RegExp(emotion));
  }
});

test('上下文：只带最近 12 条，最后一条是用户的话', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `第${i}条`,
  }));
  const messages = buildChatMessages({ history, userText: '在吗' });
  assert.equal(messages.length, 13, '12 条历史 + 1 条当前');
  assert.equal(messages[0].content, '第18条');
  assert.equal(messages[12].role, 'user');
  assert.equal(messages[12].content, '在吗');
});

test('上下文：角色映射对了', () => {
  const messages = buildChatMessages({
    history: [{ role: 'user', text: '你' }, { role: 'assistant', text: '我' }],
    userText: '在吗',
  });
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user']
  );
});

test('上下文：主动搭话时发的是触发语，不是用户的话', () => {
  const messages = buildChatMessages({ history: [], userText: '', trigger: 'proactive' });
  assert.match(messages[0].content, /主动搭话/);
});

test('流式分离器：只有可能是标记符的尾巴会被按住', () => {
  const splitter = createStreamSplitter();
  // 普通文字不用按住——不然短回复会一直憋着不出来。
  assert.equal(splitter.push('你好'), '你好');
  assert.equal(splitter.push('呀'), '呀');
  assert.equal(splitter.push('！世界'), '！世界');
  assert.equal(splitter.push(`${META_MARKER}{"emotion":"happy"}`), '', '元数据不显示');
  assert.equal(splitter.finish(), '', '元数据不显示');
  assert.match(splitter.text, /META/);
});

test('流式分离器：没有标记符时内容直接就显示出来了', () => {
  const splitter = createStreamSplitter();
  assert.equal(splitter.push('短'), '短');
  assert.equal(splitter.finish(), '', '没有剩下了');
  assert.equal(splitter.shown, '短');
});

test('流式分离器：标记符跨 chunk 也不会漏进正文', () => {
  const splitter = createStreamSplitter();
  assert.equal(splitter.push('正文'), '正文');
  assert.equal(splitter.push('<<MET'), '', '半截标记要按住');
  assert.equal(splitter.push('A>>{"emotion":"happy"}'), '');
  const shown = splitter.shown;
  assert.equal(shown, '正文');
  assert.ok(!shown.includes('META'));
});
