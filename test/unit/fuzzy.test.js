import test from 'node:test';
import assert from 'node:assert/strict';

import { searchItems, searchPlugins, tokenize } from '../../src/shared/fuzzy.js';

/**
 * 搜索框的打分。
 *
 * 插件、程序、文件、设置页都走这套打分，所以它们能混在一个列表里排序。
 */

/** 造一批程序条目。 */
function apps(...names) {
  return names.map((name) => ({
    id: `app:${name.toLowerCase()}`,
    name,
    target: `C:\\Program Files\\${name}\\${name}.exe`,
    hint: '',
  }));
}

test('拆词：空白分开，空查询没有词', () => {
  assert.deepEqual(tokenize('记事本 calc'), ['记事本', 'calc']);
  assert.deepEqual(tokenize('  '), []);
  assert.deepEqual(tokenize(''), []);
});

test('程序：名字里整段包含的排在前面', () => {
  const hits = searchItems('note', apps('Notepad', 'nvcontainer', 'conda_auto_activate'));
  assert.equal(hits[0].item.name, 'Notepad');
  // 顺序吻合的（nvcontainer 之类）不该挤掉真正想找的记事本。
  assert.equal(hits.length, 1);
});

test('程序：一个都没有整段包含时，才退回去看顺序吻合的', () => {
  const hits = searchItems('nvcont', apps('Notepad', 'nvcontainer'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.name, 'nvcontainer');
});

test('程序：路径里命中要排在名字命中后面', () => {
  const list = [
    { id: 'a', name: 'Notepad', target: 'C:\\Windows\\System32\\notepad.exe', hint: '' },
    { id: 'b', name: '别的程序', target: 'D:\\tools\\notepad\\notepad.exe', hint: '' },
  ];
  const hits = searchItems('notepad', list);
  assert.equal(hits[0].item.id, 'a', '名字命中的该在前');
  assert.equal(hits[1].field, 'target');
});

test('程序：多个词要都命中', () => {
  const list = apps('Google Chrome', 'Notepad');
  assert.equal(searchItems('chrome google', list).length, 1);
  assert.equal(searchItems('chrome notepad', list).length, 0);
});

test('程序：空查询不列条目（打开面板时还是插件清单）', () => {
  assert.deepEqual(searchItems('', apps('Notepad')), []);
  assert.deepEqual(searchItems('   ', apps('Notepad')), []);
});

test('程序：命中的字要标出来，标的是名字里的位置', () => {
  const hits = searchItems('note', apps('Notepad'));
  assert.deepEqual(hits[0].positions, [0, 1, 2, 3]);
  assert.equal(hits[0].field, 'name');
});

test('文件与设置页：跟程序用同一把尺子，分数能放一起排', () => {
  const files = [
    { id: 'file:1', name: '季度报告.docx', target: 'C:\\Users\\me\\Documents\\季度报告.docx', hint: 'Documents' },
  ];
  const hits = searchItems('季度', files);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].field, 'name');
  assert.ok(hits[0].score > 900, '整段包含的分数该在 1000 附近');
});

test('插件：关键词与描述都能命中', () => {
  const plugins = [
    { id: 'todos', name: '待办', keywords: ['daiban'], description: '记下要做的事' },
  ];
  assert.equal(searchPlugins('daiban', plugins).length, 1);
  assert.equal(searchPlugins('要做', plugins).length, 1);
  assert.equal(searchPlugins('待办', plugins).length, 1);
  assert.equal(searchPlugins('没有', plugins).length, 0);
});

test('插件：空查询时全部返回，顺序就是声明顺序', () => {
  const plugins = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
  ];
  const hits = searchPlugins('', plugins);
  assert.deepEqual(hits.map((h) => h.plugin.id), ['a', 'b']);
});

test('插件：多个词可以落在不同的关键词上', () => {
  const plugins = [
    { id: 'a', name: '甲', keywords: ['todo', 'list'] },
  ];
  assert.equal(searchPlugins('todo list', plugins).length, 1);
});
