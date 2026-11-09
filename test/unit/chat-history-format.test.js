import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approvalLabel,
  approvalLineLabel,
  argsPreview,
  badgeLabel,
  BRIEF_LABEL,
  dispatchLabel,
  fastToolLabel,
  modelHeadLabel,
  modelRoundLabel,
  ORPHAN_LABEL,
  PET_LABEL,
  RESULT_LABEL,
  resultText,
  statusLabel,
  statusTrail,
  stepLabel,
  stepsLabel,
  TOOL_ERROR_LABEL,
  taskLabel,
  taskLineLabel,
} from '../../plugins/chat-history/pages/format.js';

/**
 * 聊天记录页面上的**纯逻辑**：一条步骤怎么变成一行字。
 *
 * 规格 §10.4 画的是「`fs.list  src/`」——工具名加上它拿到的东西。
 * 只画工具名的话，用户看到一串名字，看不出这一步到底动了什么。
 */

test('步骤的一行字：工具名 + 它拿到的东西', () => {
  const label = stepLabel({
    text: 'fs.list',
    meta: { tool: 'fs.list', args: { path: 'src/' } },
  });
  assert.equal(label, 'fs.list  path: src/');
});

test('步骤的一行字：没有参数就只画工具名', () => {
  assert.equal(stepLabel({ text: 'fs.list', meta: { tool: 'fs.list' } }), 'fs.list');
});

test('步骤的一行字：没有正文就退回工具名', () => {
  assert.equal(stepLabel({ meta: { tool: 'fs.read' } }), 'fs.read');
});

test('步骤的一行字：什么都没有就说「步骤」', () => {
  assert.equal(stepLabel(null), '步骤');
});

test('参数预览：只看前两个参数', () => {
  const preview = argsPreview({ a: '1', b: '2', c: '3' });
  assert.equal(preview, 'a: 1  b: 2');
});

test('参数预览：太长的值截断', () => {
  const preview = argsPreview({ path: 'x'.repeat(100) });
  assert.equal(preview.length, 'path: '.length + 61);
  assert.ok(preview.endsWith('…'));
});

test('参数预览：不是对象就当没有', () => {
  assert.equal(argsPreview(null), '');
  assert.equal(argsPreview('src/'), '');
  assert.equal(argsPreview(['a']), '');
});

test('快工具：说人话，带上第一个参数', () => {
  assert.equal(fastToolLabel('clipboard.read', null), '调了一次剪贴板');
  assert.equal(fastToolLabel('fs.read', { path: 'a.txt' }), '读了一个文件 a.txt');
  assert.equal(fastToolLabel('fs.list', { path: 'F:/video' }), '看了目录 F:/video');
  assert.equal(fastToolLabel('clock.now', null), '问了时间');
});

test('快工具：不认识的工具也不把工具名甩给用户看', () => {
  assert.equal(fastToolLabel('weird.tool', null), '做了个操作');
});

test('快工具：参数太长截到 40 字', () => {
  const label = fastToolLabel('fs.read', { path: 'x'.repeat(80) });
  assert.ok(label.startsWith('读了一个文件 '));
  assert.ok(label.endsWith('…'));
  assert.equal(label.length, '读了一个文件 '.length + 41);
});

test('派单：五个任务管理工具各有一句', () => {
  assert.equal(dispatchLabel({ tool: 'task.submit', title: '查视频' }), '派了个后台任务：查视频');
  assert.equal(dispatchLabel({ tool: 'task.list' }), '看了看后台任务');
  assert.equal(dispatchLabel({ tool: 'task.cancel', title: '查视频' }), '停掉了任务：查视频');
  assert.equal(dispatchLabel({ tool: 'task.delete', title: '查视频' }), '归档了任务：查视频');
  assert.equal(dispatchLabel({ tool: 'task.steer' }), '给任务追加了一句要求');
});

test('派单：不显示任务号', () => {
  const label = dispatchLabel({ tool: 'task.cancel', taskId: 't-1', title: '查视频' });
  assert.ok(!label.includes('t-1'));
});

test('派单：取不到标题就退成一句人话，也不显示任务号', () => {
  assert.equal(dispatchLabel({ tool: 'task.cancel', taskId: 't-1' }), '停掉了那个后台任务');
  assert.equal(dispatchLabel({ tool: 'task.delete', taskId: 't-9' }), '归档了那个后台任务');
});

test('派单：不认识的工具就显示它自己的动作原文', () => {
  assert.equal(dispatchLabel({ tool: 'other', action: '干点别的' }), '干点别的');
});

test('派单：不认识的工具又没有动作原文，也得有一句人话', () => {
  assert.equal(dispatchLabel({ tool: 'other' }), '做了个后台操作');
  assert.equal(dispatchLabel({ tool: 'other', action: '' }), '做了个后台操作');
});

test('任务状态：说人话', () => {
  assert.equal(statusLabel('queued'), '排队中');
  assert.equal(statusLabel('running'), '进行中');
  assert.equal(statusLabel('waiting_approval'), '等你点头');
  assert.equal(statusLabel('done'), '完成');
  assert.equal(statusLabel('failed'), '失败');
});

test('任务状态：流水写成「排队中 → 进行中」', () => {
  assert.equal(statusTrail(['queued', 'running']), '排队中 → 进行中');
  assert.equal(statusTrail([]), '');
  assert.equal(statusTrail(null), '');
});

test('任务状态：流水里连续重复的状态只留一个', () => {
  assert.equal(statusTrail(['queued', 'running', 'running']), '排队中 → 进行中');
  assert.equal(statusTrail(['running', 'running', 'running']), '进行中');
});

test('徽标：四种', () => {
  assert.equal(badgeLabel('answered'), '已答');
  assert.equal(badgeLabel('running'), '后台运行中');
  assert.equal(badgeLabel('done'), '已完成');
  assert.equal(badgeLabel('failed'), '失败');
});

test('模型：标题写模型名与轮数', () => {
  assert.equal(modelHeadLabel('MiniMax-M2', 3), '问模型 MiniMax-M2 · 3 轮');
});

test('模型：每一轮写自己的号', () => {
  assert.equal(modelRoundLabel(1, '我先看看剪贴板'), '第 1 轮：我先看看剪贴板');
  assert.equal(modelRoundLabel(0, '我先看看剪贴板'), '我先看看剪贴板');
});

test('后台那边：步骤、结果、任务标题', () => {
  assert.equal(stepsLabel(3), '步骤（3）');
  assert.equal(RESULT_LABEL, '结果');
  assert.equal(resultText('有 12 个视频'), '有 12 个视频');
  assert.equal(taskLabel('查视频', 'running'), '查视频 · 进行中');
});

test('审批：说人话', () => {
  assert.equal(approvalLabel('allow'), '有个操作已允许');
  assert.equal(approvalLabel('deny'), '有个操作已拒绝');
  assert.equal(approvalLabel(''), '有个操作等你点头');
});

test('旧数据兜底：没有任务号的任务记录也要有一句人话', () => {
  assert.equal(taskLineLabel({ title: '查视频', status: 'done' }), '查视频 · 完成');
  assert.equal(taskLineLabel({ meta: { title: '查视频', status: 'done' } }), '查视频 · 完成');
  assert.equal(taskLineLabel({}), '有个后台任务');
});

test('旧数据兜底：没有任务号的审批记录也要有一句人话', () => {
  assert.equal(approvalLineLabel({ decision: 'allow' }), '有个操作已允许');
  assert.equal(approvalLineLabel({ meta: { decision: 'deny' } }), '有个操作已拒绝');
  assert.equal(approvalLineLabel({}), '有个操作等你点头');
});

test('页面上的固定说法', () => {
  assert.equal(BRIEF_LABEL, '交底');
  assert.equal(TOOL_ERROR_LABEL, '这个工具这次没调成');
  assert.equal(ORPHAN_LABEL, '没有对应的那句话');
  assert.equal(PET_LABEL, '桌宠自己起的头');
});
