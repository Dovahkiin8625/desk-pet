// 音乐插件的歌单。
//
// 歌单是**纯数据**的加减：给它一份，它还一份新的。
// 落盘那块也要认：存下去再读回来，得还是那份歌单。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addPlaylist,
  addTracksToPlaylist,
  normalizePlaylists,
  playlistsPath,
  readPlaylists,
  removePlaylist,
  removeTrackFromPlaylist,
  writePlaylists,
} from '../../plugins/music-player/lib/playlists.js';

const TRACK = { file: 'C:/music/a.mp3', base: '歌手 - 歌名', title: '歌名', artist: '歌手' };

test('新建歌单：有个名字才建', () => {
  const list = addPlaylist([], '通勤');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '通勤');
  assert.deepEqual(list[0].tracks, []);
  assert.ok(list[0].id, '歌单得有 id');
  assert.equal(addPlaylist([], '  ').length, 0, '没名字不建');
});

test('删歌单：只删那一个', () => {
  const list = addPlaylist(addPlaylist([], '甲'), '乙');
  const after = removePlaylist(list, list[0].id);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, '乙');
});

test('往歌单里加歌：同一首只加一次', () => {
  const list = addPlaylist([], '通勤');
  const id = list[0].id;
  const first = addTracksToPlaylist(list, id, [TRACK]);
  assert.equal(first.added, 1);
  assert.equal(first.playlists[0].tracks.length, 1);
  const again = addTracksToPlaylist(first.playlists, id, [TRACK]);
  assert.equal(again.added, 0, '重复的歌不加');
  assert.equal(again.playlists[0].tracks.length, 1);
});

test('往歌单里加歌：加的是整首歌（歌名、歌手都留着）', () => {
  const list = addPlaylist([], '通勤');
  const { playlists } = addTracksToPlaylist(list, list[0].id, [TRACK]);
  const track = playlists[0].tracks[0];
  assert.equal(track.file, TRACK.file);
  assert.equal(track.title, '歌名');
  assert.equal(track.artist, '歌手');
  assert.equal(track.base, TRACK.base, '歌词文件靠它找');
});

test('从歌单里拿掉一首歌', () => {
  const list = addPlaylist([], '通勤');
  const { playlists } = addTracksToPlaylist(list, list[0].id, [TRACK]);
  const after = removeTrackFromPlaylist(playlists, playlists[0].id, TRACK.file);
  assert.equal(after[0].tracks.length, 0);
});

test('读回来的歌单：认不出来的直接丢掉', () => {
  const out = normalizePlaylists({
    playlists: [
      { name: '好的', tracks: [TRACK, TRACK, { file: '' }, null] },
      { name: '  ', tracks: [] },
      '不是对象',
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '好的');
  assert.equal(out[0].tracks.length, 1, '重复的歌只留一个');
  assert.ok(out[0].id);
});

test('存下去再读回来，还是那份歌单', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-pl-'));
  try {
    const list = addPlaylist([], '通勤');
    const { playlists } = addTracksToPlaylist(list, list[0].id, [TRACK]);
    await writePlaylists(dir, playlists);
    const back = await readPlaylists(dir);
    assert.equal(back.length, 1);
    assert.equal(back[0].name, '通勤');
    assert.equal(back[0].tracks[0].file, TRACK.file);
    assert.equal(back[0].tracks[0].artist, '歌手');
    const raw = JSON.parse(await readFile(playlistsPath(dir), 'utf8'));
    assert.ok(Array.isArray(raw.playlists), '落盘的是 { playlists: [...] }');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有歌单文件时当作空的（不是报错）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-pl-'));
  try {
    assert.deepEqual(await readPlaylists(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('歌单文件写坏了也当作空的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'music-pl-'));
  try {
    await writePlaylists(dir, addPlaylist([], '通勤'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(playlistsPath(dir), '{ 这不是 json', 'utf8');
    assert.deepEqual(await readPlaylists(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
