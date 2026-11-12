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

test('流式：括号里的禁词不留悬空的左括号', () => {
  const f = createSpeechFilter({ toolNames: [] });
  const all = f.push('我看了一下（') + f.push('工具）') + f.finish();
  assert.equal(all, sanitizeSpeech('我看了一下（工具）'));
  assert.equal(all, '我看了一下');
});

test('流式：收尾只能收一次', () => {
  const f = createSpeechFilter({ toolNames: [] });
  f.push('工具');
  assert.equal(f.finish(), SPEECH_FALLBACK);
  assert.equal(f.finish(), '');
});

test('流式：text 是已经吐给上层的那段话', () => {
  const f = createSpeechFilter({ toolNames: [] });
  const a = f.push('你好');
  const b = f.push('（工具）');
  assert.equal(f.text, a + b);
  assert.equal(f.text, '你好');
});

test('收拾阶段不许造出新的禁词', () => {
  assert.equal(sanitizeSpeech('后 台任务'), '这件事');
  assert.ok(!sanitizeSpeech('后 台任务').includes('后台'));
  assert.equal(sanitizeSpeech('（后 台任务）'), '（这件事）');
});

test('正常文本里的空格不被吃掉', () => {
  assert.equal(sanitizeSpeech('你好 世界'), '你好 世界');
  assert.equal(sanitizeSpeech('我看了一下（工具）'), '我看了一下');
});

test('落单的括号被去掉', () => {
  assert.equal(sanitizeSpeech('好的）'), '好的');
  assert.equal(sanitizeSpeech('（好的'), '（好的');
});

test('流式：切掉的尾巴不留空格，删掉的括号不留残骸', () => {
  const f = createSpeechFilter({});
  const all = f.push('后 后台 ') + f.finish();
  assert.equal(all, sanitizeSpeech('后 后台 '));
  const g = createSpeechFilter({});
  const all2 = g.push('后后（）后') + g.finish();
  assert.equal(all2, sanitizeSpeech('后后（）后'));
});

test('流式：任意切分点下累计文本等于整段结果', () => {
  const samples = [
    '我看了一下（工具）',
    '我看了一下（后台任务）',
    '我看了一下（fs.read）',
    '（工具）',
    '后 台任务',
    '我派了个后台任务',
    '好的',
  ];
  for (const s of samples) {
    const whole = sanitizeSpeech(s, { toolNames: ['fs.read'] });
    for (let i = 0; i <= s.length; i += 1) {
      const f = createSpeechFilter({ toolNames: ['fs.read'] });
      const all = f.push(s.slice(0, i)) + f.push(s.slice(i)) + f.finish();
      assert.equal(all, whole, `样本「${s}」切在 ${i} 处`);
    }
    const g = createSpeechFilter({ toolNames: ['fs.read'] });
    let perChar = '';
    for (const ch of s) perChar += g.push(ch);
    perChar += g.finish();
    assert.equal(perChar, whole, `样本「${s}」逐字流`);
  }
});

/**
 * 穷举：人想的样本覆盖不全，这里的 oracle 是机械的。
 *
 * 字母表取「后 台 工 具 （ ） 空格」——都是可能拼出禁词或影响清理的字符；
 * 长度 ≤4 的全部字符串（7 + 49 + 343 + 2401 = 2800 个）× 全部 2 段切分 + 逐字流。
 *
 * 两条断言：
 * - 任何时刻已吐出的文字里都没有禁词（这是硬要求）；
 * - 流式累计 === 整段 sanitizeSpeech（这是范围内的要求）。
 */
test('穷举：禁词不会在流里漏出去，累计文本等于整段结果', () => {
  const alphabet = ['后', '台', '工', '具', '（', '）', ' '];
  const forbidden = [
    '后台任务', '后台的事', '派出任务', '后台', '派单', '派发', '派出',
    '任务', '派了个', '工具', '插件', 'MCP', '<<META>>',
  ];
  const patterns = forbidden.map((word) => {
    const body = /^[\x20-\x7e]+$/.test(word)
      ? word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : [...word].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]*');
    return new RegExp(body);
  });
  const leaks = (text) => patterns.some((re) => re.test(text));

  const all = [];
  const build = (prefix, depth) => {
    if (prefix) all.push(prefix);
    if (!depth) return;
    for (const ch of alphabet) build(prefix + ch, depth - 1);
  };
  build('', 4);

  for (const s of all) {
    const whole = sanitizeSpeech(s);
    assert.ok(!leaks(whole), `整段结果漏出禁词：${JSON.stringify(s)} → ${JSON.stringify(whole)}`);

    const chunkings = [[...s]];
    for (let i = 0; i <= s.length; i += 1) chunkings.push([s.slice(0, i), s.slice(i)]);
    for (let i = 0; i <= s.length; i += 1) {
      for (let j = i; j <= s.length; j += 1) {
        chunkings.push([s.slice(0, i), s.slice(i, j), s.slice(j)]);
      }
    }
    for (const parts of chunkings) {
      const f = createSpeechFilter({});
      let acc = '';
      for (const part of parts) {
        acc += f.push(part);
        assert.ok(!leaks(acc), `流式中途漏出禁词：${JSON.stringify(s)} → ${JSON.stringify(acc)}`);
      }
      acc += f.finish();
      assert.ok(!leaks(acc), `流式收尾漏出禁词：${JSON.stringify(s)} → ${JSON.stringify(acc)}`);
      assert.equal(acc, whole, `流式累计不等于整段：${JSON.stringify(s)}`);
    }
  }
});
