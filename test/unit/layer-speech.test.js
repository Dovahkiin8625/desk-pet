import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSpeech, createSpeechFilter, SPEECH_FALLBACK } from '../../src/main/assistant/layer/speech.js';

/**
 * 话术过滤器（第二道防线）。
 *
 * 提示词让模型别把内部话术说出来，那是第一道；这里兜底——
 * 模型偶尔还是会漏一个词，用户看见「后台任务」四个字，
 * 整套「只有桌宠的存在」的设定就破了。
 */

test('内部话术被换掉', () => {
  assert.equal(sanitizeSpeech('我派了个后台任务'), '我去做了这件事');
  // 表里「任务」→「事情」，所以是「这个事情」；计划里的期望值「这件事我记下了」与表冲突。
  assert.equal(sanitizeSpeech('这个任务我记下了'), '这个事情我记下了');
  assert.equal(sanitizeSpeech('我派单了'), '我安排了');
});

test('工具名按名字精确替换，文件路径不误伤', () => {
  assert.equal(sanitizeSpeech('我用 fs.read 读的', { toolNames: ['fs.read'] }), '我用这件事读的');
  assert.equal(sanitizeSpeech('文件是 a.mp4', { toolNames: ['fs.read'] }), '文件是 a.mp4');
});

test('删空了给兜底句', () => {
  assert.equal(sanitizeSpeech('工具'), '这个我记下了。');
  assert.equal(sanitizeSpeech('插件'), SPEECH_FALLBACK);
});

test('META 标记不许出现在气泡里', () => {
  assert.equal(sanitizeSpeech('说完了<<META>>'), '说完了');
  assert.equal(sanitizeSpeech('<<META>>'), SPEECH_FALLBACK);
});

test('删掉留下的空括号与多余标点被收拾掉', () => {
  assert.equal(sanitizeSpeech('我看了一下（工具）'), '我看了一下');
  assert.equal(sanitizeSpeech('好的，'), '好的');
});

test('流式：禁词被切成两半时不会漏出去', () => {
  const f = createSpeechFilter({ toolNames: ['fs.read'] });
  const a = f.push('我用 fs.re');
  const b = f.push('ad 读完了');
  const c = f.finish();
  const all = a + b + c;
  assert.ok(!all.includes('fs.read'), `半个词漏出去了：${all}`);
  assert.ok(all.includes('读完了'));
});

test('流式：普通文本逐段吐出来，不整段憋着', () => {
  const f = createSpeechFilter({ toolNames: [] });
  assert.equal(f.push('你好'), '你好');
  assert.equal(f.push('啊'), '啊');
});

test('流式：话术被切成两半时也不会漏出去', () => {
  const f = createSpeechFilter({ toolNames: [] });
  const all = f.push('我派了个后台任') + f.push('务') + f.finish();
  assert.ok(!all.includes('后台'), `半个词漏出去了：${all}`);
  assert.ok(!all.includes('任务'), `半个词漏出去了：${all}`);
  assert.equal(all, '我去做了这件事');
});

test('流式：没说完时不许冒出兜底句', () => {
  const f = createSpeechFilter({ toolNames: [] });
  assert.equal(f.push('工具'), '');
  assert.equal(f.finish(), SPEECH_FALLBACK);
});

test('流式：已经吐出去的字后面不会被改写', () => {
  const f = createSpeechFilter({ toolNames: ['fs.read'] });
  const a = f.push('我用 fs.read 读了');
  assert.equal(a, '我用这件事读了');
  const b = f.push('文件');
  assert.equal(b, '文件');
  assert.equal(f.text, '我用这件事读了文件');
});
