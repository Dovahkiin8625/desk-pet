import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_SETTINGS,
  BUILTIN_HISTORY,
  builtinFeatures,
  isBuiltin,
  builtinPage,
  builtinAction,
} from '../../src/main/builtins.js';

/**
 * 内置功能（设置、聊天记录）的测试。
 *
 * 它们**不是插件**：不住在插件目录里、不能被关掉、
 * 也不出现在插件清单里——但它们要和插件一起出现在面板的搜索结果中，
 * 所以形状必须与插件的元数据一致。
 */

/** 一个假的助理：只提供聊天记录那两样。 */
function fakeAssistant(messages = []) {
  return {
    chatHistoryView: () => ({ messages, total: messages.length, facts: [] }),
    clearChatHistory: () => ({ ok: true, message: '记录清空了' }),
  };
}

test('内置：设置与聊天记录在清单里，形状与插件一致', () => {
  const list = builtinFeatures();
  const ids = list.map((f) => f.id);
  assert.deepEqual(ids.sort(), [BUILTIN_HISTORY, BUILTIN_SETTINGS].sort());

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
  assert.equal(isBuiltin(BUILTIN_HISTORY), true);
  assert.equal(isBuiltin('todos'), false);
  assert.equal(isBuiltin(''), false);
});

test('内置：聊天记录画成消息块', () => {
  const page = builtinPage(BUILTIN_HISTORY, fakeAssistant([{ role: 'user', text: '在吗', at: 1 }]));
  assert.ok(page, '聊天记录得有页面');
  assert.equal(page.pluginId, BUILTIN_HISTORY);
  assert.equal(page.title, '聊天记录');
  const messages = page.blocks.find((b) => b.kind === 'messages');
  assert.ok(messages, '要有消息块');
  assert.equal(messages.items.length, 1);
  assert.equal(messages.items[0].text, '在吗');
});

test('内置：没聊过天时是空态，不是空页面', () => {
  const page = builtinPage(BUILTIN_HISTORY, fakeAssistant([]));
  const empty = page.blocks.find((b) => b.kind === 'empty');
  assert.ok(empty, '该有空态提示');
});

test('内置：设置没有页面（它开的是另一个窗口）', () => {
  assert.equal(builtinPage(BUILTIN_SETTINGS, fakeAssistant()), null);
});

test('内置：清空记录的动作会清掉并给出提示', () => {
  let cleared = false;
  const assistant = {
    chatHistoryView: () => ({ messages: [], total: 0, facts: [] }),
    clearChatHistory: () => {
      cleared = true;
      return { ok: true, message: '记录清空了' };
    },
  };
  const page = builtinAction(BUILTIN_HISTORY, 'clear', assistant);
  assert.equal(cleared, true);
  assert.equal(page.status, '记录清空了');
});
