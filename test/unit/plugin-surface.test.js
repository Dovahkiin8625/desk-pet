import test from 'node:test';
import assert from 'node:assert/strict';

import { createSurfaceController } from '../../src/main/plugins/surface.js';

/**
 * 界面路由：插件的界面挂在哪、周期数据推给谁、tick 定时器什么时候起停。
 *
 * 这一层**不碰 Electron**：它只管「哪个 surface 该收到哪条数据」。
 */

/** 假宿主：只提供 surface 控制器要用到的两样东西。 */
function fakeHost({ refreshMs = 0, tickValue = 'T' } = {}) {
  const calls = { tick: 0 };
  return {
    calls,
    host: {
      spec: () => ({ refreshMs }),
      refresh: async () => {
        calls.tick += 1;
        return { kind: 'tick', data: tickValue };
      },
    },
  };
}

/** 假 surface：记录收到的东西。 */
function fakeSurface(kind = 'panel') {
  const received = [];
  return {
    received,
    surface: {
      kind,
      deliver: (k, payload) => received.push({ kind: k, payload }),
    },
  };
}

test('没有 surface 挂着：不推数据，也不起定时器', () => {
  const { host, calls } = fakeHost({ refreshMs: 100 });
  const ctl = createSurfaceController({ host });
  ctl.broadcast('todos', 'tick', 'x');
  assert.equal(calls.tick, 0);
  assert.equal(ctl.isAttached('todos'), false);
});

test('挂着两个 surface：一次 tick 两边都收到', () => {
  const { host } = fakeHost();
  const ctl = createSurfaceController({ host });
  const a = fakeSurface('panel');
  const b = fakeSurface('window');
  ctl.attach('todos', a.surface);
  ctl.attach('todos', b.surface);
  ctl.broadcast('todos', 'tick', { n: 1 });
  // 数据一律包成 `{ pluginId, data }`：面板可能在两个插件之间来回切，
  // 收到的数据得带得清是给谁的。
  assert.deepEqual(a.received, [{ kind: 'tick', payload: { pluginId: 'todos', data: { n: 1 } } }]);
  assert.deepEqual(b.received, [{ kind: 'tick', payload: { pluginId: 'todos', data: { n: 1 } } }]);
});

test('周期刷新推的是宿主给的「这一轮推什么」', async () => {
  const { host, calls } = fakeHost({ refreshMs: 20 });
  const ctl = createSurfaceController({ host });
  const a = fakeSurface('panel');
  ctl.attach('todos', a.surface);
  await new Promise((r) => setTimeout(r, 70));
  // kind 由宿主决定：自带页面的插件推数据，声明式界面推重算过的页面。
  assert.ok(calls.tick >= 2, `应该至少推了两次，实际 ${calls.tick}`);
  assert.equal(a.received[0].kind, 'tick');
  assert.deepEqual(a.received[0].payload, { pluginId: 'todos', data: 'T' });
  ctl.detach('todos', a.surface);
});

test('摘掉一个 surface：另一个还收得到', () => {
  const { host } = fakeHost();
  const ctl = createSurfaceController({ host });
  const a = fakeSurface('panel');
  const b = fakeSurface('window');
  ctl.attach('todos', a.surface);
  ctl.attach('todos', b.surface);
  ctl.detach('todos', a.surface);
  ctl.broadcast('todos', 'tick', 'x');
  assert.equal(a.received.length, 0);
  assert.equal(b.received.length, 1);
});

test('一个插件只有一个定时器：挂着几个界面都只刷一次', async () => {
  // **定时器按插件算，不按界面算。**
  //
  // 两处界面同时开着同一个插件时，宿主只该被问一次「这一轮推什么」——
  // 问两次就是两份 tick（既白费力气，又让页面收到重复的推送）。
  const { host, calls } = fakeHost({ refreshMs: 20 });
  const ctl = createSurfaceController({ host });
  const a = fakeSurface('panel');
  const b = fakeSurface('window');
  ctl.attach('todos', a.surface);
  ctl.attach('todos', b.surface);
  await new Promise((r) => setTimeout(r, 70));
  // 70ms / 20ms ≈ 3 次。**不是 6 次**（两个界面各起一个定时器的话）。
  assert.ok(
    calls.tick <= 4,
    `一个插件只该有一个定时器：70ms 内刷新了 ${calls.tick} 次（两个定时器会是 6 次左右）`
  );
  // 但两份数据都该送到——两处界面看到的数据必须一致。
  assert.ok(a.received.length >= 2, '面板那边没收到');
  assert.ok(b.received.length >= 2, '窗口那边没收到');
  assert.equal(a.received.length, b.received.length, '两处收到的次数应该一样');
  ctl.detach('todos', a.surface);
  ctl.detach('todos', b.surface);
});

test('refreshMs 为 0 的插件不起定时器', () => {
  const { host, calls } = fakeHost({ refreshMs: 0 });
  const ctl = createSurfaceController({ host });
  const a = fakeSurface();
  ctl.attach('todos', a.surface);
  assert.equal(calls.tick, 0);
  ctl.detach('todos', a.surface);
});

test('摘掉最后一个 surface：定时器停掉', async () => {
  const { host, calls } = fakeHost({ refreshMs: 20 });
  const ctl = createSurfaceController({ host });
  const a = fakeSurface();
  ctl.attach('todos', a.surface);
  await new Promise((r) => setTimeout(r, 70));
  assert.ok(calls.tick >= 2, `应该至少推了两次，实际 ${calls.tick}`);
  const before = calls.tick;
  ctl.detach('todos', a.surface);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(calls.tick, before, '摘掉之后不该再推');
});

test('stopAll：所有定时器都停掉', async () => {
  const { host, calls } = fakeHost({ refreshMs: 20 });
  const ctl = createSurfaceController({ host });
  ctl.attach('todos', fakeSurface().surface);
  ctl.attach('system', fakeSurface().surface);
  await new Promise((r) => setTimeout(r, 70));
  ctl.stopAll();
  const before = calls.tick;
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(calls.tick, before);
});

test('界面开合：第一个挂上来报「开」，最后一个摘掉报「关」', () => {
  const { host } = fakeHost();
  const events = [];
  const ctl = createSurfaceController({
    host,
    onChange: (pluginId, open) => events.push({ pluginId, open }),
  });
  const a = fakeSurface('panel');
  const b = fakeSurface('window');
  ctl.attach('todos', a.surface);
  ctl.attach('todos', b.surface);
  ctl.detach('todos', a.surface);
  // 还挂着另一个界面：不该报「关」。
  assert.deepEqual(events, [{ pluginId: 'todos', open: true }]);
  ctl.detach('todos', b.surface);
  assert.deepEqual(events, [
    { pluginId: 'todos', open: true },
    { pluginId: 'todos', open: false },
  ]);
});
