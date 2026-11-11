// test/unit/clipboard-history.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_ENTRIES,
  addEntry,
  clearEntries,
  listEntries,
  newestEntry,
  normalizeEntries,
  removeEntry,
  sameEntries,
  togglePin,
  trimEntries,
} from '../../plugins/clipboard/lib/history.js';

/** 造一条条目。 */
function entry(id, text, at, pinned = false) {
  return { id, text, at, pinned };
}

test('加一条：新的排在最前面', () => {
  const list = addEntry([], '第一段', { at: 1, id: 'a' });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '第一段');

  const two = addEntry(list, '第二段', { at: 2, id: 'b' });
  assert.equal(two.length, 2);
  assert.equal(two[0].text, '第二段', '新的在最前面');
  assert.equal(two[1].text, '第一段');
});

test('加一条：id 必须唯一（重了的话删一条会连着删两条）', () => {
  let list = addEntry([], '甲', { at: 1 });
  list = addEntry(list, '乙', { at: 2 });
  assert.notEqual(list[0].id, list[1].id, '两条的 id 不一样');
  assert.ok(list[0].id, 'id 不该是空串');

  const after = removeEntry(list, list[0].id);
  assert.equal(after.length, 1, '只删掉了那一条');
  assert.equal(after[0].text, '甲', '剩下的是另一条');
});

test('从磁盘读回来的东西：id 重了要重新给一个', () => {
  const list = normalizeEntries([
    { id: 'same', text: '甲', at: 1 },
    { id: 'same', text: '乙', at: 2 },
  ]);
  assert.equal(list.length, 2);
  assert.notEqual(list[0].id, list[1].id, '重了的 id 被换掉了');
});

test('加一条：空白不算一条（剪贴板被清空时内容是空串）', () => {
  const list = addEntry([], '   ', { at: 1, id: 'a' });
  assert.equal(list.length, 0);
  assert.equal(addEntry([], '', { at: 1, id: 'a' }).length, 0);
  assert.equal(addEntry([], null, { at: 1, id: 'a' }).length, 0);
});

test('加一条：同样的内容再复制一次是挪到最上面，不新增一条', () => {
  let list = addEntry([], '甲', { at: 1, id: 'a' });
  list = addEntry(list, '乙', { at: 2, id: 'b' });
  list = addEntry(list, '甲', { at: 3 });

  assert.equal(list.length, 2, '还是两条');
  assert.equal(list[0].text, '甲', '甲挪到了最上面');
  assert.equal(list[0].id, 'a', '沿用原来的 id');
  assert.equal(list[0].at, 3, '时间更新了');
});

test('加一条：重复的那条如果被固定了，固定状态留着', () => {
  let list = addEntry([], '甲', { at: 1, id: 'a' });
  list = togglePin(list, 'a');
  list = addEntry(list, '乙', { at: 2, id: 'b' });
  list = addEntry(list, '甲', { at: 3 });

  const found = list.find((item) => item.text === '甲');
  assert.equal(found.pinned, true, '还是固定的');
});

test('淘汰：固定的一律留着，其余按新到旧留够 max 条', () => {
  const list = [
    entry('a', '甲', 1),
    entry('b', '乙', 2),
    entry('c', '丙', 3),
  ];
  const pinned = togglePin(list, 'c');

  const trimmed = trimEntries(pinned, 1);
  const texts = trimmed.map((item) => item.text);
  assert.ok(texts.includes('丙'), '固定的那条留下了');
  assert.equal(trimmed.length, 2, '固定的一条不计入上限');
  assert.ok(texts.includes('乙'), '新的那条留下了');
  assert.ok(!texts.includes('甲'), '最旧的那条被淘汰了');
});

test('淘汰：max 是 0 时一条不留（固定的那条仍然留着）', () => {
  const list = [entry('a', '甲', 1), entry('b', '乙', 2)];
  assert.equal(trimEntries(list, 0).length, 0);
  assert.equal(trimEntries(togglePin(list, 'a'), 0).length, 1);
});

test('展示顺序：固定的在前，其余按时间倒序', () => {
  const list = [entry('a', '甲', 1), entry('b', '乙', 3), entry('c', '丙', 2)];
  const pinned = togglePin(list, 'a');

  const ordered = listEntries(pinned).map((item) => item.text);
  assert.deepEqual(ordered, ['甲', '乙', '丙'], '固定的甲在最前，其余新的在前');
});

test('最近复制的那一条：按时间算，不看固定', () => {
  const list = [entry('a', '旧的', 1), entry('b', '新的', 9)];
  const pinned = togglePin(list, 'b');
  assert.equal(newestEntry(pinned).text, '新的');
  assert.equal(newestEntry([]), null);
});

test('固定 / 取消固定', () => {
  let list = [entry('a', '甲', 1)];
  list = togglePin(list, 'a');
  assert.equal(list[0].pinned, true);
  list = togglePin(list, 'a');
  assert.equal(list[0].pinned, false);
  assert.equal(togglePin(list, '不存在的').length, 1, '没有这一条就什么也不做');
});

test('删掉一条 / 清空', () => {
  const list = [entry('a', '甲', 1), entry('b', '乙', 2)];
  assert.equal(removeEntry(list, 'a').length, 1);
  assert.equal(removeEntry(list, 'a')[0].text, '乙');
  assert.equal(removeEntry(list, '没有').length, 2);
  assert.deepEqual(clearEntries(), []);
});

test('两份列表一样不一样', () => {
  const a = [entry('a', '甲', 1)];
  assert.equal(sameEntries(a, [entry('a', '甲', 1)]), true);
  assert.equal(sameEntries(a, [entry('a', '甲', 2)]), false, '时间变了');
  assert.equal(sameEntries(a, [entry('a', '甲', 1, true)]), false, '固定状态变了');
  assert.equal(sameEntries(a, [entry('b', '甲', 1)]), false, 'id 变了');
  assert.equal(sameEntries(a, [...a, entry('b', '乙', 2)]), false, '多了一条');
  assert.equal(sameEntries(a, []), false);
});

test('从磁盘读回来的东西：认不出的条目直接丢掉', () => {
  const raw = [
    { id: 'a', text: '好的', at: 1, pinned: true },
    { id: 'b', text: '   ' },
    null,
    '不是对象',
    { text: '没有 id 也没有时间' },
    { id: 'c', text: '另一个', at: '不是数字', pinned: '是' },
  ];
  const list = normalizeEntries(raw);
  assert.equal(list.length, 3, '空白的、非对象的都丢了');
  assert.equal(list[0].text, '好的');
  assert.equal(list[0].pinned, true);
  assert.equal(list[1].text, '没有 id 也没有时间');
  assert.equal(list[1].at, 0, '时间不认得就当 0');
  assert.equal(list[2].pinned, true, '固定只认真假');
});

test('从磁盘读回来的东西：不是数组就当作空的', () => {
  assert.deepEqual(normalizeEntries(null), []);
  assert.deepEqual(normalizeEntries(undefined), []);
  assert.deepEqual(normalizeEntries('不是数组'), []);
  assert.deepEqual(normalizeEntries({ a: 1 }), []);
});

test('默认留多少条', () => {
  assert.equal(DEFAULT_MAX_ENTRIES, 200);
});
