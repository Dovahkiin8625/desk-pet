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
      tick: async () => {
        calls.tick += 1;
        return tickValue;
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
