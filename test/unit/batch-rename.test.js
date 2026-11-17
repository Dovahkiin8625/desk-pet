import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { validateManifest } from '../../src/shared/plugin.js';
import {
  DEFAULT_RULES,
  normalizeRules,
  renameName,
  splitName,
  findNameProblem,
  buildPlan,
} from '../../external-plugins/batch-rename/lib/plan.js';
import { applyRenames, undoRenames } from '../../external-plugins/batch-rename/lib/execute.js';
import { readUndo, writeUndo, clearUndo } from '../../external-plugins/batch-rename/lib/store.js';

/**
 * 外部插件 batch-rename（不内置、不接给 agent）的单元测试。
 *
 * 只测纯逻辑与磁盘操作：宿主加载那条路不测——
 * 这个插件的入口 import 了 electron，plain `node --test` 里没有它。
 */

const PLUGIN_DIR = join(process.cwd(), 'external-plugins', 'batch-rename');

// ---------------------------------------------------------------- 清单

test('清单：合法，且没有 tools / skill（不接给 agent）', () => {
  const raw = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  const out = validateManifest(raw);
  assert.ok(out.ok, `清单不合法：${out.errors?.join('；')}`);
  assert.equal(out.value.id, 'batch-rename');
  assert.deepEqual(out.value.toolErrors, []);
  assert.deepEqual(out.value.skillErrors, []);
  // 不接给 agent 是这个插件的明确属性：清单里不该有这两段。
  assert.equal('tools' in raw, false);
  assert.equal('skill' in raw, false);
});

// ---------------------------------------------------------------- 规则

test('拆名：a.tar.gz 的扩展名是 gz；.gitignore 算主体', () => {
  assert.deepEqual(splitName('a.tar.gz'), { stem: 'a.tar', ext: 'gz' });
  assert.deepEqual(splitName('.gitignore'), { stem: '.gitignore', ext: '' });
  assert.deepEqual(splitName('无扩展名'), { stem: '无扩展名', ext: '' });
});

test('规整：坏值退回默认（大小写、位数夹紧、模式）', () => {
  const r = normalizeRules({ caseMode: 'x', mode: 'x', numbering: { width: 99, position: 'middle' } });
  assert.equal(r.caseMode, 'none');
  assert.equal(r.mode, 'replace');
  assert.equal(normalizeRules({ mode: 'rename' }).mode, 'rename');
  assert.equal(r.numbering.width, 8);
  assert.equal(r.numbering.position, 'prefix');
  assert.deepEqual(normalizeRules(null), DEFAULT_RULES);
});

test('查找/替换：字面量、正则、忽略大小写', () => {
  const base = { ...DEFAULT_RULES };
  assert.equal(renameName('photo-final.jpg', { ...base, find: '-final', replace: '' }, 0).newName, 'photo.jpg');
  assert.equal(renameName('IMG_001.jpg', { ...base, find: 'img', replace: 'photo', ignoreCase: true }, 0).newName, 'photo_001.jpg');
  assert.equal(renameName('IMG_001.jpg', { ...base, find: '^img', replace: 'photo', regex: true, ignoreCase: true }, 0).newName, 'photo_001.jpg');
});

test('重新命名为：模板接管主文件名，序号交给「编号」', () => {
  const base = { ...DEFAULT_RULES, mode: 'rename', find: 'a', replace: 'x', suffix: '-suf', caseMode: 'upper' };
  // rename 模式：查找/替换、后缀、大小写全跳过，序号由编号说了算。
  assert.equal(
    renameName('holiday-001.jpg', { ...base, renameTo: '度假', numbering: { enabled: true, start: 7, width: 3, position: 'suffix', separator: '-' } }, 0).newName,
    '度假-007.jpg'
  );
  assert.equal(
    renameName('holiday-001.jpg', { ...base, renameTo: '度假', numbering: { enabled: true, start: 1, width: 2, position: 'prefix', separator: '-' } }, 2).newName,
    '03-度假.jpg'
  );
  // 编号没勾：模板原样用，{n} 不再是特殊语法（就是字面字符）。
  assert.equal(
    renameName('holiday-001.jpg', { ...base, renameTo: '度假{n}', numbering: { enabled: false, start: 1, width: 2, position: 'prefix', separator: '-' } }, 2).newName,
    '度假{n}.jpg'
  );
  // 模板 + 扩展名规则照常生效。
  assert.equal(
    renameName('a.JPEG', { ...DEFAULT_RULES, mode: 'rename', renameTo: 'x', extFind: 'jpeg', extReplace: 'jpg' }, 0).newName,
    'x.jpg'
  );
  // 模板留空 = 什么都不改（连编号也不套，空模板 + 默认勾上的编号不能凭空改名）。
  assert.equal(
    renameName('a.jpg', { ...DEFAULT_RULES, mode: 'rename', numbering: { enabled: true, start: 1, width: 2, position: 'prefix', separator: '-' } }, 0).newName,
    'a.jpg'
  );
  // 留空时扩展名规则照常生效。
  assert.equal(
    renameName('a.JPEG', { ...DEFAULT_RULES, mode: 'rename', extFind: 'jpeg', extReplace: 'jpg' }, 0).newName,
    'a.jpg'
  );
});

test('查找/替换：正则编译不过 → ok=false', () => {
  const out = renameName('a.txt', { ...DEFAULT_RULES, find: '([', regex: true }, 0);
  assert.equal(out.ok, false);
  assert.match(out.error, /正则/);
});

test('前后缀、大小写、编号（位数夹紧、位置、起始值）', () => {
  const base = { ...DEFAULT_RULES, prefix: '度假-', suffix: '-v2', caseMode: 'lower' };
  assert.equal(renameName('IMG_001.JPG', base, 0).newName, '度假-img_001-v2.JPG');

  const num = { ...DEFAULT_RULES, numbering: { enabled: true, start: 3, width: 3, position: 'prefix', separator: '-' } };
  assert.equal(renameName('a.txt', num, 0).newName, '003-a.txt');
  assert.equal(renameName('a.txt', num, 7).newName, '010-a.txt');

  const suffixNum = { ...DEFAULT_RULES, numbering: { enabled: true, start: 1, width: 2, position: 'suffix', separator: '_' } };
  assert.equal(renameName('a.txt', suffixNum, 0).newName, 'a_01.txt');
});

test('扩展名：指定原扩展名才改；留空=全部；新留空=删除', () => {
  const onlyJpeg = { ...DEFAULT_RULES, extFind: 'jpeg', extReplace: 'jpg' };
  assert.equal(renameName('a.jpeg', onlyJpeg, 0).newName, 'a.jpg');
  assert.equal(renameName('a.JPEG', onlyJpeg, 0).newName, 'a.jpg'); // 扩展名按写的来（不带大小写花样）
  assert.equal(renameName('a.png', onlyJpeg, 0).newName, 'a.png');

  const all = { ...DEFAULT_RULES, extFind: '', extReplace: 'bak' };
  assert.equal(renameName('a.txt', all, 0).newName, 'a.bak');
  assert.equal(renameName('noext', all, 0).newName, 'noext.bak');

  const drop = { ...DEFAULT_RULES, extFind: 'tmp', extReplace: '' };
  assert.equal(renameName('a.tmp', drop, 0).newName, 'a');

  assert.equal(renameName('a.txt', DEFAULT_RULES, 0).newName, 'a.txt');
});

test('顺序：先查找替换，再大小写，再前后缀，再扩展名，最后编号', () => {
  const rules = {
    ...DEFAULT_RULES,
    find: 'b', replace: 'X', ignoreCase: true,
    caseMode: 'lower',
    prefix: 'p-',
    numbering: { enabled: true, start: 1, width: 1, position: 'prefix', separator: '-' },
  };
  assert.equal(renameName('B.jpg', rules, 0).newName, '1-p-x.jpg');
});

test('非法名字：违法字符、结尾点 / 空格、变空', () => {
  assert.match(findNameProblem('a:b.txt'), /「:」/);
  assert.match(findNameProblem('a/b.txt'), /「\/」/);
  assert.match(findNameProblem('a.txt.'), /结尾/);
  assert.match(findNameProblem('a.txt '), /结尾/);
  assert.match(findNameProblem(''), /变空/);
  assert.match(findNameProblem('CON.txt'), /保留名/);
  assert.match(findNameProblem('nul'), /保留名/);
  assert.match(findNameProblem('lpt9.md'), /保留名/);
  assert.equal(findNameProblem('content.txt'), '');
  assert.equal(findNameProblem('正常的名字.txt'), '');
});

// ---------------------------------------------------------------- 计划

test('buildPlan：未变化 / 正常 / 空批次', () => {
  const files = [{ path: 'D:/pics/a.jpg' }, { path: 'D:/pics/b.jpg' }];
  const same = buildPlan(files, DEFAULT_RULES);
  assert.deepEqual(same.counts, { total: 2, changed: 0, unchanged: 2, invalid: 0, collision: 0 });

  const changed = buildPlan(files, { ...DEFAULT_RULES, suffix: '-x' });
  assert.equal(changed.counts.changed, 2);
  assert.equal(changed.rows[0].newName, 'a-x.jpg');
});

test('buildPlan：正则编译不过 → 整个计划报错', () => {
  const out = buildPlan([{ path: 'D:/a.txt' }], { ...DEFAULT_RULES, find: '([', regex: true });
  assert.match(out.error, /正则/);
  assert.equal(out.rows.length, 0);
});

test('buildPlan：两个都变且撞到一起 → 都标 collision', () => {
  const files = [{ path: 'D:/x-a.txt' }, { path: 'D:/x-b.txt' }];
  const out = buildPlan(files, { ...DEFAULT_RULES, find: '-(a|b)$', replace: '-1', regex: true });
  assert.equal(out.counts.collision, 2);
});

test('buildPlan：目标在磁盘上存在（且不在批次内）→ collision', () => {
  const files = [{ path: 'D:/a.txt' }];
  const out = buildPlan(files, { ...DEFAULT_RULES, suffix: '-bak' }, { exists: () => true });
  assert.equal(out.counts.collision, 1);
  assert.match(out.rows[0].message, /已存在/);
});

test('buildPlan：目标是批次里另一个不改名的文件 → collision', () => {
  // a.txt → b.txt，而 b.txt 自己不改名：它一直占着这个名。
  const files = [{ path: 'D:/a.txt' }, { path: 'D:/b.txt' }];
  const out = buildPlan(files, { ...DEFAULT_RULES, find: 'a', replace: 'b' }, { exists: () => true });
  assert.equal(out.rows[0].status, 'collision');
  assert.match(out.rows[0].message, /占着这个名/);
  assert.equal(out.rows[1].status, 'unchanged');
});

test('buildPlan：撞车判定大小写不敏感（Windows 语义）', () => {
  const files = [{ path: 'D:/dir/A.txt' }, { path: 'D:/dir/B.txt' }];
  // A → b（B 自己不改名，一直占着这个名）
  const out = buildPlan(files, { ...DEFAULT_RULES, find: 'a', replace: 'b', ignoreCase: true });
  assert.equal(out.counts.collision, 1);
  assert.equal(out.rows[0].status, 'collision');
  assert.equal(out.rows[1].status, 'unchanged');
});

test('buildPlan：编号只给变化行用同一份 index 顺序', () => {
  const files = [{ path: 'D:/one.txt' }, { path: 'D:/two.txt' }, { path: 'D:/three.txt' }];
  const out = buildPlan(files, { ...DEFAULT_RULES, numbering: { enabled: true, start: 1, width: 1, position: 'prefix', separator: '-' } });
  assert.deepEqual(out.rows.map((r) => r.newName), ['1-one.txt', '2-two.txt', '3-three.txt']);
});

test('buildPlan：「重新命名为」模板不带编号 → 两行同名 → collision', () => {
  const files = [{ path: 'D:/one.txt' }, { path: 'D:/two.txt' }];
  const out = buildPlan(files, { ...DEFAULT_RULES, mode: 'rename', renameTo: '固定名字' });
  assert.equal(out.counts.collision, 2);
});

test('buildPlan：「重新命名为」模板 + 编号 → 依次编号', () => {
  const files = [{ path: 'D:/one.txt' }, { path: 'D:/two.txt' }];
  const out = buildPlan(files, { ...DEFAULT_RULES, mode: 'rename', renameTo: '照片', numbering: { enabled: true, start: 1, width: 3, position: 'suffix', separator: '-' } });
  assert.deepEqual(out.rows.map((r) => r.newName), ['照片-001.txt', '照片-002.txt']);
  assert.equal(out.counts.changed, 2);
});

test('buildPlan：「重新命名为」模板留空 → 两行都不改', () => {
  const files = [{ path: 'D:/one.txt' }, { path: 'D:/two.txt' }];
  const out = buildPlan(files, { ...DEFAULT_RULES, mode: 'rename', numbering: { enabled: true, start: 1, width: 2, position: 'prefix', separator: '-' } });
  assert.equal(out.counts.unchanged, 2);
  assert.equal(out.counts.changed, 0);
});

// ---------------------------------------------------------------- 执行（磁盘）

test('applyRenames + undoRenames：交换文件名能成，撤得回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-rename-'));
  try {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFile(a, 'aaa');
    await writeFile(b, 'bbb');
    const out = await applyRenames([
      { path: a, dir, newName: 'b.txt' },
      { path: b, dir, newName: 'a.txt' },
    ]);
    assert.equal(out.ok, true);
    assert.equal((await readFile(a, 'utf8')), 'bbb');
    assert.equal((await readFile(b, 'utf8')), 'aaa');

    const back = await undoRenames(out.done);
    assert.equal(back.undone, 2);
    assert.equal(back.remaining.length, 0);
    assert.equal((await readFile(a, 'utf8')), 'aaa');
    assert.equal((await readFile(b, 'utf8')), 'bbb');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('applyRenames：源文件不存在 → 失败，且磁盘原样', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-rename-'));
  try {
    const real = join(dir, 'real.txt');
    await writeFile(real, 'x');
    const out = await applyRenames([
      { path: join(dir, 'real.txt'), dir, newName: 'renamed.txt' },
      { path: join(dir, 'ghost.txt'), dir, newName: 'ghost2.txt' },
    ]);
    assert.equal(out.ok, false);
    assert.equal(out.unrestored.length, 0); // 都回滚了
    // 第一阶段在第二个文件上失败之前，real 已被改成临时名——回滚要把它改回来。
    assert.equal(await readFile(join(dir, 'real.txt'), 'utf8'), 'x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('undoRenames：目标不在了 → 跳过且不进 remaining', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-rename-'));
  try {
    const out = await undoRenames([{ from: join(dir, 'a'), to: join(dir, 'b') }]);
    assert.equal(out.undone, 0);
    assert.equal(out.remaining.length, 0);
    assert.equal(out.skipped.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('undoRenames：from 被占用 → 跳过并留着（以后还能再撤）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-rename-'));
  try {
    const from = join(dir, 'a.txt');
    const to = join(dir, 'b.txt');
    await writeFile(from, 'x');
    await writeFile(to, 'y');
    const out = await undoRenames([{ from, to }]);
    assert.equal(out.undone, 0);
    assert.equal(out.remaining.length, 1);
    assert.match(out.skipped[0].reason, /占/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 记录

test('store：写→读→清 一轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-rename-'));
  try {
    const entries = [{ from: join(dir, 'a'), to: join(dir, 'b') }];
    await writeUndo(dir, entries);
    assert.deepEqual(await readUndo(dir), entries);
    await clearUndo(dir);
    assert.deepEqual(await readUndo(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：坏文件读成空记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batch-rename-'));
  try {
    await writeFile(join(dir, 'batch-rename-undo.json'), '不是JSON{{{', 'utf8');
    assert.deepEqual(await readUndo(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
