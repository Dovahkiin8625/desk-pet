import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, searchPlugins, searchApps } from '../../src/shared/fuzzy.js';

/**
 * 模糊匹配。
 *
 * 它是插件面板搜索的核心：用户打「待办」「todo」「dai」都得能找到待办插件。
 */
test('子串包含能命中，返回命中位置', () => {
  const m = fuzzyMatch('待办', '待办清单');
  assert.ok(m, '应该能命中');
  assert.deepEqual(m.positions, [0, 1]);
  assert.ok(m.score > 0);
});

test('命中不存在的字返回 null', () => {
  assert.equal(fuzzyMatch('天气', '待办清单'), null);
  assert.equal(fuzzyMatch('xyz', '待办清单'), null);
});

test('子序列能命中（中间隔着别的字）', () => {
  const m = fuzzyMatch('待清', '待办清单');
  assert.ok(m, '「待」「清」按顺序出现就该算命中');
  assert.deepEqual(m.positions, [0, 2]);
});

test('子序列必须完整：少一个字就不算命中', () => {
  assert.equal(fuzzyMatch('tdbx', '待办'), null);
});

test('大小写不敏感', () => {
  const m = fuzzyMatch('TODO', 'todo list');
  assert.ok(m);
  assert.equal(m.score, fuzzyMatch('todo', 'todo list').score);
});

test('连续命中比隔开的命中分高', () => {
  const together = fuzzyMatch('todo', 'todo');
  const apart = fuzzyMatch('todo', 't_o_d_o');
  assert.ok(together.score > apart.score, `连着命中(${together.score})应该比隔着(${apart.score})高`);
});

test('命中得靠前分更高', () => {
  const early = fuzzyMatch('记', '记事本');
  const late = fuzzyMatch('记', '文本编辑器记');
  assert.ok(early.score > late.score);
});

test('空查询匹配一切，分数为 0', () => {
  const m = fuzzyMatch('', '任意文本');
  assert.ok(m);
  assert.equal(m.score, 0);
  assert.deepEqual(m.positions, []);
});

test('目标越短分越高（同样命中时）', () => {
  const short = fuzzyMatch('todo', 'todo');
  const long = fuzzyMatch('todo', 'todo 清单与提醒');
  assert.ok(short.score > long.score);
});

test('searchPlugins：空查询时按声明顺序返回全部', () => {
  const plugins = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
  ];
  const hits = searchPlugins('', plugins);
  assert.deepEqual(hits.map((h) => h.plugin.id), ['a', 'b']);
});

test('searchPlugins：中文名、英文关键词与拼音都能命中', () => {
  const plugins = [
    {
      id: 'todos',
      name: '待办',
      description: '查看与添加待办',
      keywords: ['todo', 'todos', 'daiban', 'dai'],
    },
    { id: 'weather', name: '天气', description: '当前天气', keywords: ['weather', 'tianqi'] },
  ];
  for (const q of ['待办', 'todo', 'daiban', 'dai']) {
    const hits = searchPlugins(q, plugins);
    assert.equal(hits[0]?.plugin.id, 'todos', `「${q}」应该先命中待办`);
  }
});

test('searchPlugins：命中名字的排在命中描述的前面', () => {
  const plugins = [
    { id: 'other', name: '别的', description: 'CPU 与内存' },
    { id: 'system', name: '系统状态', description: 'CPU、内存、温度', keywords: ['cpu'] },
  ];
  const hits = searchPlugins('cpu', plugins);
  assert.equal(hits[0]?.plugin.id, 'system', '关键词命中的应该更靠前');
  assert.equal(hits.length, 2, '两个都该命中');
});

test('searchPlugins：命中不了的不返回', () => {
  const plugins = [{ id: 'todos', name: '待办', keywords: ['todo'] }];
  assert.deepEqual(searchPlugins('天气', plugins), []);
});

test('searchPlugins：分数相同时保持声明顺序', () => {
  const plugins = [
    { id: 'a', name: '待办' },
    { id: 'b', name: '代办' },
  ];
  // 「办」在两个名字里的位置与长度都一样 → 分数相同 → 谁也不该插队。
  const hits = searchPlugins('办', plugins);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.plugin.id), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// 程序搜索
//
// 程序与插件放在同一个结果列表里，所以两边的分数必须可比：
// 名字命中的权重都是 1，路径命中只作兜底。
// ---------------------------------------------------------------------------

test('searchApps：按名字命中', () => {
  const apps = [
    { id: 'app:a', name: 'notepad', target: 'C:\\Windows\\System32\\notepad.exe' },
    { id: 'app:b', name: 'Chrome', target: 'C:\\Program Files\\Chrome\\chrome.exe' },
  ];
  const hits = searchApps('note', apps);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].app.id, 'app:a');
  assert.equal(hits[0].field, 'name');
});

test('searchApps：空查询不列程序（打开面板时还是插件清单）', () => {
  const apps = [{ id: 'app:a', name: 'notepad', target: 'C:\\notepad.exe' }];
  assert.deepEqual(searchApps('', apps), []);
});

test('searchApps：路径只认整段包含，不认子序列', () => {
  const apps = [
    { id: 'app:a', name: '某程序', target: 'C:\\Users\\me\\Documents\\todo\\app.exe' },
  ];
  // 「todo」在路径里是**整段** → 命中（用户记得装在哪个目录）。
  assert.equal(searchApps('todo', apps).length, 1);
  // 「tdo」只是子序列 → 不命中：路径太长，子序列几乎什么都算命中。
  assert.equal(searchApps('tdo', apps).length, 0);
});

test('searchApps：名字命中排在路径命中前面', () => {
  const apps = [
    { id: 'app:path', name: '别的', target: 'C:\\tools\\todo\\app.exe' },
    { id: 'app:name', name: 'todo', target: 'C:\\tools\\app.exe' },
  ];
  const hits = searchApps('todo', apps);
  assert.equal(hits[0].app.id, 'app:name', '名字命中的分更高');
});

test('searchApps：命中的位置只在名字上标', () => {
  const apps = [{ id: 'app:a', name: '某程序', target: 'C:\\tools\\todo\\app.exe' }];
  const hits = searchApps('todo', apps);
  // 命中的是路径 → 没有位置号（那些号指的是路径，标在名字上是错的）。
  assert.equal(hits[0].field, 'target');
  assert.deepEqual(hits[0].positions, []);
});

test('searchApps：有整段包含的结果时，顺序吻合的结果不算数', () => {
  // 「note」顺序吻合于 nvcontainer——但用户要的是记事本。
  // 只要有一个整段包含的结果，那些松散匹配就不该出现。
  const apps = [
    { id: 'app:loose', name: 'nvcontainer', target: 'C:\\a\\nvcontainer.exe' },
    { id: 'app:exact', name: 'notepad', target: 'C:\\b\\notepad.exe' },
  ];
  const hits = searchApps('note', apps);
  assert.deepEqual(
    hits.map((h) => h.app.id),
    ['app:exact']
  );
});

test('searchApps：一个整段包含都没有时，才退回去找顺序吻合的', () => {
  // 「vscode」不是「Visual Studio Code」的整段，但顺序是吻合的——
  // 这种缩写正是顺序匹配存在的理由。
  const apps = [{ id: 'app:a', name: 'Visual Studio Code', target: 'C:\\vscode\\code.exe' }];
  const hits = searchApps('vscode', apps);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].app.id, 'app:a');
});
