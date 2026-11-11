import test from 'node:test';
import assert from 'node:assert/strict';

import { resultMenuTemplate } from '../../src/main/resultMenu.js';
import { SETTINGS_PAGES } from '../../src/main/windowsSettings.js';

/**
 * 搜索结果的右键菜单。
 *
 * 菜单只有两项：**打开**与**打开所在目录**。
 * 没有所在目录的条目（系统设置页）只有「打开」——
 * 摆一个点了没反应的项比不摆更糟。
 */

test('有路径的条目：打开与打开所在目录', () => {
  const item = { kind: 'file', path: 'C:\\a.txt' };
  const template = resultMenuTemplate(item, {});
  assert.deepEqual(template.map((entry) => entry.label), ['打开', '打开所在目录']);
});

test('没有路径的条目：只有打开', () => {
  const template = resultMenuTemplate({ kind: 'setting', target: 'ms-settings:display' }, {});
  assert.deepEqual(template.map((entry) => entry.label), ['打开']);
});

test('点菜单项会调对应的动作', () => {
  const opened = [];
  const revealed = [];
  const item = { kind: 'file', path: 'C:\\a.txt' };
  const template = resultMenuTemplate(item, {
    open: (target) => opened.push(target),
    reveal: (target) => revealed.push(target),
  });
  template[0].click();
  template[1].click();
  assert.deepEqual(opened, [item]);
  assert.deepEqual(revealed, [item]);
});

test('设置页清单：每一条都有名字与地址，地址不能重', () => {
  const seen = new Set();
  for (const page of SETTINGS_PAGES) {
    assert.ok(page.id, '得有个 id');
    assert.ok(page.name, '得有个名字');
    assert.ok(page.target, '得有个地址');
    assert.equal(seen.has(page.id), false, `id 重了：${page.id}`);
    seen.add(page.id);
  }
});
