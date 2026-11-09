import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns } from '../../plugins/chat-history/pages/turns.js';

const NOW = Date.parse('2026-11-08T12:00:00+08:00');
const AT = (text) => Date.parse(`2026-11-08T${text}:00+08:00`);

function entry(kind, text, { id = '', at = AT('10:00'), meta = {}, proactive = false } = {}) {
  return { id: id || `${kind}:${text}`, kind, role: 'assistant', text, at, meta, proactive };
}

test('一次发话收成一块', () => {
  const groups = buildTurns([
    entry('user', '在吗', { at: AT('10:00') }),
    entry('reply', '在呢', { at: AT('10:00') }),
  ], { now: NOW });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].turns.length, 1);
  assert.equal(groups[0].turns[0].title, '在吗');
  assert.equal(groups[0].turns[0].id, 'turn:user:在吗');
});

test('桌宠这边与后台那边分开', () => {
  const groups = buildTurns([
    entry('user', '查视频', { at: AT('10:00') }),
    entry('dispatch', '派了个任务：查视频', { at: AT('10:01'), meta: { tool: 'task.submit', taskId: 't-1', brief: '看看 video 下有什么' } }),
    entry('task', '完成 · 查视频', { at: AT('10:05'), meta: { taskId: 't-1', status: 'done', title: '查视频' } }),
    entry('step', 'fs.list', { at: AT('10:04'), meta: { taskId: 't-1', tool: 'fs.list' } }),
    entry('reply', '有 12 个视频', { at: AT('10:06'), meta: { taskId: 't-1', layer: 'execution' } }),
  ], { now: NOW });
  const turn = groups[0].turns[0];
  assert.equal(turn.front.filter((l) => l.type === 'dispatch').length, 1);
  assert.equal(turn.back.length, 1);
  assert.equal(turn.back[0].taskId, 't-1');
  assert.equal(turn.back[0].result.text, '有 12 个视频');
});

test('后台任务晚完成：结果回到发起它的那一轮', () => {
  // 用户在 10:00 派了单，10:05 任务完成——完成记录不能自己另起一块。
  const groups = buildTurns([
    entry('user', '查视频', { at: AT('10:00') }),
    entry('dispatch', '派单', { at: AT('10:01'), meta: { tool: 'task.submit', taskId: 't-1' } }),
    entry('user', '顺便看看天气', { at: AT('10:03') }),
    entry('reply', '有 12 个视频', { at: AT('10:05'), meta: { taskId: 't-1' } }),
  ], { now: NOW });
  assert.equal(groups[0].turns.length, 2);
  assert.equal(groups[0].turns[1].back[0].result.text, '有 12 个视频');
  assert.equal(groups[0].turns[0].back.length, 0);
});

test('同一个任务号有多条派单：任务归最早那一轮，后来的动作留在自己那一轮', () => {
  const groups = buildTurns([
    entry('user', '查视频', { at: AT('10:00') }),
    entry('dispatch', '派单', { at: AT('10:01'), meta: { tool: 'task.submit', taskId: 't-1' } }),
    entry('user', '停掉它', { at: AT('10:02') }),
    entry('dispatch', '停掉', { at: AT('10:03'), meta: { tool: 'task.cancel', taskId: 't-1' } }),
    entry('task', '已取消', { at: AT('10:04'), meta: { taskId: 't-1', status: 'cancelled' } }),
  ], { now: NOW });
  assert.equal(groups[0].turns[1].back.length, 1);
  assert.equal(groups[0].turns[0].front.filter((l) => l.type === 'dispatch').length, 1);
});

test('找不到派单的任务：自己成一块', () => {
  const groups = buildTurns([
    entry('task', '完成 · 查视频', { at: AT('10:05'), meta: { taskId: 't-9', status: 'done', title: '查视频' } }),
    entry('step', 'fs.list', { at: AT('10:04'), meta: { taskId: 't-9', tool: 'fs.list' } }),
  ], { now: NOW });
  assert.equal(groups[0].turns.length, 1);
  assert.equal(groups[0].turns[0].back.length, 1);
  assert.equal(groups[0].turns[0].title, '查视频');
});

test('没有锚点的记录：自己成一块，不丢', () => {
  const groups = buildTurns([
    entry('model', '我先看看剪贴板', { at: AT('10:00'), meta: { layer: 'interaction', index: 1 } }),
  ], { now: NOW });
  assert.equal(groups[0].turns.length, 1);
  assert.equal(groups[0].turns[0].front.length, 1);
});

test('徽标：已答 / 后台运行中 / 已完成 / 失败', () => {
  const answered = buildTurns([entry('user', '在吗'), entry('reply', '在呢')], { now: NOW })[0].turns[0];
  assert.equal(answered.badge, 'answered');

  const running = buildTurns([
    entry('user', '查视频'),
    entry('dispatch', '派单', { meta: { tool: 'task.submit', taskId: 't-1' } }),
    entry('task', '进行中', { meta: { taskId: 't-1', status: 'running' } }),
  ], { now: NOW })[0].turns[0];
  assert.equal(running.badge, 'running');

  const done = buildTurns([
    entry('user', '查视频'),
    entry('dispatch', '派单', { meta: { tool: 'task.submit', taskId: 't-1' } }),
    entry('task', '完成', { meta: { taskId: 't-1', status: 'done' } }),
  ], { now: NOW })[0].turns[0];
  assert.equal(done.badge, 'done');

  const failed = buildTurns([entry('user', '在吗')], { now: NOW })[0].turns[0];
  assert.equal(failed.badge, 'failed');
});

test('时间分组：今天 / 昨天 / 更早按月', () => {
  const at = (iso) => Date.parse(iso);
  const groups = buildTurns([
    entry('user', '今天的', { at: at('2026-11-08T09:00:00+08:00') }),
    entry('user', '昨天的', { at: at('2026-11-07T09:00:00+08:00') }),
    entry('user', '上月的', { at: at('2026-10-20T09:00:00+08:00') }),
    entry('user', '去年同月的', { at: at('2025-10-20T09:00:00+08:00') }),
  ], { now: NOW });
  assert.deepEqual(
    groups.map((g) => g.key),
    ['today', 'yesterday', '2026-10', '2025-10']
  );
  assert.deepEqual(
    groups.map((g) => g.label),
    ['今天', '昨天', '10月', '2025年10月']
  );
});

test('同一组里：晚的块在前，组也按时间倒序', () => {
  const groups = buildTurns([
    entry('user', '早的', { at: AT('10:00') }),
    entry('user', '晚的', { at: AT('11:00') }),
  ], { now: NOW });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].turns[0].title, '晚的');
  assert.equal(groups[0].turns[1].title, '早的');
});

test('连续的无锚点记录：合成一块，并标出没有对应的那句话', () => {
  const groups = buildTurns([
    entry('model', '我先看看剪贴板', { at: AT('10:00'), meta: { layer: 'interaction', index: 1 } }),
    entry('model', '再看看目录', { at: AT('10:01'), meta: { layer: 'interaction', index: 2 } }),
  ], { now: NOW });
  assert.equal(groups[0].turns.length, 1);
  assert.equal(groups[0].turns[0].orphan, true);
  assert.equal(groups[0].turns[0].front.length, 2);
  assert.equal(groups[0].turns[0].title, '我先看看剪贴板');
});

test('一块里的话按时间升序', () => {
  const groups = buildTurns([
    entry('user', '查视频', { at: AT('10:00') }),
    entry('model', '我先看看', { at: AT('10:01'), meta: { layer: 'interaction', index: 1 } }),
    entry('reply', '有 12 个视频', { at: AT('10:02') }),
  ], { now: NOW });
  const front = groups[0].turns[0].front;
  assert.deepEqual(front.map((l) => l.type), ['model', 'reply']);
});

test('桌宠主动搭话：自己开一块', () => {
  const groups = buildTurns([
    entry('reply', '早上好', { at: AT('10:00'), proactive: true }),
  ], { now: NOW });
  assert.equal(groups[0].turns.length, 1);
  assert.equal(groups[0].turns[0].opener, 'pet');
  assert.equal(groups[0].turns[0].title, '早上好');
});

test('桌宠说了两次话：两块', () => {
  const groups = buildTurns([
    entry('reply', '早上好', { at: AT('10:00'), proactive: true }),
    entry('reply', '要出门吗', { at: AT('10:05'), proactive: true }),
  ], { now: NOW });
  assert.equal(groups[0].turns.length, 2);
  assert.equal(groups[0].turns[0].title, '要出门吗');   // 组内倒序，晚的在前
  assert.equal(groups[0].turns[1].title, '早上好');
});

test('徽标：任务失败了也是失败', () => {
  const groups = buildTurns([
    entry('user', '查视频', { at: AT('10:00') }),
    entry('dispatch', '派单', { at: AT('10:01'), meta: { tool: 'task.submit', taskId: 't-1' } }),
    entry('task', '失败', { at: AT('10:02'), meta: { taskId: 't-1', status: 'failed' } }),
  ], { now: NOW });
  assert.equal(groups[0].turns[0].badge, 'failed');
});

test('交互层的快工具：桌宠这边多一行', () => {
  const groups = buildTurns([
    entry('user', '几点了', { at: AT('10:00') }),
    entry('step', 'clock.now', { at: AT('10:01'), meta: { layer: 'interaction', tool: 'clock.now' } }),
    entry('reply', '三点了', { at: AT('10:02') }),
  ], { now: NOW });
  const call = groups[0].turns[0].front.find((l) => l.type === 'call');
  assert.ok(call, '应该有一行调工具');
  assert.equal(call.tool, 'clock.now');
});

test('答复拿不到轮数：退回数 model 记录的条数', () => {
  const groups = buildTurns([
    entry('user', '在吗', { at: AT('10:00') }),
    entry('model', '在', { at: AT('10:01'), meta: { layer: 'interaction', index: 1, model: 'MiniMax-M2' } }),
    entry('reply', '在呢', { at: AT('10:02') }),
  ], { now: NOW });
  const reply = groups[0].turns[0].front.find((l) => l.type === 'reply');
  assert.equal(reply.rounds, 1);
  assert.equal(reply.model, 'MiniMax-M2');
});

test('答复带了轮数与模型名：用它，不数 model 记录', () => {
  const groups = buildTurns([
    entry('user', '在吗', { at: AT('10:00') }),
    entry('model', '在', { at: AT('10:01'), meta: { layer: 'interaction', index: 1, model: 'MiniMax-M2' } }),
    entry('reply', '在呢', { at: AT('10:02'), meta: { rounds: 3, model: 'stub-model' } }),
  ], { now: NOW });
  const reply = groups[0].turns[0].front.find((l) => l.type === 'reply');
  assert.equal(reply.rounds, 3);
  assert.equal(reply.model, 'stub-model');
});

test('没有 kind 的旧记录：按 role 兜底，不丢', () => {
  const groups = buildTurns([
    { id: 'old-1', role: 'assistant', text: '旧记录', at: AT('10:00') },
  ], { now: NOW });
  assert.equal(groups[0].turns.length, 1);
  assert.equal(groups[0].turns[0].front.length, 1);
});

test('没有 taskId 的 task / approval：留在桌宠这边，不丢', () => {
  const groups = buildTurns([
    entry('user', '查视频', { at: AT('10:00') }),
    entry('task', '完成 · 查视频', { at: AT('10:01'), meta: { status: 'done', title: '查视频' } }),
    entry('approval', '要批一下', { at: AT('10:02'), meta: { tool: 'fs.write', decision: 'allow' } }),
  ], { now: NOW });
  const front = groups[0].turns[0].front;
  assert.equal(front.filter((l) => l.type === 'task').length, 1);
  assert.equal(front.filter((l) => l.type === 'approval').length, 1);
});
