// test/unit/clipboard-formats.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { parseUriList, stripHtml, readSnapshot, pngSize } from '../../plugins/clipboard/lib/formats.js';
import { MAX_TEXT_CHARS } from '../../plugins/clipboard/lib/history.js';

/** 造一个长得像 ClipboardItem 的假货。 */
function fakeItem(types, payloads) {
  return {
    types,
    async getType(type) {
      const value = payloads[type];
      if (value === undefined) throw new Error(`没有 ${type} 这个格式`);
      if (value instanceof Blob) return value;
      return new Blob([String(value)], { type });
    },
  };
}

test('text/uri-list 解析：CRLF、注释、非 file:// 都按规范来', () => {
  const a = pathToFileURL('C:\\Users\\a.txt').href;
  const b = pathToFileURL('D:\\图片.png').href;
  const raw = ['# 注释', a, '', b, 'https://example.com/不是文件'].join('\r\n');
  assert.deepEqual(parseUriList(raw), ['C:\\Users\\a.txt', 'D:\\图片.png']);
});

test('text/uri-list 解析：解析不了的行跳过，不炸', () => {
  assert.deepEqual(parseUriList('file:///非有效 的路径%%%'), []);
  assert.deepEqual(parseUriList(''), []);
});

test('stripHtml：剥标签、解实体、去掉 script', () => {
  assert.equal(stripHtml('<p>你好<b>世界</b></p>'), '你好 世界', '标签换成空格（粗糙剥法，压空白）');
  assert.equal(stripHtml('<script>var x=1;</script>正文'), '正文');
  assert.equal(stripHtml('a&amp;b&lt;c&gt;d&nbsp;e&quot;f&#65;&#x42;'), 'a&b<c>d e"fAB');
  assert.equal(stripHtml(''), '');
});

test('读出来的是纯文本：kind=text，带签名', async () => {
  const item = fakeItem(['text/plain'], { 'text/plain': '你好，世界' });
  const result = await readSnapshot(item);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.kind, 'text');
  assert.equal(result.snapshot.text, '你好，世界');
  assert.ok(result.snapshot.key.startsWith('text:'));
  assert.equal(result.png, null);
});

test('读出来的 HTML 会存下来，纯文本兜底也算', async () => {
  const item = fakeItem(['text/html'], { 'text/html': '<p>你好 <b>世界</b></p>' });
  const result = await readSnapshot(item);
  assert.equal(result.snapshot.html, '<p>你好 <b>世界</b></p>');
  assert.equal(result.snapshot.text, '你好 世界', '没有 text/plain 就从 HTML 剥一层当显示文本');
});

test('读出来的 RTF 存下来', async () => {
  const item = fakeItem(['text/plain', 'text/rtf'], {
    'text/plain': '粗体',
    'text/rtf': '{\\rtf1\\b 粗体}',
  });
  const result = await readSnapshot(item);
  assert.equal(result.snapshot.rtf, '{\\rtf1\\b 粗体}');
  assert.equal(result.snapshot.text, '粗体');
});

test('复制了一堆文件：kind=files，认路径', async () => {
  const a = pathToFileURL('C:\\a.txt').href;
  const b = pathToFileURL('D:\\目录\\b.png').href;
  const item = fakeItem(['text/uri-list'], { 'text/uri-list': `${a}\r\n${b}` });
  const result = await readSnapshot(item);
  assert.equal(result.snapshot.kind, 'files');
  assert.deepEqual(result.snapshot.files, ['C:\\a.txt', 'D:\\目录\\b.png']);
  assert.ok(result.snapshot.key.startsWith('files:'));
});

test('复制的是图片：PNG 原样存，签名认字节，尺寸从头解', async () => {
  const png = Buffer.alloc(32);
  png.write('PNG', 1);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  const item = fakeItem(['image/png'], { 'image/png': new Blob([png], { type: 'image/png' }) });
  const result = await readSnapshot(item);
  assert.equal(result.snapshot.kind, 'image');
  assert.equal(result.snapshot.imageFile, `img-${createHash('sha1').update(png).digest('hex')}.png`);
  assert.equal(result.snapshot.imageWidth, 640);
  assert.equal(result.snapshot.imageHeight, 480);
  assert.ok(result.snapshot.key.startsWith('image:'));
});

test('图片 + 文本（网页里「复制图片」常见）：两个格式都存下来', async () => {
  const png = Buffer.alloc(32);
  png.write('PNG', 1);
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(100, 20);
  const item = fakeItem(['text/plain', 'image/png'], {
    'text/plain': 'https://example.com/pic.png',
    'image/png': new Blob([png], { type: 'image/png' }),
  });
  const result = await readSnapshot(item);
  assert.equal(result.snapshot.kind, 'image');
  assert.equal(result.snapshot.text, 'https://example.com/pic.png', '文本也存下来了');
});

test('文本太大：整条不记，但签名稳定（不会每轮都重新读一遍大文件）', async () => {
  const big = 'x'.repeat(MAX_TEXT_CHARS + 1);
  const item = fakeItem(['text/plain'], { 'text/plain': big });
  const result = await readSnapshot(item);
  assert.equal(result.tooBig, true);
  assert.ok(result.signature, '签名要有，记录器拿它记「看过了」');
});

test('空的剪贴板：empty', async () => {
  const result = await readSnapshot(fakeItem([], {}));
  assert.deepEqual(result, { ok: true, empty: true });
});

test('读不了（getType 抛异常）：不炸，报读不到', async () => {
  const item = {
    types: ['text/plain'],
    async getType() {
      throw new Error('剪贴板被锁住了');
    },
  };
  // text/plain 读不出来但类型在列表里 → 文本路 null，其余没有 → empty（不崩）
  const result = await readSnapshot(item);
  assert.equal(result.ok, true);
});

test('pngSize：认不出的字节不给尺寸', () => {
  assert.deepEqual(pngSize(Buffer.from('不是PNG')), { width: null, height: null });
  assert.deepEqual(pngSize(null), { width: null, height: null });
});
