import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_STATUS_TEXT,
  approvalRecord,
  interruptedTasks,
  stepRecord,
  taskRecord,
} from '../../src/main/assistant/agent/record.js';
import { CHAT_KIND, CHAT_KIND_FOR_LAYER, TASK_STATUS } from '../../src/shared/assistant.js';
import { appendMessage } from '../../src/main/assistant/chat/memory.js';
import { buildChatMessages } from '../../src/main/assistant/chat/prompt.js';

/**
 * 分类记录（规格 §4.2 的 task / step / approval 三类）。
 *
 * 最要紧的一条：**这三类记录绝不能进模型上下文**——
 * 它们是给人看的，进了上下文会把对话冲垮，
 * 而且症状是「模型突然变笨」而不是报错，极难排查。
 */

test('任务记录：分类与形状与规格一致', () => {
  const entry = taskRecord({ taskId: 't1', status: TASK_STATUS.RUNNING, title: '查天气' });
  assert.equal(entry.kind, CHAT_KIND.TASK);
  assert.equal(entry.role, 'assistant');
  assert.equal(entry.meta.taskId, 't1');
  assert.equal(entry.meta.status, 'running');
  assert.equal(entry.meta.title, '查天气');
  assert.match(entry.text, /查天气/);
});

test('步骤记录：带工具名、参数与结果', () => {
  const entry = stepRecord({ taskId: 't1', index: 2, tool: 'fs.read', args: { path: 'a.txt' }, result: '内容' });
  assert.equal(entry.kind, CHAT_KIND.STEP);
  assert.equal(entry.meta.index, 2);
  assert.equal(entry.meta.tool, 'fs.read');
  assert.deepEqual(entry.meta.args, { path: 'a.txt' });
  assert.equal(entry.meta.result, '内容');
});

test('步骤记录：出错时也留一笔，错在 meta 里', () => {
  const entry = stepRecord({ taskId: 't1', index: 3, tool: 'shell.exec', error: '炸了' });
  assert.equal(entry.kind, CHAT_KIND.STEP);
  assert.equal(entry.meta.error, '炸了');
});

test('审批记录：带工具与决议', () => {
  const entry = approvalRecord({ taskId: 't1', tool: 'shell.exec', args: { command: 'ls' }, risk: 'exec', decision: 'allow' });
  assert.equal(entry.kind, CHAT_KIND.APPROVAL);
  assert.equal(entry.meta.tool, 'shell.exec');
  assert.equal(entry.meta.risk, 'exec');
  assert.equal(entry.meta.decision, 'allow');
});

test('审批记录：还在等的时候写「等你点头」', () => {
  // 规格 §15：任务卡在审批上时，记录里要看得见它还卡着。
  const entry = approvalRecord({ taskId: 't1', tool: 'shell.exec', risk: 'exec', decision: 'pending' });
  assert.match(entry.text, /等你点头/);
});

test('审批记录：没等到确认不能写成「已拒绝」', () => {
  const entry = approvalRecord({ taskId: 't1', tool: 'shell.exec', risk: 'exec', decision: 'supersede' });
  assert.doesNotMatch(entry.text, /已拒绝/, '用户没拒绝过');
  assert.match(entry.text, /未确认/);
});

test('审批记录：用户取消了任务', () => {
  const entry = approvalRecord({ taskId: 't1', tool: 'shell.exec', risk: 'exec', decision: 'cancel' });
  assert.match(entry.text, /取消/);
});

test('中断检测：上次退出时还在跑的任务被找出来', () => {
  const messages = [
    taskRecord({ taskId: 't1', status: TASK_STATUS.QUEUED, title: '甲' }),
    taskRecord({ taskId: 't1', status: TASK_STATUS.RUNNING, title: '甲' }),
    taskRecord({ taskId: 't2', status: TASK_STATUS.DONE, title: '乙' }),
  ];
  const list = interruptedTasks(messages);
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, 't1');
  assert.equal(list[0].title, '甲');
});

test('中断检测：等审批中的任务也算中断', () => {
  const messages = [taskRecord({ taskId: 't1', status: TASK_STATUS.WAITING_APPROVAL, title: '甲' })];
  assert.equal(interruptedTasks(messages).length, 1);
});

test('中断检测：没有任务就空数组', () => {
  assert.deepEqual(interruptedTasks([]), []);
  assert.deepEqual(interruptedTasks([{ kind: 'user', text: '在呢' }]), []);
});

test('关键：这三种记录一律不进模型上下文', () => {
  const messages = [];
  messages.push(...appendMessage(messages, { kind: CHAT_KIND.USER, role: 'user', text: '帮我查天气' }));
  messages.push(...appendMessage(messages, taskRecord({ taskId: 't1', status: TASK_STATUS.RUNNING, title: '整理资料' })));
  messages.push(...appendMessage(messages, stepRecord({ taskId: 't1', index: 1, tool: 'fs.read', result: 'x' })));
  messages.push(...appendMessage(messages, approvalRecord({ taskId: 't1', tool: 'fs.read', decision: 'allow' })));
  messages.push(...appendMessage(messages, { kind: CHAT_KIND.REPLY, role: 'assistant', text: '今天晴' }));

  const convo = buildChatMessages({ history: messages, userText: '再说一句' });
  const texts = convo.map((m) => m.content);
  // 历史每条都带相对时间，所以按「包含」来断。
  assert.ok(texts.some((t) => String(t).includes('帮我查天气')));
  assert.ok(texts.some((t) => String(t).includes('今天晴')));
  assert.ok(!texts.some((t) => String(t).includes('fs.read')), '步骤不能进上下文');
  assert.ok(!texts.some((t) => String(t).includes('整理资料')), '任务状态不能进上下文');
  // 只有 user 与 reply 两种分类进**任何一层**的上下文；
  // dispatch 只进交互层（见 agent-dispatch-record.test.js）。
  assert.ok(
    [...CHAT_KIND_FOR_LAYER.execution].every(
      (k) => k === CHAT_KIND.USER || k === CHAT_KIND.REPLY
    )
  );
});

test('状态短句：每个状态都有一句人话', () => {
  for (const status of Object.values(TASK_STATUS)) {
    assert.ok(TASK_STATUS_TEXT[status], `${status} 没有对应的话`);
  }
});
