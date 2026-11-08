import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_SETTINGS, builtinFeatures, isBuiltin } from '../../src/main/builtins.js';

/**
 * 内置功能的测试。
 *
 * 它们**不是插件**：不住在插件目录里、不能被关掉、
 * 也不出现在插件清单里——但它们要和插件一起出现在面板的搜索结果中，
 * 所以形状必须与插件的元数据一致。
 *
 * 「聊天记录」原来也是内置功能，现在改成插件了
 * （见 plugins/chat-history/），所以这里只剩「设置」。
 */

test('内置：设置在清单里，形状与插件一致', () => {
  const list = builtinFeatures();
  assert.deepEqual(list.map((f) => f.id), [BUILTIN_SETTINGS]);

  for (const f of list) {
    assert.ok(f.name, '得有个名字');
    assert.ok(f.icon, '得有个图标');
    assert.ok(Array.isArray(f.keywords) && f.keywords.length > 0, '得有关键词，不然搜不到');
    // 内置的不能分离成独立窗口/小部件——它们不是插件。
    assert.equal(f.canDetach, false);
    assert.equal(f.hasWidget, false);
    assert.equal(f.builtin, true);
  }
});

test('内置：认得出内置功能，认不出插件', () => {
  assert.equal(isBuiltin(BUILTIN_SETTINGS), true);
  assert.equal(isBuiltin('todos'), false);
  assert.equal(isBuiltin('chat-history'), false);
  assert.equal(isBuiltin(''), false);
});
