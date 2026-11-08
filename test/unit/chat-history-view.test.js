import test from 'node:test';
import assert from 'node:assert/strict';

import { groupEntries } from '../../plugins/chat-history/pages/groups.js';

/**
 * 聊天记录的分块（规格 §10.4）。
 *
 * 记录有六种，两头看的人不一样：
 * - `user` / `reply`：对话，一句一条；
 * - `dispatch`：前台派了一个后台任务；
 * - `task` / `step` / `approval`：**同一个任务**的过程——
 *   散着看是一堆噪音，合起来才是「这件事干到哪了」。
 */

/** 一条记录。 */
function entry(kind, text, meta = {}) {
  return { id: `${kind}:${text}`, kind, role: 'assistant', text, at: 1, meta };
}

test('分组：对话一句一条，任务的过程合成一块', () => {
  const blocks = groupEntries([
    entry('user', '在吗'),
    entry('reply', '在呢'),
    entry('task', '进行中 · 查视频', { taskId: 't-1', title: '查视频', status: 'running' }),
    entry('step', 'fs.list', { taskId: 't-1', tool: 'fs.list' }),
    entry('approval', 'shell.exec：等你点头', { taskId: 't-1', tool: 'shell.exec' }),
    entry('dispatch', '派了个任务：查视频', { taskId: 't-1' }),
  ]);

  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].type, 'chat');
  assert.equal(blocks[1].type, 'chat');

  const task = blocks[2];
  assert.equal(task.type, 'task');
  assert.equal(task.taskId, 't-1');
  assert.equal(task.title, '查视频');
  assert.equal(task.statuses.length, 1);
  assert.equal(task.steps.length, 1);
  assert.equal(task.approvals.length, 1);

  // 派单是**前台**的事，不跟后台任务的过程混在一块。
  assert.equal(blocks[3].type, 'dispatch');
});

test('分组：同一个任务的步骤聚到同一块', () => {
  const blocks = groupEntries([
    entry('task', '排队中 · 查视频', { taskId: 't-1', title: '查视频' }),
    entry('step', 'fs.list', { taskId: 't-1' }),
    entry('task', '完成 · 查视频', { taskId: 't-1', title: '查视频', status: 'done' }),
    entry('step', 'fs.read', { taskId: 't-1' }),
    entry('task', '排队中 · 别的', { taskId: 't-2', title: '别的' }),
  ]);
  const tasks = blocks.filter((b) => b.type === 'task');
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].steps.length, 2);
  assert.equal(tasks[0].statuses.length, 2);
  assert.equal(tasks[1].taskId, 't-2');
});

test('分组：没有任务号的记录各归各的', () => {
  const blocks = groupEntries([
    entry('step', 'fs.list', {}),
    entry('user', '在吗'),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'step');
  assert.equal(blocks[1].type, 'chat');
});

test('分组：空记录不炸', () => {
  assert.deepEqual(groupEntries([]), []);
  assert.deepEqual(groupEntries(null), []);
});
