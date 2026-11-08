import test from 'node:test';
import assert from 'node:assert/strict';

import { createApprovalInbox } from '../../src/main/bubbleApproval.js';

/**
 * 审批气泡的「等答复」这件事（规格 §8.2）。
 *
 * 抽成不引 electron 的小模块，是为了能单测：
 * 主进程的气泡控制器引了 electron，在普通 node 里测不了。
 *
 * 最要紧的一条：**决议要按 id 认**——
 * 两个任务同时要审批时，第二个的答复不能把第一个的搞混。
 */

test('审批：请求之后，答复按 id 兑现', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', title: '要点头', text: '跑命令？' });
  assert.equal(inbox.pending(), 1);
  assert.equal(inbox.respond({ id: 'a1', decision: 'allow' }), true);
  assert.equal(await p, 'allow');
  assert.equal(inbox.pending(), 0);
});

test('审批：两个请求各归各的', async () => {
  const inbox = createApprovalInbox();
  const a = inbox.request({ id: 'a1', text: '甲' });
  const b = inbox.request({ id: 'a2', text: '乙' });
  inbox.respond({ id: 'a2', decision: 'deny' });
  assert.equal(await b, 'deny');
  inbox.respond({ id: 'a1', decision: 'allow' });
  assert.equal(await a, 'allow');
});

test('审批：不认识的 id 不算数，也不抛错', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', text: '甲' });
  assert.equal(inbox.respond({ id: 'nope', decision: 'allow' }), false);
  inbox.respond({ id: 'a1', decision: 'deny' });
  assert.equal(await p, 'deny');
});

test('审批：没见过的决议按拒绝算', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', text: '甲' });
  inbox.respond({ id: 'a1', decision: '乱写的' });
  assert.equal(await p, 'deny');
});

test('审批：取消（clear）让挂着的请求都有个交代', async () => {
  const inbox = createApprovalInbox();
  const p = inbox.request({ id: 'a1', text: '甲' });
  inbox.clear();
  assert.equal(await p, 'deny');
  assert.equal(inbox.pending(), 0);
});
