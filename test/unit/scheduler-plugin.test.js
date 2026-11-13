import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createSchedulerPlugin from '../../plugins/scheduler/main.js';

/**
 * 定时任务插件（主进程侧）。
 *
 * 它做四件事：存下任务、到点跑任务、把状态给界面、给 agent 三个工具。
 * **失败要如实说**——界面显示的是它给的那句话。
 */

/** 一个假的宿主上下文。 */
function fakeCtx(overrides = {}) {
  const said = [];
  const ctx = {
    agent: {
      run: async () => ({ ok: true, taskId: 'agent-1' }),
      tasks: async () => [],
    },
    assistant: {
      say: (text, options) => said.push({ text, options }),
    },
    config: { notifyOnFinish: true, commandTimeoutMinutes: 10 },
    host: {
      isEnabled: () => true,
      setConfig: async () => ({ ok: true }),
    },
    ...overrides,
  };
  return { ctx, said };
}

/** 一条能跑的命令：打印 ok。 */
const HELLO = 'node -e console.log(42)';

/** 等到条件成立。 */
async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('等超时了');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 睡一会儿。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一个临时存盘目录。 */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'scheduler-'));
}

test('定时任务：加一条命令型任务', async () => {
  const dir = await tempDir();
  const { ctx } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  const res = await plugin.act(ctx, 'save', {
    name: '备份',
    type: 'command',
    content: HELLO,
    schedule: { kind: 'interval', everyMinutes: 30 },
  });
  assert.equal(res.ok, true);
  assert.equal(res.tasks.length, 1);
  assert.equal(res.tasks[0].name, '备份');
  assert.equal(res.tasks[0].scheduleText, '每隔 30 分钟');
  assert.ok(res.tasks[0].nextAt > 0);
});

test('定时任务：加完就落盘', async () => {
  const dir = await tempDir();
  const { ctx } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  await plugin.act(ctx, 'save', {
    name: '备份',
    type: 'command',
    content: HELLO,
    schedule: { kind: 'daily', at: '09:00' },
  });
  const saved = JSON.parse(await readFile(join(dir, 'scheduler.json'), 'utf8'));
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.tasks[0].schedule.at, '09:00');
});

test('定时任务：缺名字、缺内容、计划看不懂都要说清楚', async () => {
  const dir = await tempDir();
  const { ctx } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  const noName = await plugin.act(ctx, 'save', { name: ' ', type: 'command', content: 'x' });
  assert.equal(noName.ok, false);
  assert.match(noName.message, /名字/);
  const noContent = await plugin.act(ctx, 'save', { name: 'x', type: 'command', content: ' ' });
  assert.equal(noContent.ok, false);
  const badSchedule = await plugin.act(ctx, 'save', {
    name: 'x',
    type: 'command',
    content: 'y',
    schedule: { kind: 'daily', at: '99:99' },
  });
  assert.equal(badSchedule.ok, false);
  assert.match(badSchedule.message, /HH:MM/);
});

test('定时任务：删掉与关掉', async () => {
  const dir = await tempDir();
  const { ctx } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  const added = await plugin.act(ctx, 'save', {
    name: '备份',
    type: 'command',
    content: HELLO,
    schedule: { kind: 'interval', everyMinutes: 30 },
  });
  const id = added.tasks[0].id;
  const off = await plugin.act(ctx, 'toggle', { id, enabled: false });
  assert.equal(off.tasks[0].enabled, false);
  assert.equal(off.tasks[0].nextText, '');
  const removed = await plugin.act(ctx, 'remove', { id });
  assert.equal(removed.tasks.length, 0);
});

test('定时任务：立刻运行一次，命令真的跑了', async () => {
  const dir = await tempDir();
  const { ctx, said } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  await plugin.act(ctx, 'save', {
    name: '备份',
    type: 'command',
    content: HELLO,
    schedule: { kind: 'interval', everyMinutes: 30 },
  });
  await plugin.act(ctx, 'run', { id: (await plugin.data()).tasks[0].id });
  const data = await waitFor(async () => {
    const snapshot = await plugin.data();
    return snapshot.tasks[0].lastStatus === 'ok' ? snapshot : null;
  });
  assert.match(data.tasks[0].lastResult, /42/);
  assert.ok(said.length > 0, '跑完要说一声');
});

test('定时任务：命令没跑成要说清楚', async () => {
  const dir = await tempDir();
  const { ctx, said } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  await plugin.act(ctx, 'save', {
    name: '会失败的',
    type: 'command',
    content: 'node -e process.exit(3)',
    schedule: { kind: 'interval', everyMinutes: 30 },
  });
  await plugin.act(ctx, 'run', { id: (await plugin.data()).tasks[0].id });
  const data = await waitFor(async () => {
    const snapshot = await plugin.data();
    return snapshot.tasks[0].lastStatus === 'failed' ? snapshot : null;
  });
  assert.match(data.tasks[0].lastResult, /3|Command failed/);
  assert.match(said[0].text, /没跑成/);
});

test('定时任务：到点了就跑', async () => {
  const dir = await tempDir();
  const { ctx, said } = fakeCtx();
  let clock = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const plugin = createSchedulerPlugin(ctx, {
    userDataDir: dir,
    now: () => clock,
    tickMs: 20,
  });
  await plugin.act(ctx, 'save', {
    name: '备份',
    type: 'command',
    content: HELLO,
    schedule: { kind: 'interval', everyMinutes: 1 },
  });
  await sleep(80);
  assert.equal((await plugin.data()).tasks[0].lastStatus, '', '没到点不该跑');
  clock += 61 * 1000;
  const data = await waitFor(async () => {
    const snapshot = await plugin.data();
    return snapshot.tasks[0].lastStatus === 'ok' ? snapshot : null;
  });
  assert.match(data.tasks[0].lastResult, /42/);
  assert.ok(said.length > 0);
});

test('定时任务：插件被关掉了就不跑', async () => {
  const dir = await tempDir();
  const { ctx } = fakeCtx({ host: { isEnabled: () => false, setConfig: async () => ({ ok: true }) } });
  let clock = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const plugin = createSchedulerPlugin(ctx, {
    userDataDir: dir,
    now: () => clock,
    tickMs: 20,
  });
  await plugin.act(ctx, 'save', {
    name: '备份',
    type: 'command',
    content: HELLO,
    schedule: { kind: 'interval', everyMinutes: 1 },
  });
  clock += 61 * 1000;
  await sleep(120);
  assert.equal((await plugin.data()).tasks[0].lastStatus, '');
});

test('定时任务：派单型的到点就派给 agent', async () => {
  const dir = await tempDir();
  const runs = [];
  const { ctx } = fakeCtx({
    agent: {
      run: async (prompt, opts) => {
        runs.push({ prompt, opts });
        return { ok: true, taskId: 'agent-1' };
      },
      tasks: async () => [],
    },
  });
  let clock = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const plugin = createSchedulerPlugin(ctx, {
    userDataDir: dir,
    now: () => clock,
    tickMs: 20,
  });
  await plugin.act(ctx, 'save', {
    name: '整理文件',
    type: 'agent',
    content: '把旧文件挪到归档目录',
    schedule: { kind: 'interval', everyMinutes: 1 },
  });
  clock += 61 * 1000;
  await waitFor(() => runs.length > 0);
  assert.match(runs[0].prompt, /把旧文件挪到归档目录/);
  assert.equal(runs[0].opts.title, '整理文件');
  const data = await plugin.data();
  assert.equal(data.tasks[0].lastStatus, 'dispatched');
});

test('定时任务：agent 做完了就把结果记上', async () => {
  const dir = await tempDir();
  let board = [];
  const { ctx } = fakeCtx({
    agent: {
      run: async () => ({ ok: true, taskId: 'agent-1' }),
      tasks: async () => board,
    },
  });
  let clock = new Date(2026, 0, 1, 8, 0, 0).getTime();
  const plugin = createSchedulerPlugin(ctx, {
    userDataDir: dir,
    now: () => clock,
    tickMs: 20,
  });
  await plugin.act(ctx, 'save', {
    name: '整理文件',
    type: 'agent',
    content: '把旧文件挪到归档目录',
    schedule: { kind: 'interval', everyMinutes: 1 },
  });
  clock += 61 * 1000;
  await waitFor(async () => (await plugin.data()).tasks[0].lastStatus === 'dispatched');
  board = [{ taskId: 'agent-1', status: 'done', result: '挪完了', error: '' }];
  const data = await plugin.data();
  assert.equal(data.tasks[0].lastStatus, 'ok');
  assert.equal(data.tasks[0].lastResult, '挪完了');
});

test('定时任务：存盘里坏掉的任务直接丢掉', async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, 'scheduler.json'),
    JSON.stringify({
      tasks: [
        { id: 'bad', name: '坏的', type: 'command', command: 'x', schedule: { kind: 'daily', at: '99:99' } },
        { id: 'good', name: '好的', type: 'command', command: 'x', schedule: { kind: 'daily', at: '09:00' } },
      ],
    }),
    'utf8'
  );
  const { ctx } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  const data = await plugin.data();
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].name, '好的');
});

test('定时任务：给 agent 的三个工具', async () => {
  const dir = await tempDir();
  const { ctx } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  const tools = plugin.tools(ctx);
  const add = tools.find((t) => t.name === 'scheduler.add');
  const list = tools.find((t) => t.name === 'scheduler.list');
  const remove = tools.find((t) => t.name === 'scheduler.remove');

  const added = await add.run({
    kind: 'agent',
    schedule: '每天 09:00',
    description: '把旧文件挪走',
    name: '整理',
  });
  assert.match(added.text, /加好了定时任务「整理」/);
  assert.equal(added.data.schedule.kind, 'daily');

  const listed = await list.run();
  assert.match(listed.text, /整理/);

  const removed = await remove.run({ id: added.data.id });
  assert.match(removed.text, /删掉了定时任务「整理」/);
  assert.equal((await list.run()).data.items.length, 0);
});

test('定时任务：工具的参数不对要说清楚', async () => {
  const dir = await tempDir();
  const { ctx } = fakeCtx();
  const plugin = createSchedulerPlugin(ctx, { userDataDir: dir });
  const add = plugin.tools(ctx).find((t) => t.name === 'scheduler.add');
  await assert.rejects(() => add.run({ kind: 'agent' }), /定时方式/);
  await assert.rejects(() => add.run({ kind: 'agent', schedule: '有空的时候' }), /没看懂定时方式/);
  await assert.rejects(
    () => add.run({ kind: 'command', schedule: '每天 09:00' }),
    /跑什么命令/
  );
});
