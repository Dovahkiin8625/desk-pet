import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  createBuiltinTools,
  resolveInsideWorkspace,
} from '../../src/main/assistant/agent/tools/builtin.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';

/**
 * 内置工具集。
 *
 * 三条最容易做错的：
 * 1. **只读工具**必须被工作区关住（它们自动放行，没人盯着）；
 * 2. **写/执行工具不设边界**——它们要走用户审批，用户看得见路径；
 * 3. 工具出错要**抛**，不是返回空字符串——错误要喂回模型，让它换条路。
 */

async function tmpDir() {
  return mkdtemp(join(tmpdir(), 'desk-pet-agent-'));
}

/** 按名字拿一个工具。 */
function pick(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `没有工具 ${name}`);
  return t;
}

test('工作区：路径越界要拦住', () => {
  const base = join(tmpdir(), 'ws');
  assert.equal(resolveInsideWorkspace(base, 'a/b.txt'), join(base, 'a', 'b.txt'));
  assert.equal(resolveInsideWorkspace(base, join(base, 'x.txt')), join(base, 'x.txt'));
  assert.throws(() => resolveInsideWorkspace(base, '../逃出去.txt'), /工作区/);
  assert.throws(() => resolveInsideWorkspace(base, join(base, '..', '逃出去.txt')), /工作区/);
});

test('工具集：七个内置工具齐活，风险等级对得上', () => {
  const tools = createBuiltinTools({});
  const names = tools.map((t) => t.name);
  for (const name of [
    'fs.read',
    'fs.list',
    'fs.search',
    'fs.write',
    'shell.exec',
    'app.launch',
    'clipboard.read',
  ]) {
    assert.ok(names.includes(name), `少了 ${name}`);
  }
  assert.equal(pick(tools, 'fs.read').risk, 'read');
  assert.equal(pick(tools, 'fs.write').risk, 'write');
  assert.equal(pick(tools, 'shell.exec').risk, 'exec');
  assert.equal(pick(tools, 'app.launch').risk, 'exec');
});

test('工具集：每个工具都能装进注册表', () => {
  const reg = createToolRegistry();
  const registered = reg.registerAll(createBuiltinTools({}));
  assert.equal(registered.length, 7);
  // 宿主下限把 shell.exec 抬成 exec。
  assert.equal(reg.get('shell.exec').risk, 'exec');
});

test('工作区：没配工作区就退回用户主目录', async () => {
  const tools = createBuiltinTools({ getWorkspace: () => '' });
  const out = await pick(tools, 'fs.list').run({});
  assert.equal(out.data.path, homedir());
});

test('fs.read：读得到文件，读不到就抛错', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(join(dir, 'a.txt'), '第一行\n第二行\n第三行\n', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const read = pick(tools, 'fs.read');
    const out = await read.run({ path: 'a.txt' });
    assert.match(out.text, /第一行/);
    assert.equal(out.data.totalLines, 4, '末尾那个空行也算一行');
    await assert.rejects(() => read.run({ path: '没有这个.txt' }), /找不到|不存在|ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.read：能只读一段行', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(join(dir, 'a.txt'), '1\n2\n3\n4\n5\n', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.read').run({ path: 'a.txt', start: 2, end: 3 });
    assert.equal(out.text.trim(), '2\n3');
    assert.equal(out.data.start, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.read：读工作区外面的文件要拦住', async () => {
  const dir = await tmpDir();
  try {
    await mkdir(join(dir, 'inside'), { recursive: true });
    const tools = createBuiltinTools({ getWorkspace: () => join(dir, 'inside') });
    await assert.rejects(
      () => pick(tools, 'fs.read').run({ path: join(dir, 'outside.txt') }),
      /工作区/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.list：列目录', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(join(dir, 'a.txt'), 'x', 'utf8');
    await mkdir(join(dir, '子目录'), { recursive: true });
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.list').run({});
    assert.equal(out.data.entries.length, 2);
    assert.ok(out.text.includes('a.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.search：搜得到内容，搜不到给空结果', async () => {
  const dir = await tmpDir();
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.js'), 'const needle = 1;\n', 'utf8');
    await writeFile(join(dir, 'src', 'b.js'), 'const other = 2;\n', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.search').run({ pattern: 'needle' });
    assert.equal(out.data.hits.length, 1);
    assert.ok(out.text.includes('a.js'));
    const none = await pick(tools, 'fs.search').run({ pattern: '根本没有这个词' });
    assert.equal(none.data.hits.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.write：写得进文件', async () => {
  const dir = await tmpDir();
  try {
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.write').run({ path: '写一个.txt', content: '你好' });
    assert.ok(out.data.path.endsWith('写一个.txt'));
    assert.equal(await readFile(join(dir, '写一个.txt'), 'utf8'), '你好');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell.exec：跑一条命令，拿到输出', async () => {
  const tools = createBuiltinTools({});
  const out = await pick(tools, 'shell.exec').run({ command: 'echo hello-from-shell' });
  assert.ok(out.text.includes('hello-from-shell'), out.text);
  assert.equal(out.data.code, 0);
});

test('shell.exec：命令起不来要抛错', async () => {
  const tools = createBuiltinTools({});
  await assert.rejects(() => pick(tools, 'shell.exec').run({ command: '' }), /命令/);
});

test('app.launch：按名字找到并启动程序', async () => {
  const launched = [];
  const index = {
    list: async () => [
      { id: 'app:notepad', name: '记事本', target: 'C:/notepad.exe' },
      { id: 'app:chrome', name: 'Google Chrome', target: 'C:/chrome.exe' },
    ],
    launch: async (id) => {
      launched.push(id);
      return { ok: true, message: '已打开' };
    },
  };
  const tools = createBuiltinTools({ getAppIndex: () => index });
  const out = await pick(tools, 'app.launch').run({ name: 'chrome' });
  assert.deepEqual(launched, ['app:chrome']);
  assert.equal(out.data.name, 'Google Chrome');
});

test('app.launch：找不到程序要抛错', async () => {
  const index = { list: async () => [], launch: async () => ({ ok: true }) };
  const tools = createBuiltinTools({ getAppIndex: () => index });
  await assert.rejects(() => pick(tools, 'app.launch').run({ name: '不存在的程序' }), /没找到/);
});

test('clipboard.read：剪贴板助手没开就不给读', async () => {
  const tools = createBuiltinTools({
    isClipboardEnabled: () => false,
    readClipboard: async () => '秘密',
  });
  await assert.rejects(() => pick(tools, 'clipboard.read').run({}), /剪贴板/);
});

test('clipboard.read：开着了才读得到', async () => {
  const tools = createBuiltinTools({
    isClipboardEnabled: () => true,
    readClipboard: async () => '复制来的东西',
  });
  const out = await pick(tools, 'clipboard.read').run({});
  assert.match(out.text, /复制来的东西/);
});
