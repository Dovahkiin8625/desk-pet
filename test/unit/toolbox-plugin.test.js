import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPluginHost } from '../../src/main/plugins/host.js';
import {
  base64Decode,
  base64Encode,
  dateToTimestamp,
  estimateTokens,
  formatJson,
  minifyJson,
  testRegex,
  timestampToDate,
  urlDecode,
  urlEncode,
  validateJson,
} from '../../plugins/toolbox/lib/tools.js';
import { makePage, textBlock } from '../../src/shared/panel.js';
import createToolboxPlugin from '../../plugins/toolbox/main.js';

/**
 * 工具箱插件。
 *
 * 覆盖两半：
 *
 * 1. **纯逻辑**（JSON / 编解码 / 时间戳 / Token 估算 / 正则）——
 *    页面上实时算的就是这些函数。
 * 2. **插件接在宿主上**（清单合法、页面在磁盘上、复制走主进程）。
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function copyToolbox(root) {
  const dir = join(root, 'plugins', 'toolbox');
  await cp(join(REPO_ROOT, 'plugins', 'toolbox'), dir, { recursive: true });
  return dir;
}

async function makeHost() {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-tb-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-tb-ud-'));
  await copyToolbox(root);
  const host = await createPluginHost({
    rootDir: root,
    userDataDir: userData,
    assistant: {},
    openSettings: () => {},
  });
  await host.load();
  return {
    host,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(userData, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 纯逻辑：JSON
// ---------------------------------------------------------------------------

test('JSON：格式化能往返，顶层对象报键数', () => {
  const result = formatJson('{"b":1,"a":[1,2]}');
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), { b: 1, a: [1, 2] });
  assert.match(result.summary, /对象，2 个键/);
});

test('JSON：压缩成一行', () => {
  const result = minifyJson('{ "a": 1, "b": [1, 2] }');
  assert.equal(result.ok, true);
  assert.equal(result.output, '{"a":1,"b":[1,2]}');
});

test('JSON：报错带行号与列号（引擎给位置时）', () => {
  // 这个输入在新旧引擎下都带 position / line / column。
  const result = validateJson('{"a": 1, bad}');
  assert.equal(result.ok, false);
  assert.ok(result.error.line >= 1);
  assert.ok(result.error.column >= 1);
});

test('JSON：引擎不给位置时，报错被压成一行', () => {
  const result = validateJson('{\n  "a": 1,\n  "b": }');
  assert.equal(result.ok, false);
  assert.ok(result.error.message);
  assert.doesNotMatch(result.error.message, /[\r\n]/);
});

test('JSON：validateJson 不改原文，顶层数组报元素数', () => {
  const result = validateJson('[1, 2, 3]');
  assert.equal(result.ok, true);
  assert.match(result.summary, /数组，3 个元素/);
});

// ---------------------------------------------------------------------------
// 纯逻辑：Base64 / URL
// ---------------------------------------------------------------------------

test('Base64：中文走 UTF-8，能往返', () => {
  const encoded = base64Encode('你好，世界');
  assert.equal(base64Decode(encoded), '你好，世界');
});

test('Base64：不是合法字符串时抛错', () => {
  assert.throws(() => base64Decode('!!!'), /Base64/);
  assert.throws(() => base64Decode('abc'), /Base64/);
});

test('URL：编解码往返，坏的 % 序列抛错', () => {
  assert.equal(urlEncode('a b&c='), 'a%20b%26c%3D');
  assert.equal(urlDecode('a%20b%26c%3D'), 'a b&c=');
  assert.throws(() => urlDecode('%'));
});

// ---------------------------------------------------------------------------
// 纯逻辑：时间戳
// ---------------------------------------------------------------------------

test('时间戳：秒与毫秒都认，自动按数量级判断', () => {
  const seconds = timestampToDate('1730000000', 'auto');
  const millis = timestampToDate('1730000000000', 'auto');
  assert.equal(seconds.ok, true);
  assert.equal(millis.ok, true);
  assert.equal(seconds.unit, 's');
  assert.equal(millis.unit, 'ms');
  assert.equal(seconds.ms, millis.ms);
  assert.match(seconds.iso, /Z$/);
  assert.ok(seconds.weekday.startsWith('星期'));
});

test('时间戳：显式单位不受数量级影响', () => {
  const result = timestampToDate('1730000000', 'ms');
  assert.equal(result.ok, true);
  assert.equal(result.ms, 1730000000);
});

test('时间戳：认不出的输入说明白', () => {
  assert.equal(timestampToDate('', 'auto').ok, false);
  assert.equal(timestampToDate('abc', 'auto').ok, false);
  assert.equal(timestampToDate('99999999999999999999', 'ms').ok, false);
});

test('时间戳：日期时间转回秒与毫秒，且能对上', () => {
  const ms = Date.parse('2024-11-01T08:00:00');
  const result = dateToTimestamp('2024-11-01T08:00:00');
  assert.equal(result.ok, true);
  assert.equal(result.ms, ms);
  assert.equal(result.seconds, Math.floor(ms / 1000));
});

// ---------------------------------------------------------------------------
// 纯逻辑：Token 估算
// ---------------------------------------------------------------------------

test('Token 估算：空文本是零', () => {
  assert.deepEqual(estimateTokens(''), {
    tokens: 0,
    characters: 0,
    bytes: 0,
    lines: 0,
    cjk: 0,
    other: 0,
  });
});

test('Token 估算：中文按 1.5 估，英文按 4 字符 1 token 估', () => {
  const english = estimateTokens('a'.repeat(400));
  assert.equal(english.tokens, 100);
  const chinese = estimateTokens('你好世界');
  assert.equal(chinese.tokens, 6);
  assert.equal(chinese.bytes, 12);
});

// ---------------------------------------------------------------------------
// 纯逻辑：正则
// ---------------------------------------------------------------------------

test('正则：收集每一处匹配，带下标与分组', () => {
  const result = testRegex({ pattern: '(\\d+)', flags: 'g', text: 'a12b345' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.matches.map((m) => m.index), [1, 4]);
  assert.deepEqual(result.matches[0].groups, ['12']);
});

test('正则：命名分组也收得到', () => {
  const result = testRegex({ pattern: '(?<word>\\w+)', flags: 'g', text: 'hi there' });
  assert.equal(result.ok, true);
  assert.equal(result.matches[0].namedGroups.word, 'hi');
});

test('正则：没有 g 标志只取第一处（不死循环）', () => {
  const result = testRegex({ pattern: '\\d+', flags: '', text: 'a12b345' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
});

test('正则：零宽匹配不会卡死', () => {
  const result = testRegex({ pattern: 'a*', flags: 'g', text: 'aaab', maxMatches: 10 });
  assert.equal(result.ok, true);
  assert.ok(result.count > 0);
});

test('正则：超过 maxMatches 截断并说明', () => {
  const result = testRegex({ pattern: '\\d', flags: 'g', text: '1234567890', maxMatches: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.equal(result.truncated, true);
});

test('正则：不合法的模式说明原因', () => {
  const result = testRegex({ pattern: '(', flags: 'g', text: 'x' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// 插件接在宿主上
// ---------------------------------------------------------------------------

test('工具箱插件：清单合法，目录名与 id 一致，页面在磁盘上', async () => {
  const { host, cleanup } = await makeHost();
  try {
    const meta = host.list().find((p) => p.id === 'toolbox');
    assert.ok(meta, '工具箱插件没被认出来');
    assert.equal(meta.name, '工具箱');
    assert.equal(meta.hasPage, true);
    assert.match(meta.pageUrl, /toolbox\/pages\/toolbox\.html/);
  } finally {
    await cleanup();
  }
});

test('工具箱插件：复制——写进剪贴板并回报', async () => {
  const written = [];
  globalThis.__deskPetToolboxClipboardWriter = async (text) => {
    written.push(text);
  };
  const { host, cleanup } = await makeHost();
  try {
    const result = await host.act('toolbox', 'copy', { text: 'hello' });
    assert.equal(result.copied?.ok, true);
    assert.deepEqual(written, ['hello']);

    const empty = await host.act('toolbox', 'copy', { text: '  ' });
    assert.equal(empty.copied?.ok, false);
    assert.equal(written.length, 1, '空文字不该写剪贴板');
  } finally {
    delete globalThis.__deskPetToolboxClipboardWriter;
    await cleanup();
  }
});

test('工具箱插件：复制——写不进去就说明白', async () => {
  globalThis.__deskPetToolboxClipboardWriter = async () => {
    throw new Error('剪贴板被占用');
  };
  const { host, cleanup } = await makeHost();
  try {
    const result = await host.act('toolbox', 'copy', { text: 'hello' });
    assert.equal(result.copied?.ok, false);
    assert.match(result.copied?.message || '', /剪贴板被占用/);
  } finally {
    delete globalThis.__deskPetToolboxClipboardWriter;
    await cleanup();
  }
});

test('工具箱插件：积木退路页面能画出来', () => {
  const plugin = createToolboxPlugin();
  const page = plugin.page({ ui: { makePage, textBlock } });
  return page.then((p) => {
    assert.equal(p.title, '工具箱');
    assert.equal(p.blocks.length, 1);
  });
});
