import test from 'node:test';
import assert from 'node:assert/strict';

import { createEntryStore } from '../../plugins/chat-history/pages/entries.js';

/**
 * 页面这边「现在有哪些记录」的小账本。
 *
 * 记录是**两路**来的：
 * - **首份快照**：界面打开时给一份完整的；
 * - **增量**：一条记录进来推一条。
 *
 * 两路会撞车：快照算出来的那一刻，可能已经有一条新的推到了页面上。
 * 这时候快照只能**合**进来，不能**换**——换掉就把那条新的弄丢了。
 */

/** 一条记录。 */
function entry(id, text) {
  return { id, kind: 'user', role: 'user', text, at: 1 };
}

test('首份快照：账本里就是那些记录', () => {
  const store = createEntryStore();
  store.apply({ entries: [entry('a', '在吗'), entry('b', '在呢')] });
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].text, '在吗');
});

test('增量：接着往里加', () => {
  const store = createEntryStore();
  store.apply({ entries: [entry('a', '在吗')] });
  store.apply({ entries: [entry('b', '你好')] });
  assert.equal(store.list().length, 2);
});

test('同一条不显示两遍', () => {
  const store = createEntryStore();
  store.apply({ entries: [entry('a', '在吗')] });
  store.apply({ entries: [entry('a', '在吗')] });
  assert.equal(store.list().length, 1);
});

test('首份快照合进来，不盖掉已经收到的增量', () => {
  // 先来了一条新的（增量），后到的快照里**没有**它——
  // 换成「整份替换」的话，这条就凭空消失了。
  const store = createEntryStore();
  store.apply({ entries: [entry('b', '你好')] });
  store.apply({ entries: [entry('a', '在吗')] });
  assert.deepEqual(
    store.list().map((e) => e.text),
    ['你好', '在吗']
  );
});

test('整份清单（replace）先清再合', () => {
  const store = createEntryStore();
  store.apply({ entries: [entry('a', '在吗')] });
  store.apply({ entries: [], replace: true });
  assert.equal(store.list().length, 0);
});

test('清空重来', () => {
  const store = createEntryStore();
  store.apply({ entries: [entry('a', '在吗')] });
  store.reset();
  assert.equal(store.list().length, 0);
  // 清空之后，同一条记录再来一次是要显示的。
  store.apply({ entries: [entry('a', '在吗')] });
  assert.equal(store.list().length, 1);
});
