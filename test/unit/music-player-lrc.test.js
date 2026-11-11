// 音乐插件的歌词解析。
//
// 这里守的是两个真实的坑：
//
// - **小数点后的位数**：「[00:12.5]」是 12.5 秒，「[00:12.50]」也是 12.5 秒，
//   但「[00:12.500]」还是 12.5 秒——按位数算才对，按「前两位」算就错了。
// - **一行好几个时间戳**：同一句唱两遍时 LRC 会写两遍时间戳，
//   只认第一个就丢了一句。
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLrc, lineIndexAt, decodeLyrics } from '../../plugins/music-player/lib/lrc.js';

test('时间戳解析成秒', () => {
  const lines = parseLrc('[00:12.50]你好\n[01:05]世界');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].t, 12.5);
  assert.equal(lines[0].text, '你好');
  assert.equal(lines[1].t, 65);
  assert.equal(lines[1].text, '世界');
});

test('小数点后几位就是几位：.5 与 .500 都是半秒', () => {
  assert.equal(parseLrc('[00:01.5]a')[0].t, 1.5);
  assert.equal(parseLrc('[00:01.50]a')[0].t, 1.5);
  assert.equal(parseLrc('[00:01.500]a')[0].t, 1.5);
  assert.equal(parseLrc('[00:01.25]a')[0].t, 1.25);
});

test('没有小数的分钟秒也算得对', () => {
  assert.equal(parseLrc('[03:07]a')[0].t, 187);
});

test('一行好几个时间戳：每一句都留着', () => {
  const lines = parseLrc('[00:10][01:10]同一句');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].t, 10);
  assert.equal(lines[1].t, 70);
  assert.equal(lines[0].text, '同一句');
  assert.equal(lines[1].text, '同一句');
});

test('元信息不是歌词，跳过', () => {
  const lines = parseLrc('[ti:歌名]\n[ar:歌手]\n[00:03]词');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '词');
});

test('歌词按时间排好（写乱了也排）', () => {
  const lines = parseLrc('[00:30]后\n[00:10]前');
  assert.deepEqual(lines.map((l) => l.text), ['前', '后']);
});

test('此刻该显示哪一行：最后一个到了的', () => {
  const lines = parseLrc('[00:10]一\n[00:20]二\n[00:30]三');
  assert.equal(lineIndexAt(lines, 0), -1, '还没唱到');
  assert.equal(lineIndexAt(lines, 10), 0);
  assert.equal(lineIndexAt(lines, 25), 1);
  assert.equal(lineIndexAt(lines, 999), 2);
});

test('GBK 的中文歌词解得出来（不是乱码）', () => {
  // 「歌词」两个字的 GBK 编码。
  const gbk = Buffer.from([0xb8, 0xe8, 0xb4, 0xca]);
  assert.equal(decodeLyrics(gbk), '歌词');
});

test('UTF-8 的歌词照旧', () => {
  assert.equal(decodeLyrics(Buffer.from('歌词', 'utf8')), '歌词');
});
