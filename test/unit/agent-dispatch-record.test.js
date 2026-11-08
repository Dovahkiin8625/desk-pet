import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_KIND,
  CHAT_KIND_LIMITS,
  LAYER,
  CHAT_KIND_FOR_LAYER,
} from '../../src/shared/assistant.js';
import { dispatchRecord } from '../../src/main/assistant/agent/record.js';
import { appendMessage } from '../../src/main/assistant/chat/memory.js';
import {
  buildChatMessages,
  buildHistoryMessages,
} from '../../src/main/assistant/chat/prompt.js';

/**
 * 派单记录与「按层过滤」（规格 §6）。
 *
 * 两条规矩最容易做错：
 * 1. **交互层要看得见自己派过什么**——不然它下一句又派一遍单，
 *    用户会觉得「怎么一直在重复」；
 * 2. **执行层看不见 dispatch**——它不需要知道用户还派了别的任务，
 *    知道反而会分心。
 */

/** 造一段历史：用户的话、桌宠的话、一次派单、一条任务状态。 */
function sampleHistory() {
  let list = [];
  list = appendMessage(list, { kind: CHAT_KIND.USER, role: 'user', text: 'F 盘 video 下有什么' });
  list = appendMessage(list, { kind: CHAT_KIND.REPLY, role: 'assistant', text: '我去看看' });
  list = appendMessage(list, dispatchRecord({ tool: 'task.submit', taskId: 't-1', title: '查视频', action: '派了个任务' }));
  list = appendMessage(list, { kind: CHAT_KIND.TASK, role: 'assistant', text: '进行中 · 查视频', meta: { taskId: 't-1' } });
  list = appendMessage(list, { kind: CHAT_KIND.STEP, role: 'assistant', text: 'fs.list', meta: { taskId: 't-1' } });
  return list;
}

test('派单记录：分类是 dispatch，正文里带着任务号', () => {
  const entry = dispatchRecord({
    tool: 'task.submit',
    taskId: 't-42',
    title: '查视频',
    action: '派了个任务：查视频',
  });
  assert.equal(entry.kind, CHAT_KIND.DISPATCH);
  // 任务号必须在正文里：交互层下一轮要靠它说「停掉 t-42」。
  assert.match(entry.text, /t-42/);
  assert.equal(entry.meta.taskId, 't-42');
  assert.equal(entry.meta.tool, 'task.submit');
});

test('按层过滤：交互层看得见 dispatch，执行层看不见', () => {
  const history = sampleHistory();
  const inter = buildHistoryMessages({ history, layer: LAYER.INTERACTION }).map((m) => m.content);
  const exec = buildHistoryMessages({ history, layer: LAYER.EXECUTION }).map((m) => m.content);

  assert.ok(inter.some((t) => String(t).includes('t-1')), '交互层要看得见自己派过的单');
  assert.ok(!exec.some((t) => String(t).includes('t-1')), '执行层不该看见派单记录');
});

test('按层过滤：任务、步骤、审批两层都看不见', () => {
  const history = sampleHistory();
  for (const layer of [LAYER.INTERACTION, LAYER.EXECUTION]) {
    const texts = buildHistoryMessages({ history, layer }).map((m) => String(m.content));
    assert.ok(!texts.some((t) => t.includes('fs.list')), `${layer} 不该看见步骤`);
    assert.ok(!texts.some((t) => t.includes('进行中')), `${layer} 不该看见任务状态`);
  }
});

test('历史助手：只给历史，不带当前这句话', () => {
  const history = sampleHistory();
  const only = buildHistoryMessages({ history, layer: LAYER.INTERACTION });
  assert.ok(!only.some((m) => String(m.content).includes('再说一句')));
  // 带当前这句话时，它在最后。
  const withNow = buildChatMessages({ history, userText: '再说一句', layer: LAYER.INTERACTION });
  assert.equal(withNow.at(-1).role, 'user');
  assert.equal(withNow.at(-1).content, '再说一句');
});

test('分层的分类清单', () => {
  assert.deepEqual(
    [...CHAT_KIND_FOR_LAYER.interaction].sort(),
    [CHAT_KIND.USER, CHAT_KIND.REPLY, CHAT_KIND.DISPATCH].sort()
  );
  assert.deepEqual(
    [...CHAT_KIND_FOR_LAYER.execution].sort(),
    [CHAT_KIND.USER, CHAT_KIND.REPLY].sort()
  );
  assert.equal(CHAT_KIND_LIMITS.dispatch, 100);
});
