import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createApprovalGate,
  decideApproval,
  describeToolCall,
} from '../../src/main/assistant/agent/approval.js';
import { APPROVAL_DECISION } from '../../src/shared/assistant.js';

/**
 * 审批闸门（规格 §8）。
 *
 * 两条语义最容易做错：
 * 1. **「拒绝」不是终止任务**，是给模型一个否定的信号——
 *    模型可以换个参数再试。把它当异常抛出，agent 就只会「失败」。
 * 2. **「自动」是任务级的**：本任务内后续**同风险等级**的操作不再问，
 *    别的任务还要问。
 */

const READ_TOOL = { name: 'fs.read', label: '读文件', risk: 'read' };
const WRITE_TOOL = { name: 'fs.write', label: '写文件', risk: 'write' };
const EXEC_TOOL = { name: 'shell.exec', label: '执行命令', risk: 'exec' };

test('策略：graded 下只读自动放行', () => {
  assert.equal(decideApproval({ policy: 'graded', tool: READ_TOOL, risk: 'read' }), 'allow');
});

test('策略：graded 下写入与执行要问用户', () => {
  assert.equal(decideApproval({ policy: 'graded', tool: WRITE_TOOL, risk: 'write' }), 'ask');
  assert.equal(decideApproval({ policy: 'graded', tool: EXEC_TOOL, risk: 'exec' }), 'ask');
});

test('策略：manual 下全部要问，auto 下全部放行', () => {
  assert.equal(decideApproval({ policy: 'manual', tool: READ_TOOL, risk: 'read' }), 'ask');
  assert.equal(decideApproval({ policy: 'auto', tool: EXEC_TOOL, risk: 'exec' }), 'allow');
});

test('策略：永久放行的工具直接放行', () => {
  assert.equal(
    decideApproval({ policy: 'graded', allowAlways: ['shell.exec'], tool: EXEC_TOOL, risk: 'exec' }),
    'allow'
  );
});

test('闸门：只读工具不问用户', async () => {
  let asked = 0;
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { asked += 1; return 'allow'; },
  });
  const v = await gate.request({ tool: READ_TOOL, args: {}, risk: 'read' });
  assert.equal(v.allowed, true);
  assert.equal(asked, 0);
});

test('闸门：用户允许 → 放行', async () => {
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.ALLOW,
  });
  const v = await gate.request({ tool: EXEC_TOOL, args: { command: 'ls' }, risk: 'exec' });
  assert.equal(v.allowed, true);
});

test('闸门：用户拒绝 → 不放行，而且给模型一句能换路的话', async () => {
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.DENY,
  });
  const v = await gate.request({ tool: EXEC_TOOL, args: { command: 'ls' }, risk: 'exec' });
  assert.equal(v.allowed, false);
  assert.match(v.reason, /拒绝|没获准/, '给模型的话要说清是用户拒绝了');
  assert.ok(v.userReason, '给用户的话也要有');
});

test('闸门：点「自动」后，本任务内同风险的后续调用不再问', async () => {
  let asked = 0;
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { asked += 1; return APPROVAL_DECISION.ALWAYS; },
  });
  const first = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(first.allowed, true);
  const second = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(second.allowed, true);
  assert.equal(asked, 1, '第二次不该再问');
});

test('闸门：点「自动」只管本任务——别的任务还要问', async () => {
  let asked = 0;
  const makeGate = () => createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { asked += 1; return APPROVAL_DECISION.ALWAYS; },
  });
  const a = makeGate();
  await a.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  const b = makeGate();
  const v = await b.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(v.allowed, true);
  assert.equal(asked, 2, '另一个任务还要问一次');
});

test('闸门：等待期间挂起，不占并发槽', async () => {
  const calls = [];
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => { calls.push('ask'); return APPROVAL_DECISION.ALLOW; },
    hooks: {
      wait: async (reason) => { calls.push(`wait:${reason}`); },
      wake: () => { calls.push('wake'); },
    },
  });
  await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  // 先问用户（气泡要出来），再挂起（让出并发槽），答复来了才叫醒。
  assert.deepEqual(calls, ['ask', 'wait:approval', 'wake']);
});

test('闸门：没有问用户的渠道时，一律不放行', async () => {
  const gate = createApprovalGate({ getPolicy: () => 'graded' });
  const v = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(v.allowed, false);
});

test('闸门：任务被取消时，不放行', async () => {
  const controller = new AbortController();
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: () => new Promise(() => {}),   // 用户一直不答复
  });
  const pending = gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec', signal: controller.signal });
  controller.abort();
  const v = await pending;
  assert.equal(v.allowed, false);
});

test('闸门：每次决议都留一笔，给记录用', async () => {
  const seen = [];
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.ALLOW,
    onDecision: (e) => seen.push(e),
  });
  await gate.request({ tool: EXEC_TOOL, args: { command: 'ls' }, risk: 'exec' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'shell.exec');
  assert.equal(seen[0].decision, 'allow');
});

test('说明：给人看的一行话说清要做什么', () => {
  const text = describeToolCall({ name: 'shell.exec', label: '执行命令' }, { command: 'npm test' });
  assert.match(text, /npm test/);
  assert.match(text, /执行命令|命令/);
});

test('闸门：没等到确认时，不能说成「用户拒绝了」', async () => {
  // 用户压根没点过按钮：审批被别的东西顶掉了，或者任务被取消了。
  // 说成「用户拒绝」是冤枉人——记录里也会留下假的拒绝。
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.SUPERSEDE,
  });
  const v = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(v.allowed, false);
  assert.equal(v.decision, APPROVAL_DECISION.SUPERSEDE);
  assert.doesNotMatch(v.reason, /拒绝/, '用户没拒绝过');
  assert.match(v.reason, /没有等到|没等到/);
});

test('闸门：用户点「取消」时，任务真的被取消', async () => {
  let cancelled = 0;
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.CANCEL,
    cancelTask: () => { cancelled += 1; },
  });
  const v = await gate.request({ tool: EXEC_TOOL, args: {}, risk: 'exec' });
  assert.equal(v.allowed, false);
  assert.equal(v.decision, APPROVAL_DECISION.CANCEL);
  assert.equal(cancelled, 1, '点了「取消」就要真的把任务停掉');
});

test('闸门：请求一发出就留一笔「等你点头」', async () => {
  const seen = [];
  const gate = createApprovalGate({
    getPolicy: () => 'graded',
    ask: async () => APPROVAL_DECISION.ALLOW,
    onRequest: (e) => seen.push(e),
  });
  await gate.request({ tool: EXEC_TOOL, args: { command: 'ls' }, risk: 'exec' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'shell.exec');
});
