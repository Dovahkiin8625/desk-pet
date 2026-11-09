import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_KIND,
  CHAT_KIND_LIMITS,
  LAYER,
  chatKindOf,
} from '../../src/shared/assistant.js';
import {
  appendMessage,
  normalizeChatEntry,
  truncateByKind,
} from '../../src/main/assistant/chat/memory.js';
import { buildChatMessages } from '../../src/main/assistant/chat/prompt.js';
import { sanitizeAssistant } from '../../src/main/assistant/state.js';
import { dispatchRecord, modelRecord, stepRecord } from '../../src/main/assistant/agent/record.js';

/**
 * 聊天记录的分类（规格 §4）。
 *
 * 三件事最容易做错：
 * 1. 喂模型时**只取 user/reply**——步骤/任务/审批绝不能进上下文；
 *    漏了这一条，工具日志会把对话冲垮，而且症状是「模型突然变笨」而不是报错。
 * 2. 磁盘上的截断**按 kind 分路**——砍数组尾巴会把最老的用户输入挤掉，
 *    而模型恰恰最需要那几条用户输入。
 * 3. 旧记录没有 `kind`，按 `role` 兜底——用户升级前的数据不能被丢掉。
 */

/** 造一条记录（绕过 appendMessage，方便直接构造边界情况）。 */
function entry(kind, text, extra = {}) {
  return { id: `${kind}-${text}`, at: 1, kind, role: kind === 'user' ? 'user' : 'assistant', text, ...extra };
}

test('分类：kind 的取值与规格一致', () => {
  assert.equal(CHAT_KIND.USER, 'user');
  assert.equal(CHAT_KIND.REPLY, 'reply');
  assert.equal(CHAT_KIND.TASK, 'task');
  assert.equal(CHAT_KIND.STEP, 'step');
  assert.equal(CHAT_KIND.APPROVAL, 'approval');
  assert.equal(CHAT_KIND.MODEL, 'model');
});

test('分类：旧记录没有 kind 时按 role 兜底', () => {
  assert.equal(chatKindOf({ role: 'user', text: '在呢' }), 'user');
  assert.equal(chatKindOf({ role: 'assistant', text: '在呢' }), 'reply');
  assert.equal(chatKindOf({ kind: 'step', role: 'assistant', text: 'x' }), 'step');
  assert.equal(chatKindOf({ kind: '瞎写的', role: 'user', text: 'x' }), 'user');
});

test('分类：每类记录有自己的上限', () => {
  assert.equal(CHAT_KIND_LIMITS.user, 40);
  assert.equal(CHAT_KIND_LIMITS.reply, 40);
  assert.equal(CHAT_KIND_LIMITS.step, 200);
  assert.equal(CHAT_KIND_LIMITS.task, 100);
  assert.equal(CHAT_KIND_LIMITS.approval, 100);
  // 模型回合：上限不能少写——上限表里某个分类写成 0 意思是「这一路不限」，
  // 删掉这一行就悄悄变成不限了，测试还照样过。
  assert.equal(CHAT_KIND_LIMITS.model, 200);
});

test('记录：写入时补齐 id / kind / at', () => {
  const list = appendMessage([], { role: 'user', text: '你好' });
  assert.equal(list.length, 1);
  assert.ok(list[0].id, '要有 id');
  assert.equal(list[0].kind, 'user');
  assert.equal(list[0].role, 'user');
  assert.equal(list[0].text, '你好');
  assert.ok(Number.isFinite(list[0].at));
});

test('记录：截断按 kind 分路——新步骤不会挤掉最老的用户输入', () => {
  let list = [];
  list = appendMessage(list, { role: 'user', text: '第一条用户输入' });
  list = appendMessage(list, { role: 'assistant', text: '第一条回复' });
  // 塞 300 条步骤——超过 step 的上限 200。
  for (let i = 0; i < 300; i += 1) {
    list = appendMessage(list, { kind: 'step', role: 'assistant', text: `步骤 ${i}` });
  }
  const users = list.filter((m) => m.kind === 'user');
  const replies = list.filter((m) => m.kind === 'reply');
  const steps = list.filter((m) => m.kind === 'step');
  assert.equal(users.length, 1, '用户输入不能被步骤挤掉');
  assert.equal(users[0].text, '第一条用户输入');
  assert.equal(replies.length, 1, '回复也不能被步骤挤掉');
  assert.equal(steps.length, CHAT_KIND_LIMITS.step, '步骤自己砍自己的尾巴');
  assert.equal(steps[steps.length - 1].text, '步骤 299', '砍的是最老的');
});

test('记录：截断后时间顺序不乱', () => {
  const list = truncateByKind([
    entry('user', 'u1'),
    entry('step', 's1'),
    entry('reply', 'r1'),
    entry('step', 's2'),
  ]);
  assert.deepEqual(list.map((m) => m.text), ['u1', 's1', 'r1', 's2']);
});

test('记录：规整旧数据——补 id、补 kind、认 role', () => {
  const one = normalizeChatEntry({ role: 'assistant', text: '老回复', at: 123 });
  assert.ok(one.id);
  assert.equal(one.kind, 'reply');
  assert.equal(one.at, 123);
  assert.equal(one.role, 'assistant');
});

test('喂模型：只有 user 与 reply 进上下文', () => {
  const history = [
    entry('user', '用户说的话'),
    entry('reply', '桌宠的回复'),
    entry('task', '任务：排队'),
    entry('step', '步骤：fs.list src/'),
    entry('approval', '审批：shell.exec'),
  ];
  const messages = buildChatMessages({ history, userText: '现在这句' });
  assert.deepEqual(messages, [
    { role: 'user', content: '用户说的话' },
    { role: 'assistant', content: '桌宠的回复' },
    { role: 'user', content: '现在这句' },
  ]);
});

test('喂模型：旧记录（没有 kind）也能进上下文', () => {
  const messages = buildChatMessages({
    history: [
      { role: 'user', text: '老用户输入' },
      { role: 'assistant', text: '老回复' },
    ],
    userText: '现在这句',
  });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, '老用户输入');
  assert.equal(messages[1].role, 'assistant');
});

test('喂模型：历史再多也只发最近 12 条', () => {
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push(entry(i % 2 === 0 ? 'user' : 'reply', `第 ${i} 条`));
  }
  const messages = buildChatMessages({ history, userText: '现在这句' });
  assert.equal(messages.length, 13, '12 条历史 + 当前这句');
  assert.equal(messages[0].content, '第 18 条');
});

test('磁盘：旧记录读进来时被补齐 kind，并按 kind 分路截断', () => {
  const raw = {
    chat: {
      messages: [
        { role: 'user', text: '老用户输入', at: 1 },
        { role: 'assistant', text: '老回复', at: 2 },
        ...Array.from({ length: 250 }, (_, i) => ({
          id: `s${i}`,
          kind: 'step',
          role: 'assistant',
          text: `步骤 ${i}`,
          at: 100 + i,
          meta: { taskId: 't1', index: i },
        })),
      ],
      facts: [],
    },
  };
  const clean = sanitizeAssistant(raw);
  const users = clean.chat.messages.filter((m) => m.kind === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text, '老用户输入');
  assert.ok(users[0].id, '旧记录也要有 id');
  const steps = clean.chat.messages.filter((m) => m.kind === 'step');
  assert.equal(steps.length, CHAT_KIND_LIMITS.step);
  assert.equal(steps[0].text, '步骤 50', '砍掉最老的步骤，用户输入与回复留着');
  const step = steps[0];
  assert.equal(step.meta.taskId, 't1');
  assert.equal(step.meta.index, 50);
});

test('记录：role 由 kind 推导——只写 kind 也不会自相矛盾', () => {
  // kind 是新契约，role 是为兼容旧数据保留的字段：
  // 如果两个都是真值来源，就能源源地产出「用户的话以助手身份进上下文」这种记录。
  assert.equal(normalizeChatEntry({ kind: 'user', text: 'x' }).role, 'user');
  assert.equal(normalizeChatEntry({ kind: 'reply', text: 'x' }).role, 'assistant');
  assert.equal(normalizeChatEntry({ kind: 'step', text: 'x' }).role, 'assistant');
  assert.equal(normalizeChatEntry({ kind: 'reply', role: 'user', text: 'x' }).role, 'assistant');
});

test('记录：旧数据的兼容行为不受影响', () => {
  const user = normalizeChatEntry({ role: 'user', text: 'x' });
  assert.equal(user.kind, 'user');
  assert.equal(user.role, 'user');
  const reply = normalizeChatEntry({ role: 'assistant', text: 'x' });
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.role, 'assistant');
});

test('磁盘：只写 kind 的新记录不会被静默丢掉', () => {
  // 写盘关口是唯一能发现「调用方写错形状」的地方——
  // 它要是还按旧的 role 白名单把关，新分类记录会被默默吃掉。
  const raw = {
    chat: {
      messages: [
        { kind: 'step', text: '步骤 1', meta: { taskId: 't1', tool: 'fs.list' } },
        { kind: 'approval', text: '', meta: { taskId: 't1', tool: 'shell.exec' } },
        { kind: 'task', text: '任务开始', meta: { taskId: 't1', status: 'running' } },
        { text: '既没 kind 也没 role 的坏数据' },
      ],
      facts: [],
    },
  };
  const clean = sanitizeAssistant(raw);
  assert.equal(clean.chat.messages.length, 3, '坏数据要丢掉，好数据要留下');
  assert.equal(clean.chat.messages[0].kind, 'step');
  assert.equal(clean.chat.messages[0].role, 'assistant');
  assert.equal(clean.chat.messages[1].kind, 'approval', '正文为空但 meta 有内容的记录要留下');
  assert.equal(clean.chat.messages[2].kind, 'task');
});

test('model 记录不会被降级成 reply', () => {
  // 不认识的 kind 会被 `chatKindOf` 降级成 reply——
  // 那是最糟的失败形态：记录没丢，却混进了两层的模型上下文。
  const entry = normalizeChatEntry({ kind: 'model', role: 'assistant', text: '我先看看剪贴板', at: 1 });
  assert.equal(entry.kind, 'model');
});

test('model 记录不进任何一层的模型上下文', () => {
  // 「模型回合」只给人看：交互层与执行层都看不见它。
  const history = [{ kind: 'model', role: 'assistant', text: '我先看看剪贴板', at: 1 }];
  for (const layer of [LAYER.INTERACTION, LAYER.EXECUTION]) {
    const messages = buildChatMessages({ history, layer });
    assert.equal(messages.some((m) => m.content === '我先看看剪贴板'), false);
  }
});

test('模型回合的记录', () => {
  const entry = modelRecord({ index: 1, text: '我先看看剪贴板', model: 'MiniMax-M2' });
  assert.equal(entry.kind, 'model');
  assert.equal(entry.text, '我先看看剪贴板');
  assert.equal(entry.meta.layer, 'interaction');
  assert.equal(entry.meta.index, 1);
  assert.equal(entry.meta.model, 'MiniMax-M2');
});

test('派单记录带着交底原文', () => {
  const entry = dispatchRecord({ tool: 'task.submit', taskId: 't-1', title: '查视频', brief: '看看 F 盘 video 下有什么' });
  assert.equal(entry.meta.brief, '看看 F 盘 video 下有什么');
  assert.equal(entry.meta.layer, LAYER.INTERACTION);
});

test('步骤记录带着是哪一层的', () => {
  assert.equal(stepRecord({ taskId: '', tool: 'fs.list' }).meta.layer, 'execution');
  assert.equal(stepRecord({ taskId: '', tool: 'fs.list', layer: 'interaction' }).meta.layer, 'interaction');
});

test('磁盘：meta 太大了要截断，别让一条记录把文件撑爆', () => {
  const huge = 'x'.repeat(50000);
  const raw = {
    chat: {
      messages: [{ kind: 'step', text: '步骤', meta: { taskId: 't1', tool: 'fs.read', result: huge } }],
      facts: [],
    },
  };
  const clean = sanitizeAssistant(raw);
  const meta = clean.chat.messages[0].meta;
  assert.equal(meta.taskId, 't1', '小的字段要保住');
  assert.ok(meta.result.length < huge.length, '大的字段要截断');
  assert.ok(JSON.stringify(meta).length < 10000, '整条 meta 要有上限');
});
