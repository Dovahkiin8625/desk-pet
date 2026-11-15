// test/unit/clipboard-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HISTORY_FILE,
  historyPath,
  readHistory,
  writeHistory,
  writeImageFile,
  readImageFile,
  removeImageFiles,
  sweepImages,
} from '../../plugins/clipboard/lib/store.js';
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

test('图片：写进目录、读出来、删掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-clip-'));
  try {
    const sha = 'd'.repeat(40);
    const file = `img-${sha}.png`;
    const bytes = Buffer.from([1, 2, 3, 4, 5]);

    await writeImageFile(dir, file, bytes);
    assert.deepEqual(await readImageFile(dir, file), bytes);

    await removeImageFiles(dir, [file]);
    await assert.rejects(() => readImageFile(dir, file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('图片：文件没了的图片条目读历史时丢掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-clip-'));
  try {
    const sha = 'e'.repeat(40);
    const file = `img-${sha}.png`;
    // 历史里有一条图片，但图片文件不存在。
    await writeHistory(dir, [{ id: 'img1', imageFile: file, imageBytes: 3, at: 1 }]);
    const list = await readHistory(dir);
    assert.equal(list.length, 0, '破图条目丢掉');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('图片：sweep 只删没人认领的 img-*.png，别的文件不碰', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-clip-'));
  try {
    const sha = 'f'.repeat(40);
    const referenced = `img-${sha}.png`;
    const orphan = `img-${'0'.repeat(40)}.png`;
    await writeImageFile(dir, referenced, Buffer.from([1]));
    await writeImageFile(dir, orphan, Buffer.from([2]));
    await writeImageFile(dir, '别的文件.png', Buffer.from([3]));
    // 让 orphan 看起来「老」于 1 分钟。
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(join(dir, 'clipboard-images', orphan), old, old);
    await utimes(join(dir, 'clipboard-images', '别的文件.png'), old, old);

    await sweepImages(dir, [{ imageFile: referenced }]);

    const { readdir } = await import('node:fs/promises');
    const left = await readdir(join(dir, 'clipboard-images'));
    assert.ok(left.includes(referenced), '认领的图片留着');
    assert.ok(!left.includes(orphan), '没人认领的删掉');
    assert.ok(left.includes('别的文件.png'), '名字不认的不删');
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
