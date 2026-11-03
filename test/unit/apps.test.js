import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAppIndex, defaultSources, scanSources } from '../../src/main/apps.js';

/**
 * 本机程序索引。
 *
 * 扫盘这一段不能真的去扫本机（慢，而且结果随机器变），
 * 所以这里塞一份假的文件系统：目录 → 条目列表。
 */

/** 造一个假的目录读取。 */
function fakeFs(tree) {
  return async (dir) => {
    const items = tree[dir];
    if (!items) throw new Error(`没有这个目录：${dir}`);
    return items.map((item) => ({
      name: item.name,
      isDirectory: () => Boolean(item.dir),
    }));
  };
}

const START_MENU = join('start-menu', 'Programs');
const TOOLS = join('start-menu', 'Programs', '工具');
const SYSTEM32 = join('C:\\Windows', 'System32');
const PROGRAMS = join('C:\\Program Files');

test('开始菜单的快捷方式会被收进来，名字去掉 .lnk', async () => {
  const tree = {
    [START_MENU]: [{ name: 'Chrome.lnk' }, { name: '工具', dir: true }],
    [TOOLS]: [{ name: '截图.lnk' }, { name: 'readme.txt' }],
  };
  const found = await scanSources([{ kind: 'shortcut', dir: START_MENU }], {
    readDir: fakeFs(tree),
    env: {},
  });
  const names = found.map((e) => e.name);
  assert.deepEqual(names.sort(), ['Chrome', '截图'], '只收 .lnk，txt 不收');
  // 提示写的是「在开始菜单的哪个分组里」——那才是用户认得的东西。
  const shot = found.find((e) => e.name === '截图');
  assert.equal(shot.hint, '工具');
  const chrome = found.find((e) => e.name === 'Chrome');
  assert.equal(chrome.hint, '开始菜单');
});

test('PATH 目录里的可执行文件会被收进来', async () => {
  const bin = join('C:\\tools', 'bin');
  const tree = {
    [bin]: [
      { name: 'git.exe' },
      { name: 'node.cmd' },
      { name: 'readme.md' },
      { name: 'setup.exe' },
    ],
  };
  const found = await scanSources([{ kind: 'path', dir: bin }], {
    readDir: fakeFs(tree),
    env: { SystemRoot: 'C:\\Windows' },
  });
  const names = found.map((e) => e.name).sort();
  // setup 是安装器，不是「能用的程序」。
  assert.deepEqual(names, ['git', 'node']);
});

test('系统目录里只收单子上的那几个工具', async () => {
  const tree = {
    [SYSTEM32]: [{ name: 'notepad.exe' }, { name: 'bcdedit.exe' }],
  };
  const found = await scanSources([{ kind: 'path', dir: SYSTEM32 }], {
    readDir: fakeFs(tree),
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.deepEqual(
    found.map((e) => e.name),
    ['notepad'],
    'bcdedit 那种系统碎片不该出现在搜索结果里'
  );
});

test('程序目录里的 exe 会被收进来，深度有上限', async () => {
  const vendor = join(PROGRAMS, '某厂商');
  const app = join(vendor, '某程序');
  const deep = join(app, 'bin');
  const tree = {
    [PROGRAMS]: [{ name: '某厂商', dir: true }],
    [vendor]: [{ name: '某程序', dir: true }],
    [app]: [{ name: '某程序.exe' }, { name: 'bin', dir: true }],
    [deep]: [{ name: '藏得很深的.exe' }],
  };
  const found = await scanSources([{ kind: 'program', dir: PROGRAMS }], {
    readDir: fakeFs(tree),
    env: {},
  });
  const names = found.map((e) => e.name);
  assert.ok(names.includes('某程序'), '程序目录里的 exe 要收');
  assert.ok(!names.includes('藏得很深的.exe'), '超过深度上限的不要收');
});

test('同一个目标、同一个名字，都只留一条', async () => {
  const tree = {
    [START_MENU]: [{ name: 'Chrome.lnk' }],
    [PROGRAMS]: [{ name: 'chrome.exe' }, { name: 'firefox.exe' }],
  };
  const found = await scanSources(
    [
      { kind: 'shortcut', dir: START_MENU },
      { kind: 'program', dir: PROGRAMS },
    ],
    { readDir: fakeFs(tree), env: {} }
  );
  // Chrome 与 chrome 是同一个名字 → 只留先来的那条（开始菜单那条）。
  // 指向不同文件但名字不同的 firefox 留着。
  assert.deepEqual(found.map((e) => e.name), ['Chrome', 'firefox']);
  const same = await scanSources(
    [
      { kind: 'shortcut', dir: START_MENU },
      { kind: 'shortcut', dir: START_MENU },
    ],
    { readDir: fakeFs(tree), env: {} }
  );
  assert.equal(same.length, 1, '同一个文件只留一条');
});

test('开始菜单里的安装器快捷方式不算程序', async () => {
  const tree = {
    [START_MENU]: [
      { name: 'Chrome.lnk' },
      { name: '卸载 Chrome.lnk' },
      { name: 'Install Additional Tools for Node.js.lnk' },
    ],
  };
  const found = await scanSources([{ kind: 'shortcut', dir: START_MENU }], {
    readDir: fakeFs(tree),
    env: {},
  });
  assert.deepEqual(
    found.map((e) => e.name),
    ['Chrome'],
    '安装器与卸载器的快捷方式不是「能用的程序」'
  );
});

test('id 用小写路径：Windows 上路径不区分大小写', async () => {
  const tree = { [START_MENU]: [{ name: 'Chrome.lnk' }] };
  const found = await scanSources([{ kind: 'shortcut', dir: START_MENU }], {
    readDir: fakeFs(tree),
    env: {},
  });
  assert.equal(found[0].id, `app:${found[0].target.toLowerCase()}`);
});

test('默认来源：开始菜单（两处）、PATH、程序目录', () => {
  const sources = defaultSources({
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    ProgramData: 'C:\\ProgramData',
    PATH: 'C:\\tools\\bin;C:\\Windows\\System32',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  });
  const kinds = sources.map((s) => s.kind);
  assert.equal(kinds.filter((k) => k === 'shortcut').length, 2, '用户级与全体用户级两处开始菜单');
  assert.ok(kinds.includes('path'), '要扫 PATH');
  assert.equal(kinds.filter((k) => k === 'program').length, 3, 'Program Files、x86 与 LOCALAPPDATA');
});

test('索引：只扫一次，之后给缓存', async () => {
  let scans = 0;
  const tree = { [START_MENU]: [{ name: 'Chrome.lnk' }] };
  const index = createAppIndex({
    sources: [{ kind: 'shortcut', dir: START_MENU }],
    readDir: async (dir) => {
      scans += 1;
      return fakeFs(tree)(dir);
    },
    open: async () => null,
  });
  assert.equal(scans, 0, '建索引之前不该扫盘');
  const first = await index.list();
  const second = await index.list();
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(scans, 1, '第二次不该再扫盘');
});

test('启动一个程序：把目标交给 open，成功时给出提示', async () => {
  const opened = [];
  const tree = { [START_MENU]: [{ name: 'Chrome.lnk' }] };
  const index = createAppIndex({
    sources: [{ kind: 'shortcut', dir: START_MENU }],
    readDir: fakeFs(tree),
    open: async (target) => {
      opened.push(target);
      return null;
    },
  });
  const list = await index.list();
  assert.equal(list.length, 1);
  const result = await index.launch(list[0].id);
  assert.deepEqual(opened, [list[0].target]);
  assert.equal(result.ok, true);
  assert.equal(result.message, '已打开 Chrome');
});

test('启动失败时把原因说出来，不静悄悄地失败', async () => {
  const tree = { [START_MENU]: [{ name: 'Chrome.lnk' }] };
  const index = createAppIndex({
    sources: [{ kind: 'shortcut', dir: START_MENU }],
    readDir: fakeFs(tree),
    open: async () => '系统找不到指定的文件',
  });
  const list = await index.list();
  const result = await index.launch(list[0].id);
  assert.equal(result.ok, false);
  assert.match(result.message, /打不开/);
});

test('启动不存在的程序：说找不到，而不是崩掉', async () => {
  const index = createAppIndex({
    sources: [],
    readDir: fakeFs({}),
    open: async () => null,
  });
  const result = await index.launch('app:不存在');
  assert.equal(result.ok, false);
  assert.match(result.message, /找不到/);
});

test('索引重建完了会通知监听者', async () => {
  const tree = { [START_MENU]: [{ name: 'Chrome.lnk' }] };
  const index = createAppIndex({
    sources: [{ kind: 'shortcut', dir: START_MENU }],
    readDir: fakeFs(tree),
    open: async () => null,
  });
  const seen = [];
  index.onChange((list) => seen.push(list.length));
  await index.list();
  assert.deepEqual(seen, [1], '建好之后要通知一次');
});
