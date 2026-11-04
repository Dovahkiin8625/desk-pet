import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from '../../src/main/store.js';

/**
 * 原子写文件。
 *
 * 「原子」指的是：先写临时文件，再 rename 覆盖目标。
 * 普通 writeFile 会先把目标文件**截断成 0 字节**，写到一半被读走
 * （或者被强杀）就留下一个半截文件——对 TTS 缓存来说，
 * 半截的 mp3 会被当成有效缓存一直用下去：桌宠那句话从此永远是哑的。
 */

test('原子写：写完能读到完整内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-store-'));
  try {
    await writeFileAtomic(dir, 'a.bin', Buffer.from('hello'));
    assert.equal((await readFile(join(dir, 'a.bin'))).toString(), 'hello');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写：目录不存在时也写得进去', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-store-'));
  try {
    await writeFileAtomic(join(dir, 'deep', 'nested'), 'a.bin', Buffer.from('hi'));
    assert.equal((await readFile(join(dir, 'deep', 'nested', 'a.bin'))).toString(), 'hi');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写：覆盖旧文件后是**新**内容，不留半截', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-store-'));
  try {
    await writeFileAtomic(dir, 'a.bin', Buffer.from('旧内容'.repeat(1000)));
    await writeFileAtomic(dir, 'a.bin', Buffer.from('新'));
    assert.equal((await readFile(join(dir, 'a.bin'))).toString(), '新');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写：临时文件不留下来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-store-'));
  try {
    await writeFileAtomic(dir, 'a.bin', Buffer.from('hello'));
    const files = await readdir(dir);
    assert.deepEqual(files, ['a.bin']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子写：目标是个目录时抛错（别把错误吞掉）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-store-'));
  try {
    await mkdir(join(dir, 'a.bin'));
    await assert.rejects(() => writeFileAtomic(dir, 'a.bin', Buffer.from('x')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
