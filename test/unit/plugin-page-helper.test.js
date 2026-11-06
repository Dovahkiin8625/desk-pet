import test from 'node:test';
import assert from 'node:assert/strict';

import { bindSurface } from '../../src/renderer/ui/pluginPage.js';

/**
 * 插件页面助手。
 *
 * 它得认得出自己身处何处：
 * - 顶层被直接加载（小部件形态）→ 用 `window.plugin`；
 * - 独立窗口的 iframe 里 → 用 `parent.plugin`（壳的 preload）；
 * - 面板的 iframe 里 → 用 `parent.panel.surface`。
 *
 * 这个模块在**调用时**才读 `window` / `location`，
 * 所以每个用例前把全局替掉就行。
 */

/** 造一个假的通道：记下宿主那边会发生什么。 */
function fakeChannel(extra = {}) {
  return {
    id: 'todos',
    mode: 'window',
    data: async () => ({ n: 1 }),
    onData: () => {},
    onTick: () => {},
    act: async (actionId, payload) => ({ actionId, payload }),
    action: async () => null,
    ...extra,
  };
}

/** 把全局的 window / location 换掉。 */
function stubGlobals({ self = {}, parent = undefined, search = '' } = {}) {
  globalThis.window = { ...self, parent };
  globalThis.location = { search };
}

test('顶层被直接加载：用的是自己身上的 window.plugin', async () => {
  stubGlobals({ self: { plugin: fakeChannel() }, search: '?plugin=todos&mode=window' });
  const surface = bindSurface();
  assert.equal(surface.id, 'todos');
  assert.equal(surface.mode, 'window');
  assert.deepEqual(await surface.data(), { n: 1 });
  assert.deepEqual(await surface.act('ping', { a: 1 }), { actionId: 'ping', payload: { a: 1 } });
});

test('在独立窗口的 iframe 里：用的是父页面的 plugin', async () => {
  stubGlobals({
    self: {},
    parent: { plugin: fakeChannel({ data: async () => ({ from: 'parent' }) }) },
    search: '?plugin=todos',
  });
  const surface = bindSurface();
  assert.deepEqual(await surface.data(), { from: 'parent' });
});

test('在面板的 iframe 里：用的是父页面的 panel.surface', async () => {
  stubGlobals({
    self: {},
    parent: { panel: { surface: fakeChannel({ data: async () => ({ from: 'panel' }) }) } },
    search: '?plugin=todos',
  });
  const surface = bindSurface();
  assert.deepEqual(await surface.data(), { from: 'panel' });
});

test('推来的数据按 {pluginId, data} 包着：拆包，并按 pluginId 过滤', async () => {
  let onDataCb = null;
  stubGlobals({
    self: {},
    parent: {
      plugin: fakeChannel({
        onData: (cb) => {
          onDataCb = cb;
        },
      }),
    },
    search: '?plugin=todos',
  });
  const surface = bindSurface();
  const seen = [];
  surface.onData((data) => seen.push(data));

  // 别的插件的数据：面板切过插件，迟到的数据不能串过来。
  onDataCb({ pluginId: 'other', data: { x: 1 } });
  // 自己的数据：拆包之后进来。
  onDataCb({ pluginId: 'todos', data: { x: 2 } });

  assert.deepEqual(seen, [{ x: 2 }]);
});

test('setStatus / setHeight 用 postMessage 告诉父页面', async () => {
  const posted = [];
  stubGlobals({
    self: {},
    parent: { postMessage: (message) => posted.push(message) },
    search: '?plugin=todos',
  });
  const surface = bindSurface();
  surface.setStatus('正在录制');
  surface.setHeight(123);
  assert.equal(posted[0].type, 'desk-pet:surface:status');
  assert.equal(posted[0].text, '正在录制');
  assert.equal(posted[0].pluginId, 'todos');
  assert.equal(posted[1].type, 'desk-pet:surface:height');
  assert.equal(posted[1].height, 123);
});

test('哪条通道都找不到时：各项都是空操作，不抛错', async () => {
  stubGlobals({ self: {}, parent: undefined, search: '' });
  const surface = bindSurface();
  assert.equal(await surface.data(), null);
  assert.equal(await surface.act('x'), null);
  surface.onData(() => {});
  surface.onTick(() => {});
});
