import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultWindowSpec,
  resolveWindowSpec,
  canDetach,
  hasWidget,
  PLUGIN_WINDOW_MODE,
  PLUGIN_WINDOW_LIMITS,
} from '../../src/shared/plugin.js';

/**
 * 「在新窗口打开」是**桌宠**给所有插件的能力，不是插件的特权。
 * 所以清单里没写 `window` 段，宿主也要能合成出一份来。
 */

test('没写 window 段：合成一份默认规格', () => {
  const spec = defaultWindowSpec({ name: '待办' });
  assert.equal(spec.mode, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.title, '待办');
  assert.equal(spec.width, PLUGIN_WINDOW_LIMITS.width);
  assert.equal(spec.height, PLUGIN_WINDOW_LIMITS.height);
  assert.equal(spec.refreshMs, 0);
  // 没声明过的插件不该一上来就压在别人窗口上。
  assert.equal(spec.alwaysOnTop, false);
  assert.equal(spec.page, '');
});

test('resolveWindowSpec：没写 window 段就用合成的那份', () => {
  const manifest = { id: 'todos', name: '待办' };
  const spec = resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.title, '待办');
  assert.equal(spec.width, PLUGIN_WINDOW_LIMITS.width);
});

test('resolveWindowSpec：写了 window 段就以清单为准', () => {
  const manifest = {
    id: 'todos',
    name: '待办',
    window: { title: '我的待办', width: 500, height: 600 },
  };
  const spec = resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.title, '我的待办');
  assert.equal(spec.width, 500);
  assert.equal(spec.height, 600);
});

test('resolveWindowSpec：widget 没写就是没有（小部件仍然要插件自愿）', () => {
  const manifest = { id: 'todos', name: '待办' };
  assert.equal(resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WIDGET), null);
});

test('resolveWindowSpec：widget 写了就用清单里那份', () => {
  const manifest = {
    id: 'system',
    name: '系统状态',
    widget: { title: '系统监控', width: 216, height: 108 },
  };
  const spec = resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WIDGET);
  assert.equal(spec.title, '系统监控');
  assert.equal(spec.width, 216);
});

test('resolveWindowSpec：清单没经过校验时，返回的也是完整规格', () => {
  const manifest = { id: 'x', name: 'X', window: { width: 500 } };
  const spec = resolveWindowSpec(manifest, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.mode, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(spec.alwaysOnTop, true); // 声明了 window 段 → 默认置顶
  assert.equal(spec.refreshMs, 0);
  assert.equal(spec.width, 500);
});

test('每个插件都能分离成独立窗口', () => {
  assert.equal(canDetach({ id: 'todos', name: '待办' }), true);
  assert.equal(canDetach({ id: 'screen-recorder', name: '录屏' }), true);
});

test('小部件仍然要插件自己声明', () => {
  assert.equal(hasWidget({ id: 'todos', name: '待办' }), false);
  assert.equal(hasWidget({ id: 'system', name: '系统状态', widget: {} }), true);
});
