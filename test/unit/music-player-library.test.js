// 音乐插件的曲库扫描。
//
// 这里守的是两个真实的坑：
//
// - **歌名与歌手从文件名里认**：「歌手 - 歌名.mp3」要拆开，
//   而且开头的曲号（"01 - "）不算歌名的一部分。
// - **只收音频**：同目录里的封面图、歌词文件、说明文本都不该进曲库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanLibrary, lyricPathsFor } from '../../plugins/music-player/lib/library.js';

async function makeLibrary() {
  const root = await mkdtemp(join(tmpdir(), 'music-'));
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, '周杰伦 - 稻香.mp3'), 'x');
  await writeFile(join(root, '01 - 歌手 - 歌名.flac'), 'x');
  await writeFile(join(root, '没有分隔符.m4a'), 'x');
  await writeFile(join(root, '封面.jpg'), 'x');
  await writeFile(join(root, '稻香.lrc'), '[00:01]词');
  await writeFile(join(root, 'sub', '深处的歌.wav'), 'x');
  return root;
}

test('扫出来的是音频文件：封面与歌词不算歌', async () => {
  const root = await makeLibrary();
  const { tracks } = await scanLibrary(root);
  const names = tracks.map((t) => t.title).sort();
  assert.deepEqual(names, ['深处的歌', '歌名', '没有分隔符', '稻香'].sort());
});

test('「歌手 - 歌名」拆成歌手与歌名', async () => {
  const root = await makeLibrary();
  const { tracks } = await scanLibrary(root);
  const song = tracks.find((t) => t.title === '稻香');
  assert.ok(song, '稻香在曲库里');
  assert.equal(song.artist, '周杰伦');
});

test('开头的曲号不算歌名', async () => {
  const root = await makeLibrary();
  const { tracks } = await scanLibrary(root);
  const song = tracks.find((t) => t.title === '歌名');
  assert.ok(song, '曲号被剥掉了');
  assert.equal(song.artist, '歌手');
});

test('子目录里的歌也收进来', async () => {
  const root = await makeLibrary();
  const { tracks } = await scanLibrary(root);
  assert.ok(tracks.some((t) => t.title === '深处的歌'));
});

test('歌词文件在哪：同目录同名，只带歌名的也认', async () => {
  const root = await makeLibrary();
  const { tracks } = await scanLibrary(root);
  const song = tracks.find((t) => t.title === '稻香');
  const paths = lyricPathsFor(song);
  assert.equal(paths[0], join(root, '周杰伦 - 稻香.lrc'));
  assert.equal(paths[1], join(root, '稻香.lrc'), '只带歌名的也认');
});

test('没有音乐文件夹时是空曲库（不是报错）', async () => {
  const { tracks, truncated } = await scanLibrary('');
  assert.deepEqual(tracks, []);
  assert.equal(truncated, false);
});

test('文件夹不在了也别炸', async () => {
  const { tracks } = await scanLibrary(join(tmpdir(), '音乐插件-不存在的文件夹-xyz'));
  assert.deepEqual(tracks, []);
});
