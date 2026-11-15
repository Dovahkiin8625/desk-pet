import test from 'node:test';
import assert from 'node:assert/strict';

import { buildResult, isNotable, resultLine, userReason } from '../../src/main/assistant/agent/result.js';

/**
 * 任务结果的结构化与送达。
 *
 * 干活的那层交出的是**结果**，送达路径用**模板**把它变成一句话——
 * 内部黑话漏不出去，成功与失败的句式也一致。
 */

test('buildResult：成功时把结论留下，失败原因清空', () => {
  const r = buildResult({ ok: true, title: '查视频', summary: '找到 3 个视频' });
  assert.equal(r.ok, true);
  assert.equal(r.summary, '找到 3 个视频');
  assert.equal(r.reason, '', '成功不该有失败原因');
});

test('buildResult：失败时结论清空，原因是给用户看的那句', () => {
  const r = buildResult({ ok: false, title: '查视频', summary: '找到 3 个视频', reason: '文件不在' });
  assert.equal(r.ok, false);
  assert.equal(r.summary, '');
  assert.equal(r.reason, '文件不在');
});

test('buildResult：结论太长会截断', () => {
  const r = buildResult({ ok: true, summary: '字'.repeat(300) });
  assert.ok(r.summary.length <= 121, `太长了：${r.summary.length}`);
  assert.match(r.summary, /…$/);
});

test('buildResult：事实与依据都收成数组', () => {
  const r = buildResult({ facts: '一个事实', evidence: ['F:\\video\\a.mp4'] });
  assert.deepEqual(r.facts, ['一个事实']);
  assert.deepEqual(r.evidence, ['F:\\video\\a.mp4']);
});

test('resultLine：成功时是结论', () => {
  const r = buildResult({ ok: true, summary: '找到 3 个视频' });
  assert.equal(resultLine(r), '找到 3 个视频');
});

test('resultLine：成功但没结论时说「做完了」', () => {
  const r = buildResult({ ok: true, summary: '' });
  assert.equal(resultLine(r), '做完了');
});

test('resultLine：失败时说「没能做完」并带上原因', () => {
  const r = buildResult({ ok: false, reason: '文件不在' });
  assert.equal(resultLine(r), '没能做完：文件不在');
});

test('resultLine：失败但没原因时也有话说', () => {
  const r = buildResult({ ok: false });
  assert.equal(resultLine(r), '没能做完：中间出了点问题');
});

test('isNotable：失败一律值得打扰用户', () => {
  assert.equal(isNotable(buildResult({ ok: false, reason: '炸了' })), true);
});

test('isNotable：做完了但没什么可说的，不打扰', () => {
  assert.equal(isNotable(buildResult({ ok: true, summary: '做完了' })), false);
  assert.equal(isNotable(buildResult({ ok: true, summary: '完成了。' })), false);
  assert.equal(isNotable(buildResult({ ok: true, summary: '' })), false);
});

test('isNotable：有内容的结论值得打扰', () => {
  assert.equal(isNotable(buildResult({ ok: true, summary: '找到 3 个视频' })), true);
});

test('userReason：工具名与路径都不留给用户', () => {
  const reason = userReason(new Error('工具「fs.read」出错：C:\\data\\a.txt 不存在'));
  assert.ok(!/fs\.read/.test(reason), `漏了工具名：${reason}`);
  assert.ok(!/C:\\data/.test(reason), `漏了路径：${reason}`);
  assert.match(reason, /不存在/);
});

test('userReason：多行日志只留第一行', () => {
  const reason = userReason(new Error('第一行\n第二行\n第三行'));
  assert.equal(reason, '第一行');
});

test('userReason：没有可读的原因时是空串', () => {
  assert.equal(userReason(new Error('')), '');
  assert.equal(userReason(null), '');
});
