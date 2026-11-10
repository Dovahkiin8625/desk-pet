import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentFacade } from '../../src/main/assistant/agent/facade.js';
import { createPluginHost } from '../../src/main/plugins/host.js';

/**
 * agent 的对外接口（插件用它反向提交任务）。
 *
 * L1 只交付**接缝**：后台任务运行时排在 L3（T9），
 * 所以 run/cancel 明确说「还没上线」，不假装成功——
 * 插件作者拿到一个假成功会以为任务在跑，而它根本没进队列。
 */

test('facade：没有运行时时，提交任务明确说还没上线', async () => {
  const agent = createAgentFacade({});
  const r = await agent.run('帮我看看项目');
  assert.equal(r.ok, false);
  assert.match(r.message, /还没上线/);
  assert.equal(r.taskId, undefined, '不能编一个任务号出来');
});

test('facade：运行时接上后，提交与取消都转给它', async () => {
  const calls = [];
  const runtime = {
    run: async (prompt, opts) => {
      calls.push(['run', prompt, opts]);
      return { ok: true, taskId: 't1' };
    },
    cancel: async (taskId) => {
      calls.push(['cancel', taskId]);
      return { ok: true };
    },
  };
  const agent = createAgentFacade({ runtime });
  assert.deepEqual(await agent.run('做事', { tag: 'x' }), { ok: true, taskId: 't1' });
  assert.deepEqual(await agent.cancel('t1'), { ok: true });
  assert.deepEqual(calls, [
    ['run', '做事', { tag: 'x' }],
    ['cancel', 't1'],
  ]);
});

test('facade：没接线时，任务与审批的口子都降级', async () => {
  const agent = createAgentFacade({});
  assert.deepEqual(await agent.tasks(), []);
  assert.deepEqual(await agent.approvals(), []);
  const results = [
    await agent.steer('t1', '快点'),
    await agent.archive('t1'),
    await agent.answerApproval('a1', 'allow'),
  ];
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.match(r.message, /还没上线/);
  }
});

test('facade：接线之后，任务与审批都转过去', async () => {
  const calls = [];
  const agent = createAgentFacade({
    runtime: {
      list: () => [{ taskId: 't1', status: 'running' }],
      steer: (taskId, note) => {
        calls.push(['steer', taskId, note]);
        return { ok: true };
      },
      archive: (taskId) => {
        calls.push(['archive', taskId]);
        return { ok: true };
      },
    },
    approvals: {
      list: () => [{ id: 'a1', taskId: 't1', title: '需要你点头' }],
      answer: (id, decision) => {
        calls.push(['answer', id, decision]);
        return { ok: true };
      },
    },
  });
  assert.equal((await agent.tasks()).length, 1);
  assert.equal((await agent.approvals())[0].id, 'a1');
  assert.deepEqual(await agent.steer('t1', '快点'), { ok: true });
  assert.deepEqual(await agent.archive('t1'), { ok: true });
  assert.deepEqual(await agent.answerApproval('a1', 'allow'), { ok: true });
  assert.deepEqual(calls, [
    ['steer', 't1', '快点'],
    ['archive', 't1'],
    ['answer', 'a1', 'allow'],
  ]);
});

test('facade：历史读的是聊天记录', () => {
  const agent = createAgentFacade({ getHistory: () => [{ id: '1', kind: 'user', text: '在呢' }] });
  assert.equal(agent.history().length, 1);
});

test('facade：没有历史源就空数组，别抛错', () => {
  const agent = createAgentFacade({});
  assert.deepEqual(agent.history(), []);
});

test('facade：订阅事件能收到，也能退订', () => {
  const agent = createAgentFacade({});
  const got = [];
  const off = agent.onEvent((e) => got.push(e));
  agent.emit({ type: 'step', text: '做了一步' });
  assert.equal(got.length, 1);
  off();
  agent.emit({ type: 'step', text: '又一步' });
  assert.equal(got.length, 1, '退订之后不该再收到');
});

test('facade：订阅者抛异常不许带崩别人', () => {
  const agent = createAgentFacade({});
  const got = [];
  agent.onEvent(() => {
    throw new Error('炸了');
  });
  agent.onEvent((e) => got.push(e));
  agent.emit({ type: 'step' });
  assert.equal(got.length, 1);
});

test('facade：工具表挂在上面', () => {
  const tools = { get: () => null };
  const agent = createAgentFacade({ tools });
  assert.equal(agent.tools, tools);
});

/** 摆一个插件目录。 */
async function makePlugin(root, id, manifest, main) {
  const dir = join(root, 'plugins', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (main) await writeFile(join(dir, 'main.js'), main, 'utf8');
  return dir;
}

test('宿主：插件拿得到 ctx.agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  // 插件的 main.js 是**另一个模块**，闭包里的变量它看不见；
  // 所以借 globalThis 把 ctx.agent 递回来。
  globalThis.__deskPetSeenAgent = null;
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气' },
      `export default function create(ctx) {
         globalThis.__deskPetSeenAgent = ctx.agent;
         return { tools() { return []; } };
       }`
    );
    const agent = createAgentFacade({
      getHistory: () => [{ id: '1', kind: 'user', text: '在呢' }],
    });
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: root,
      assistant: {},
      agent,
    });
    await host.load();
    const seen = globalThis.__deskPetSeenAgent;
    assert.ok(seen, 'ctx.agent 应该在');
    assert.equal(typeof seen.run, 'function');
    assert.equal(typeof seen.cancel, 'function');
    assert.equal(typeof seen.history, 'function');
    assert.equal(typeof seen.onEvent, 'function');
    assert.equal(typeof seen.tasks, 'function');
    assert.equal(typeof seen.steer, 'function');
    assert.equal(typeof seen.archive, 'function');
    assert.equal(typeof seen.approvals, 'function');
    assert.equal(typeof seen.answerApproval, 'function');
    assert.equal(seen.history().length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：没有 agent 时，ctx.agent 是个能调的空壳', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  globalThis.__deskPetSeenAgent = null;
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气' },
      `export default function create(ctx) { globalThis.__deskPetSeenAgent = ctx.agent; return {}; }`
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: root,
      assistant: {},
    });
    await host.load();
    const seen = globalThis.__deskPetSeenAgent;
    assert.ok(seen);
    assert.equal(typeof seen.run, 'function');
    const r = await seen.run('做点什么');
    assert.equal(r.ok, false);
    assert.match(r.message, /还没上线/);
    assert.deepEqual(seen.history(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
