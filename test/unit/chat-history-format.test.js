import test from 'node:test';
import assert from 'node:assert/strict';

import { stepLabel, argsPreview } from '../../plugins/chat-history/pages/format.js';

/**
 * 聊天记录页面上的**纯逻辑**：一条步骤怎么变成一行字。
 *
 * 规格 §10.4 画的是「`fs.list  src/`」——工具名加上它拿到的东西。
 * 只画工具名的话，用户看到一串名字，看不出这一步到底动了什么。
 */

test('步骤的一行字：工具名 + 它拿到的东西', () => {
  const label = stepLabel({
    text: 'fs.list',
    meta: { tool: 'fs.list', args: { path: 'src/' } },
  });
  assert.equal(label, 'fs.list  path: src/');
});

test('步骤的一行字：没有参数就只画工具名', () => {
  assert.equal(stepLabel({ text: 'fs.list', meta: { tool: 'fs.list' } }), 'fs.list');
});

test('步骤的一行字：没有正文就退回工具名', () => {
  assert.equal(stepLabel({ meta: { tool: 'fs.read' } }), 'fs.read');
});

test('步骤的一行字：什么都没有就说「步骤」', () => {
  assert.equal(stepLabel(null), '步骤');
});

test('参数预览：只看前两个参数', () => {
  const preview = argsPreview({ a: '1', b: '2', c: '3' });
  assert.equal(preview, 'a: 1  b: 2');
});

test('参数预览：太长的值截断', () => {
  const preview = argsPreview({ path: 'x'.repeat(100) });
  assert.equal(preview.length, 'path: '.length + 61);
  assert.ok(preview.endsWith('…'));
});

test('参数预览：不是对象就当没有', () => {
  assert.equal(argsPreview(null), '');
  assert.equal(argsPreview('src/'), '');
  assert.equal(argsPreview(['a']), '');
});
