import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeTasks,
  argsPreview,
  countByStatus,
  countInterrupted,
  currentTask,
  formatClock,
  formatDuration,
  formatElapsed,
  isActive,
  resultText,
  shortId,
  sortTasks,
  statusText,
  stepLabel,
  stepNodes,
} from '../../plugins/tasks/pages/format.js';

/**
 * 后台任务板的纯逻辑。
 *
 * 页面要靠它把运行时的话翻成人话：
 * 状态、耗时、计数、当前任务、步骤时间线。
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

test('任务板：各状态各有几个', () => {
  const counts = countByStatus([
    { status: 'running' },
    { status: 'waiting_approval' },
    { status: 'queued' },
    { status: 'done' },
    { status: 'failed' },
    { status: 'cancelled' },
  ]);
  assert.deepEqual(counts, { running: 2, queued: 1, done: 1, failed: 1, cancelled: 1 });
});

test('任务板：没任务也是一份零', () => {
  assert.deepEqual(countByStatus([]), { running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 });
  assert.deepEqual(countByStatus(null), { running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 });
});

test('任务板：等着点头的还算没结束', () => {
  assert.equal(isActive({ status: 'running' }), true);
  assert.equal(isActive({ status: 'queued' }), true);
  assert.equal(isActive({ status: 'waiting_approval' }), true);
  assert.equal(isActive({ status: 'done' }), false);
  const list = [{ status: 'running' }, { status: 'done' }, { status: 'queued' }];
  assert.deepEqual(
    activeTasks(list).map((t) => t.status),
    ['running', 'queued']
  );
});

test('任务板：列表里在跑的排前面', () => {
  const list = [
    { taskId: 'a', status: 'done', createdAt: 300 },
    { taskId: 'b', status: 'running', createdAt: 100 },
    { taskId: 'c', status: 'done', createdAt: 200 },
  ];
  assert.deepEqual(
    sortTasks(list).map((t) => t.taskId),
    ['b', 'a', 'c'],
    '在跑的排前面，完了的按新的在前'
  );
});

test('任务板：当前任务是最近起跑的那个', () => {
  const current = currentTask([
    { taskId: 'a', status: 'running', startedAt: 100 },
    { taskId: 'b', status: 'running', startedAt: 200 },
    { taskId: 'c', status: 'done', startedAt: 300 },
  ]);
  assert.equal(current.taskId, 'b');
  assert.equal(currentTask([{ taskId: 'c', status: 'done' }]), null, '没有在跑的就空着');
});

test('任务板：时刻说成人看的样子', () => {
  const at = new Date(2026, 0, 2, 14, 3, 5).getTime();
  assert.equal(formatClock(at), '14:03:05');
  assert.equal(formatClock(0), '');
  assert.equal(formatClock('不是时刻'), '');
});

test('任务板：详情页的耗时更细', () => {
  assert.equal(formatDuration(300), '不到 1 秒');
  assert.equal(formatDuration(12_000), '12 秒');
  assert.equal(formatDuration(185_000), '3 分 5 秒');
  assert.equal(formatDuration(120_000), '2 分');
  assert.equal(formatDuration(3_720_000), '1 小时 2 分');
});

test('任务板：任务号给的是前几位', () => {
  assert.equal(shortId('3f2a9c1b-1234-5678'), '3f2a9c1b');
  assert.equal(shortId('abc'), 'abc');
  assert.equal(shortId(''), '');
});

test('任务板：参数预览只说前两个键', () => {
  assert.equal(argsPreview({ path: 'a.md' }), 'path: a.md');
  assert.equal(
    argsPreview({ path: 'a.md', mode: 'r', extra: '不要' }),
    'path: a.md  mode: r'
  );
  assert.equal(argsPreview(null), '');
  assert.equal(argsPreview('不是参数'), '');
});

test('任务板：步骤节点说得清做了什么', () => {
  const nodes = stepNodes([
    {
      index: 1,
      tool: 'fs.read',
      args: { path: 'a.md' },
      result: '读到了 3 行',
      error: '',
      at: new Date(2026, 0, 2, 14, 3, 5).getTime(),
    },
    { index: 2, tool: 'fs.write', args: null, result: '', error: '写不了' },
    { index: 3, tool: 'Read', label: 'claude code 调了 Read' },
  ]);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].tool, 'fs.read');
  assert.equal(nodes[0].args, 'path: a.md');
  assert.equal(nodes[0].result, '读到了 3 行');
  assert.equal(nodes[0].failed, false);
  assert.equal(nodes[0].time, '14:03:05');
  assert.equal(nodes[1].failed, true);
  assert.equal(nodes[1].error, '写不了');
  assert.equal(nodes[2].label, 'claude code 调了 Read', '有人话就带着');
});

test('任务板：结果与失败各是一句话', () => {
  assert.equal(resultText({ result: '写好了' }), '写好了');
  assert.equal(resultText({ error: '写不了' }), '失败：写不了');
  assert.equal(resultText({}), '');
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
