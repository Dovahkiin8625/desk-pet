import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSystemSearch, webSearchUrl } from '../../src/main/systemSearch.js';

/**
 * 系统搜索：查文件、抽图标、打开与定位。
 *
 * 这一层不碰 electron：开文件、抽图标都是系统调用，
 * 由调用方注入——于是这里能直接测。
 */

/** 假助手：按 op 应答。 */
function fakeHost(handlers = {}) {
  const calls = [];
  return {
    calls,
    available: true,
    async request(op, payload) {
      calls.push({ op, payload });
      const handler = handlers[op];
      if (typeof handler === 'function') return handler(payload);
      if (handler) return handler;
      return { items: [] };
    },
  };
}

test('查文件：拿索引里的结果，标上所在文件夹', async () => {
  const psHost = fakeHost({
    files: {
      items: [{ name: '季度报告.docx', path: 'C:\\Users\\me\\Documents\\季度报告.docx' }],
    },
  });
  const search = createSystemSearch({ psHost });
  const files = await search.searchFiles('报告');
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, 'file');
  assert.equal(files[0].name, '季度报告.docx');
  assert.equal(files[0].target, 'C:\\Users\\me\\Documents\\季度报告.docx');
  assert.equal(files[0].hint, 'Documents', '副标题是它所在的文件夹');
  assert.equal(files[0].match, 'name', '默认是「文件名里有这个词」');
});

test('查文件：内容里命中的要标出来', async () => {
  const psHost = fakeHost({
    files: {
      items: [{ name: '简历.pdf', path: 'C:\\Users\\me\\简历.pdf', match: 'content' }],
    },
  });
  const search = createSystemSearch({ psHost });
  const files = await search.searchFiles('报告');
  assert.equal(files[0].match, 'content');
});

test('查文件：空查询不查索引', async () => {
  const psHost = fakeHost({});
  const search = createSystemSearch({ psHost });
  assert.deepEqual(await search.searchFiles('  '), []);
  assert.equal(psHost.calls.length, 0);
});

test('查文件：索引用不了时改扫常用文件夹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-search-'));
  try {
    await mkdir(join(dir, '子目录'), { recursive: true });
    await writeFile(join(dir, '季度报告.docx'), 'x');
    await writeFile(join(dir, '子目录', '会议纪要.txt'), 'x');
    const psHost = fakeHost({
      files: () => {
        throw new Error('索引服务没开');
      },
    });
    const search = createSystemSearch({ psHost, fallbackDirs: [dir] });
    const files = await search.searchFiles('报告');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, '季度报告.docx');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('查文件：索引能用但没匹配时，不去扫文件夹', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-search-'));
  try {
    await writeFile(join(dir, '季度报告.docx'), 'x');
    const psHost = fakeHost({ files: { items: [] } });
    const search = createSystemSearch({ psHost, fallbackDirs: [dir] });
    assert.deepEqual(await search.searchFiles('报告'), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('抽图标：抽过的记下来，不重复抽', async () => {
  const psHost = fakeHost({
    icons: (payload) => ({
      items: (payload.paths || []).map((path) => ({ path, icon: 'AAAA' })),
    }),
  });
  const search = createSystemSearch({ psHost });
  const first = await search.icons(['C:\\a.exe']);
  assert.equal(first['C:\\a.exe'], 'data:image/png;base64,AAAA');
  const callsAfterFirst = psHost.calls.length;
  const second = await search.icons(['C:\\a.exe']);
  assert.deepEqual(second, first);
  assert.equal(psHost.calls.length, callsAfterFirst, '同一个路径不该抽第二次');
});

test('打开：文件走系统默认程序，设置页与网页走地址', async () => {
  const opened = [];
  const search = createSystemSearch({
    psHost: fakeHost({}),
    openPath: async (path) => {
      opened.push(path);
      return null;
    },
    openExternal: async (target) => {
      opened.push(target);
    },
  });
  assert.equal((await search.open({ kind: 'file', path: 'C:\\a.txt' })).ok, true);
  assert.equal((await search.open({ kind: 'setting', target: 'ms-settings:display' })).ok, true);
  await search.open({ kind: 'web', query: '桌宠' });
  assert.deepEqual(opened, ['C:\\a.txt', 'ms-settings:display', webSearchUrl('桌宠')]);
});

test('打开失败要说清楚是谁打不开', async () => {
  const search = createSystemSearch({
    psHost: fakeHost({}),
    openPath: async () => '文件不存在',
  });
  const result = await search.open({ kind: 'file', path: 'C:\\没有这个.txt' });
  assert.equal(result.ok, false);
  assert.match(result.message, /打不开/);
});

test('定位：在资源管理器里找到那个文件', async () => {
  const located = [];
  const search = createSystemSearch({
    psHost: fakeHost({}),
    showItemInFolder: (path) => located.push(path),
  });
  const result = await search.reveal({ kind: 'file', path: 'C:\\a.txt' });
  assert.equal(result.ok, true);
  assert.deepEqual(located, ['C:\\a.txt']);
});

test('定位：没有路径的条目就说没有所在目录', async () => {
  const search = createSystemSearch({ psHost: fakeHost({}) });
  const result = await search.reveal({ kind: 'setting', target: 'ms-settings:display' });
  assert.equal(result.ok, false);
});
