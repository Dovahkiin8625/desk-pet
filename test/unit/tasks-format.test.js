import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countInterrupted,
  countTasks,
  formatElapsed,
  groupSnapshot,
  statusText,
  stepLabel,
} from '../../plugins/tasks/pages/format.js';

/**
 * 后台任务板的纯逻辑。
 *
 * 页面要靠它把运行时的话翻成人话：
 * 状态、耗时、快照怎么分组。
 * 不碰 DOM，所以能在这儿一次验完。
 */

test('任务板：状态有中文说法', () => {
  assert.equal(statusText('queued'), '排队中');
  assert.equal(statusText('running'), '进行中');
  assert.equal(statusText('waiting_approval'), '等你点头');
  assert.equal(statusText('done'), '已完成');
  assert.equal(statusText('failed'), '失败');
  assert.equal(statusText('cancelled'), '已取消');
  assert.equal(statusText('interrupted'), '被中断');
  assert.equal(statusText('不认识的'), '不认识的', '没见过的原样回显');
});

test('任务板：耗时说成人话', () => {
  assert.equal(formatElapsed(300), '不到 1 秒');
  assert.equal(formatElapsed(12_000), '12 秒');
  assert.equal(formatElapsed(180_000), '3 分钟');
  assert.equal(formatElapsed(-1), '一会儿');
});

test('任务板：第几步说的是第几步', () => {
  assert.equal(stepLabel({ stepIndex: 3, lastStep: 'fs.list' }), '第 3 步 · fs.list');
  assert.equal(stepLabel({ stepIndex: 0, lastStep: 'fs.list' }), 'fs.list');
  assert.equal(stepLabel({ stepIndex: 2, lastStep: '' }), '第 2 步');
  assert.equal(stepLabel({}), '');
});

test('任务板：快照分成待答、在跑、已结束三栏', () => {
  const { pending, running, finished } = groupSnapshot({
    tasks: [
      { taskId: 't1', status: 'running' },
      { taskId: 't2', status: 'queued' },
      { taskId: 't3', status: 'waiting_approval' },
      { taskId: 't4', status: 'done' },
      { taskId: 't5', status: 'failed' },
      { taskId: 't6', status: 'cancelled' },
      { taskId: 't7', status: 'interrupted' },
    ],
    approvals: [{ id: 't3-1', taskId: 't3' }],
  });
  assert.deepEqual(
    running.map((t) => t.taskId),
    ['t1', 't2', 't3']
  );
  assert.deepEqual(
    finished.map((t) => t.taskId),
    ['t4', 't5', 't6', 't7']
  );
  assert.deepEqual(
    pending.map((a) => a.id),
    ['t3-1']
  );
});

test('任务板：空快照也有三栏（只是都空着）', () => {
  const groups = groupSnapshot({});
  assert.deepEqual(groups.pending, []);
  assert.deepEqual(groups.running, []);
  assert.deepEqual(groups.finished, []);
});

test('任务板：在跑的算在跑里，等着点头的也算', () => {
  const counts = countTasks([
    { status: 'running' },
    { status: 'waiting_approval' },
    { status: 'queued' },
    { status: 'done' },
  ]);
  assert.equal(counts.running, 2);
  assert.equal(counts.queued, 1);
});

test('任务板：从记录里数出上次中断了几个', () => {
  const records = [
    { kind: 'task', meta: { status: 'interrupted', taskId: 't1' } },
    { kind: 'task', meta: { status: 'interrupted', taskId: 't2' } },
    { kind: 'task', meta: { status: 'done', taskId: 't3' } },
    { kind: 'reply', meta: {} },
  ];
  assert.equal(countInterrupted(records), 2);
  assert.equal(countInterrupted([]), 0);
});
