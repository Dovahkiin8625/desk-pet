import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecordSink } from '../../src/main/assistant/chat/recordSink.js';

/**
 * 写聊天记录的唯一入口。
 *
 * 写一条要做三件事：追加、按分类截断、**通知订阅者**
 * （插件的聊天记录界面要实时更新——写一条就推一条）。
 *
 * 订阅者拿到的必须是**规整后**的那一条：
 * 页面靠 id 去重、靠 kind 分区，缺了 id 它就认不出是不是同一条。
 */
test('写一条记录：数组多了一条，订阅者收到规整后的那一条', () => {
  const seen = [];
  let messages = [];
  const write = createRecordSink({
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
    onEntry: (entry) => seen.push(entry),
  });

  const written = write({ role: 'user', text: '在吗' });

  assert.equal(messages.length, 1);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].id, '条目要有 id：页面靠它去重');
  assert.equal(seen[0].kind, 'user');
  assert.equal(seen[0].text, '在吗');
  // 通知给订阅者的与返回的是同一条。
  assert.equal(seen[0], written);
});

test('写一条记录：分类截断照旧（一条新步骤不挤掉最老的用户输入）', () => {
  let messages = [];
  const write = createRecordSink({
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
  });

  write({ kind: 'user', text: '最早那句话' });
  for (let i = 0; i < 260; i += 1) write({ kind: 'step', text: `第 ${i} 步`, meta: { taskId: 't-1' } });

  assert.ok(messages.some((m) => m.kind === 'user'), '最老的用户输入不该被步骤挤掉');
  assert.equal(messages.filter((m) => m.kind === 'step').length, 200, '步骤那一路有自己的上限');
});
