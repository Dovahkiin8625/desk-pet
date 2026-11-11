// test/unit/clipboard-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HISTORY_FILE, historyPath, readHistory, writeHistory } from '../../plugins/clipboard/lib/store.js';
import { decodeAnswer } from '../../plugins/clipboard/lib/paste.js';

test('历史存在 userData 里，不在插件目录里', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-clip-'));
  try {
    assert.equal(historyPath(dir), join(dir, HISTORY_FILE));

    await writeHistory(dir, [{ id: 'a', text: '甲', at: 1, pinned: false }]);
    const raw = JSON.parse(await readFile(historyPath(dir), 'utf8'));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].text, '甲');

    const list = await readHistory(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].text, '甲');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('历史文件还没有时当作空的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-clip-'));
  try {
    assert.deepEqual(await readHistory(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('历史文件坏了也不能把插件带崩', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-clip-'));
  try {
    await writeFile(historyPath(dir), '这不是 JSON', 'utf8');
    assert.deepEqual(await readHistory(dir), [], '读坏了就当没有');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写盘是原子的：不会留下半个文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-clip-'));
  try {
    await writeHistory(dir, [{ id: 'a', text: '甲', at: 1, pinned: false }]);
    const text = await readFile(historyPath(dir), 'utf8');
    assert.equal(JSON.parse(text).length, 1);
    // 临时文件不该留在盘上。
    const raw = await readFile(join(dir, `${HISTORY_FILE}.tmp`), 'utf8').catch(() => null);
    assert.equal(raw, null, '临时文件已经改名了');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('脚本的回话：base64 的 JSON 翻译得回来', () => {
  const line = Buffer.from(JSON.stringify({ ok: true, title: '记事本' }), 'utf8').toString('base64');
  const answer = decodeAnswer(`${line}\r\n`);
  assert.equal(answer.ok, true);
  assert.equal(answer.title, '记事本');
});

test('脚本的回话：最后一句才是结果', () => {
  const first = Buffer.from(JSON.stringify({ ok: false, error: '旧消息' }), 'utf8').toString('base64');
  const last = Buffer.from(JSON.stringify({ ok: true, title: '新的' }), 'utf8').toString('base64');
  const answer = decodeAnswer(`${first}\n${last}\n`);
  assert.equal(answer.title, '新的');
});

test('脚本的回话：认不出来就当没有', () => {
  assert.equal(decodeAnswer(''), null);
  assert.equal(decodeAnswer('随便写点什么'), null);
  assert.equal(decodeAnswer(null), null);
});
