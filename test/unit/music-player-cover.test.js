// 音乐插件的封面：从歌曲文件里认出内嵌的那张图。
//
// 认得 mp3（ID3v2 的 APIC 帧）、flac（PICTURE 块）、mp4（ilst 里的 covr）。
// 这里只测最常碰到的两种，剩下的格式认不出也不该炸。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractArtwork } from '../../plugins/music-player/lib/cover.js';

/** 一张 1×1 的 png。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 同步安全的长度（ID3 的长度是这么写的）。 */
function synchsafe(size) {
  return Buffer.from([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
}

/** 造一个带 APIC 帧的 mp3。 */
function makeMp3(version = 3) {
  const apic = Buffer.concat([
    Buffer.from([0]), // 编码
    Buffer.from('image/png\0', 'latin1'),
    Buffer.from([3]), // 图片类型
    Buffer.from([0]), // 描述（空）
    PNG,
  ]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write('APIC', 0, 'latin1');
  frameHeader.writeUInt32BE(apic.length, 4);
  const frame = Buffer.concat([frameHeader, apic]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([version, 0, 0]),
    version === 4 ? synchsafe(frame.length) : Buffer.from(frame.length.toString(16).padStart(8, '0'), 'hex'),
  ]);
  return Buffer.concat([header, frame, Buffer.from([0, 0, 0])]);
}

/** 造一个带 PICTURE 块的 flac。 */
function makeFlac() {
  const block = Buffer.concat([
    Buffer.from([0, 0, 0, 3]), // 图片类型
    Buffer.from([0, 0, 0, 9]),
    Buffer.from('image/png', 'latin1'),
    Buffer.from([0, 0, 0, 0]), // 描述长度
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), // 宽高
    Buffer.from([0, 0, 0, 24]), // 位深
    Buffer.from([0, 0, 0, 0]), // 颜色数
    Buffer.from([0, 0, 0, PNG.length]),
    PNG,
  ]);
  const head = Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    Buffer.from([0x80 | 6]), // 最后一个块，类型 6（PICTURE）
    Buffer.from([(block.length >> 16) & 0xff, (block.length >> 8) & 0xff, block.length & 0xff]),
    block,
  ]);
  return Buffer.concat([head, Buffer.from('fLaC', 'latin1')]);
}

test('mp3：认出 ID3v2.3 的 APIC 帧', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-cover-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, makeMp3(3));
    const art = await extractArtwork(file);
    assert.ok(art, '没认出封面');
    assert.equal(art.mime, 'image/png');
    assert.deepEqual(art.data, PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mp3：v2.4 的长度是同步安全的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-cover-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, makeMp3(4));
    const art = await extractArtwork(file);
    assert.ok(art, '没认出封面');
    assert.deepEqual(art.data, PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flac：认出 PICTURE 块', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-cover-'));
  try {
    const file = join(dir, 'a.flac');
    await writeFile(file, makeFlac());
    const art = await extractArtwork(file);
    assert.ok(art, '没认出封面');
    assert.equal(art.mime, 'image/png');
    assert.deepEqual(art.data, PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有封面的文件：返回 null（不是报错）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-cover-'));
  try {
    const file = join(dir, 'a.wav');
    await writeFile(file, Buffer.from('RIFF....WAVEfmt '));
    assert.equal(await extractArtwork(file), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件不在了：返回 null（不是报错）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-cover-'));
  try {
    assert.equal(await extractArtwork(join(dir, '没有这个文件.mp3')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
