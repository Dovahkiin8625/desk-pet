import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  createBuiltinTools,
  resolveToolPath,
  killProcessTree,
} from '../../src/main/assistant/agent/tools/builtin.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';

/**
 * 内置工具集。
 *
 * 三条最容易做错的：
 * 1. **路径没有目录边界**——相对路径按工作区解析，绝对路径随便给；
 * 2. **写/执行工具要走用户审批**——用户看得见路径；
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

test('路径：相对路径按工作区解析，绝对路径原样给', () => {
  const base = join(tmpdir(), 'ws');
  assert.equal(resolveToolPath(base, 'a/b.txt'), join(base, 'a', 'b.txt'));
  assert.equal(resolveToolPath(base, join(base, 'x.txt')), join(base, 'x.txt'));
  // 别的盘符 / 工作区外面：不再拦。
  assert.equal(resolveToolPath(base, join(base, '..', '逃出去.txt')), join(tmpdir(), '逃出去.txt'));
});

test('工具集：内置工具齐活，风险等级对得上', () => {
  const tools = createBuiltinTools({});
  const names = tools.map((t) => t.name);
  for (const name of [
    'fs.read',
    'fs.list',
    'fs.search',
    'fs.write',
    'shell.exec',
    'app.launch',
    'harness.run',
  ]) {
    assert.ok(names.includes(name), `少了 ${name}`);
  }
  assert.equal(pick(tools, 'fs.read').risk, 'read');
  assert.equal(pick(tools, 'fs.write').risk, 'write');
  assert.equal(pick(tools, 'shell.exec').risk, 'exec');
  assert.equal(pick(tools, 'app.launch').risk, 'exec');
  assert.equal(pick(tools, 'harness.run').risk, 'exec');
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

test('fs.read：工作区外面的文件读得到', async () => {
  const dir = await tmpDir();
  try {
    await mkdir(join(dir, 'inside'), { recursive: true });
    await writeFile(join(dir, 'outside.txt'), '外面的内容', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => join(dir, 'inside') });
    const out = await pick(tools, 'fs.read').run({ path: join(dir, 'outside.txt') });
    assert.match(out.text, /外面的内容/);
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

/**
 * 超时是 `shell.exec` 唯一的刹车。
 *
 * 之前它只刹住了「返回」，没刹住「进程」：
 * Windows 上 `child.kill()` 只杀 cmd.exe 这一层，孙进程照样跑，
 * 而且 `close` 事件要等所有管道关闭——孙进程还活着就永远不结算，
 * 整个 agent 循环就卡在那儿转圈。
 */

/** 造一个假的子进程：收得到事件，但自己永远不结束。 */
function fakeChild(pid = 2147483647) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
  });
}

test('shell.exec：命令超时要立刻拒绝，不能等命令自己结束', async () => {
  const child = fakeChild();
  const spawnCalls = [];
  const spawn = (cmd, args) => {
    spawnCalls.push([cmd, args]);
    return child;
  };
  const tools = createBuiltinTools({ spawn, getTimeoutMs: () => 60 });
  const started = Date.now();
  await assert.rejects(() => pick(tools, 'shell.exec').run({ command: '永远别结束' }), /超时/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `超时后应该马上拒绝，实际等了 ${elapsed} 毫秒`);
  assert.ok(
    child.killed || spawnCalls.some(([cmd]) => String(cmd).includes('taskkill')),
    '子进程要被杀掉——留着它继续跑等于没人管它'
  );
});

test('shell.exec：任务被取消时，命令也要被带走', async () => {
  const child = fakeChild();
  const spawnCalls = [];
  const controller = new AbortController();
  const tools = createBuiltinTools({
    spawn: (cmd) => {
      spawnCalls.push(String(cmd));
      return child;
    },
    getTimeoutMs: () => 0,
  });
  const promise = pick(tools, 'shell.exec').run({ command: '长跑' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => promise, /取消/);
  assert.ok(
    child.killed || spawnCalls.some((cmd) => cmd.includes('taskkill')),
    '取消要带走子进程'
  );
});

test('杀进程树：Windows 用 taskkill /T /F，POSIX 杀整个进程组', () => {
  const calls = [];
  const child = fakeChild(4242);
  const mode = killProcessTree(child, {
    platform: 'win32',
    spawn: (cmd, args) => {
      calls.push([cmd, args]);
      return fakeChild();
    },
    kill: () => {
      throw new Error('不该走到这里');
    },
  });
  assert.equal(mode, 'taskkill');
  assert.deepEqual(calls[0], ['taskkill', ['/pid', '4242', '/T', '/F']]);

  const killed = [];
  const mode2 = killProcessTree(child, {
    platform: 'linux',
    spawn: () => fakeChild(),
    kill: (pid, sig) => killed.push([pid, sig]),
  });
  assert.equal(mode2, 'group');
  assert.deepEqual(killed, [[-4242, 'SIGKILL']]);
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

/**
 * 链接：fs.read 跟得过去，fs.search 不跟。
 *
 * 边界没了，所以读链接指向的文件是允许的。
 * 但搜索是**遍历目录**：跟着链接走可能绕回上级目录形成死循环，
 * 所以遍历一律跳过链接——要读链接里的东西，用 fs.read 指名完整路径。
 */

test('链接：fs.read 读得到，fs.search 不顺着链接爬', async () => {
  const outer = await tmpDir();
  const ws = await tmpDir();
  try {
    await writeFile(join(outer, 'secret.txt'), 'TOP SECRET', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => ws });
    const read = pick(tools, 'fs.read');
    const search = pick(tools, 'fs.search');

    // **目录联接**（Windows 上不需要管理员权限）。
    try {
      await symlink(outer, join(ws, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 这个系统连目录链接都不让建（没权限），那这条测不了
    }
    assert.match((await read.run({ path: 'link/secret.txt' })).text, /TOP SECRET/);
    assert.equal((await search.run({ pattern: 'TOP SECRET' })).data.hits.length, 0);

    // **文件链接**：建文件链接在 Windows 上要开发者模式或管理员，没有就跳过这一段。
    try {
      await symlink(join(outer, 'secret.txt'), join(ws, 'secret-link.txt'), 'file');
    } catch {
      return;
    }
    assert.match((await read.run({ path: 'secret-link.txt' })).text, /TOP SECRET/);
    assert.equal((await search.run({ pattern: 'TOP SECRET' })).data.hits.length, 0);
  } finally {
    await rm(outer, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
});

test('fs.read：太大的文件不读——不然主进程会被撑爆', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(3 * 1024 * 1024), 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    await assert.rejects(() => pick(tools, 'fs.read').run({ path: 'big.txt' }), /太大/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.search：按字节算文件大小，不能按字数', async () => {
  const dir = await tmpDir();
  try {
    // 60 万个汉字：字数不到 1M，字节数却有 1.8M——
    // 按字数算会放它过去，按字节才算拦得住。
    await writeFile(join(dir, 'cn.txt'), '中'.repeat(600000), 'utf8');
    const size = (await stat(join(dir, 'cn.txt'))).size;
    assert.ok(size > 1024 * 1024, '这个文件按字节算超过 1M');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.search').run({ pattern: '中' });
    assert.equal(out.data.hits.length, 0, '超大的文件要跳过，不该读进内存');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
