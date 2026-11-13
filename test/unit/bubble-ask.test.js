import test from 'node:test';
import assert from 'node:assert/strict';

import { createAskInbox } from '../../src/main/bubbleAsk.js';
import { APPROVAL_DECISION, MESSAGE_KIND } from '../../src/shared/assistant.js';

/**
 * 气泡上「等人回话」的那些卡片。
 *
 * 抽成不引 electron 的小模块，是为了能单测：
 * 主进程的气泡控制器引了 electron，在普通 node 里测不了。
 *
 * 最要紧的两条：**答复要按 id 认**——
 * 两个任务同时要回话时，第二个的答复不能把第一个的搞混；
 * **谁先答谁算数**——后答的那个不能改已经定下来的结果。
 */

test('审批：请求之后，答复按 id 兑现', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, title: '要点头', text: '跑命令？' });
  assert.equal(inbox.pending(), 1);
  assert.equal(inbox.respond({ id: 'a1', answer: 'allow' }).ok, true);
  assert.equal(await p, 'allow');
  assert.equal(inbox.pending(), 0);
});

test('审批：两个请求各归各的', async () => {
  const inbox = createAskInbox();
  const a = inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  const b = inbox.request({ id: 'a2', kind: MESSAGE_KIND.APPROVAL, text: '乙' });
  inbox.respond({ id: 'a2', answer: 'deny' });
  assert.equal(await b, 'deny');
  inbox.respond({ id: 'a1', answer: 'allow' });
  assert.equal(await a, 'allow');
});

test('审批：不认识的 id 不算数，也不抛错', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  const res = inbox.respond({ id: 'nope', answer: 'allow' });
  assert.equal(res.ok, false);
  inbox.respond({ id: 'a1', answer: 'deny' });
  assert.equal(await p, 'deny');
});

test('审批：没见过的决议按拒绝算', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  inbox.respond({ id: 'a1', answer: '乱写的' });
  assert.equal(await p, 'deny');
});

test('审批：取消（clear）让挂着的请求都有个交代', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  inbox.clear();
  assert.equal(await p, APPROVAL_DECISION.SUPERSEDE);
  assert.equal(inbox.pending(), 0);
});

test('审批：用户可以点「取消这次任务」', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  assert.equal(inbox.respond({ id: 'a1', answer: APPROVAL_DECISION.CANCEL }).ok, true);
  assert.equal(await p, APPROVAL_DECISION.CANCEL);
});

test('审批：挂着好几个，按先进先出排队', async () => {
  const inbox = createAskInbox();
  inbox.request({ id: 'a1', taskId: 't1', kind: MESSAGE_KIND.APPROVAL, title: '甲', text: '写文件', risk: 'write' });
  inbox.request({ id: 'a2', taskId: 't2', kind: MESSAGE_KIND.APPROVAL, title: '乙', text: '跑命令', risk: 'exec' });
  assert.equal(inbox.pending(), 2);
  const list = inbox.list();
  assert.deepEqual(
    list.map((a) => a.id),
    ['a1', 'a2']
  );
  assert.equal(list[0].taskId, 't1');
  assert.equal(list[0].text, '写文件');
  assert.equal(list[0].risk, 'write');
});

test('审批：答复过的那个从队列里下去，后面的往前挪', async () => {
  const inbox = createAskInbox();
  inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  inbox.request({ id: 'a2', kind: MESSAGE_KIND.APPROVAL, text: '乙' });
  inbox.respond({ id: 'a1', answer: 'allow' });
  assert.equal(inbox.pending(), 1);
  assert.deepEqual(
    inbox.list().map((a) => a.id),
    ['a2']
  );
});

test('审批：谁先答谁算数，后答的不改状态', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  assert.equal(inbox.respond({ id: 'a1', answer: 'allow' }).ok, true);
  const again = inbox.respond({ id: 'a1', answer: 'deny' });
  assert.equal(again.ok, false, '第二次答复不算数');
  assert.match(again.message, /已经答复过了/);
  assert.equal(await p, 'allow', '结果不能被第二次答复改掉');
});

test('审批：作废之后答复它，算是不认识这个卡片', () => {
  const inbox = createAskInbox();
  inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '甲' });
  inbox.clear();
  const res = inbox.respond({ id: 'a1', answer: 'allow' });
  assert.equal(res.ok, false);
  assert.match(res.message, /没有这个待答的卡片/);
});

test('选择：用户选中的那个选项就是答复', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({
    id: 'c1',
    kind: MESSAGE_KIND.CHOICE,
    question: '你要哪个？',
    options: ['打开面板', '放首歌'],
  });
  assert.equal(inbox.respond({ id: 'c1', answer: '放首歌' }).ok, true);
  assert.equal(await p, '放首歌');
});

test('选择：不在选项里的答复不算数', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({
    id: 'c1',
    kind: MESSAGE_KIND.CHOICE,
    question: '你要哪个？',
    options: ['打开面板', '放首歌'],
  });
  const res = inbox.respond({ id: 'c1', answer: '乱写的' });
  assert.equal(res.ok, false);
  assert.equal(await p, '', '不能当成用户选了什么');
});

test('选择：没有选项就没人能选', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({ id: 'c1', kind: MESSAGE_KIND.CHOICE, question: '你要哪个？' });
  assert.equal(await p, '');
  assert.equal(inbox.pending(), 0);
});

test('选择：作废之后算没人回答', async () => {
  const inbox = createAskInbox();
  const p = inbox.request({
    id: 'c1',
    kind: MESSAGE_KIND.CHOICE,
    question: '你要哪个？',
    options: ['甲', '乙'],
  });
  inbox.clear();
  assert.equal(await p, '');
});

test('两种卡片排在同一条队列里', async () => {
  const inbox = createAskInbox();
  inbox.request({ id: 'a1', kind: MESSAGE_KIND.APPROVAL, text: '批准我？' });
  inbox.request({ id: 'c1', kind: MESSAGE_KIND.CHOICE, question: '哪个？', options: ['甲'] });
  assert.equal(inbox.pending(), 2);
  assert.equal(inbox.pending(MESSAGE_KIND.APPROVAL), 1);
  assert.equal(inbox.pending(MESSAGE_KIND.CHOICE), 1);
  assert.deepEqual(
    inbox.list().map((c) => c.id),
    ['a1', 'c1']
  );
  assert.deepEqual(
    inbox.list(MESSAGE_KIND.CHOICE).map((c) => c.id),
    ['c1']
  );
});
