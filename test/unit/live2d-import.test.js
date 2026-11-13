// 导入模型时的「挑设置文件」与「校验」规则。
//
// 这些规则决定了一个模型目录能不能导进来、导进来之后能不能加载：
// 挑错设置文件（游戏自带的样例设置文件）会指向不存在的文件，
// 模型文件不是 moc（被加密或损坏）会加载不出来，
// Unity AssetBundle 导出的模型根本不是 Cubism 模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findModelSettingsFile,
  inspectModelDir,
  importModelDir,
  scanModelDirs,
} from '../../src/main/live2dModels.js';

/** 摆一个假的内置注册表目录（assets/live2d/index.json 的位置）。 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-import-root-'));
  const dir = join(root, 'assets', 'live2d');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify({ models: [] }, null, 2));
  return root;
}

/** 一个够用的 Cubism 4 moc3 头。 */
const MOC3 = Buffer.concat([Buffer.from('MOC3'), Buffer.from([5, 0, 0, 0])]);
/** 一个够用的 Cubism 2 moc 头。 */
const MOC2 = Buffer.concat([Buffer.from('moc'), Buffer.from([0x0b])]);
/** 一个够用的 PNG 头（只验字节头，不解码）。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]);

test('多个设置文件时，选引用文件真的存在的那一个', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  // 游戏自带的样例设置文件：内容像设置文件，指向的文件却不在。
  await writeFile(
    join(dir, 'expressions_0_file_0.json'),
    JSON.stringify({
      version: 'Sample 1.0.0',
      model: 'character.dat',
      textures: ['texture_00.png'],
    }),
  );
  // 模型自己的设置文件。
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ type: 0, model: 'model_0.moc', textures: ['textures_0_0.png'] }),
  );
  await writeFile(join(dir, 'model_0.moc'), MOC2);
  await writeFile(join(dir, 'textures_0_0.png'), PNG);

  const found = await findModelSettingsFile(dir);
  assert.equal(found.file, 'model0.json');
  assert.equal(found.version, 2);

  await rm(dir, { recursive: true, force: true });
});

test('非 Cubism 的游戏格式（Spine）被认出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ conf_ver: 1, type: 9, skeleton: 'skeleton_0', atlases: ['atlases_0_atlas_0'] }),
  );
  await writeFile(join(dir, 'skeleton_0.json'), JSON.stringify({ skeleton: { spine: '4.0' } }));

  const found = await findModelSettingsFile(dir);
  assert.equal(found.foreign, true);
  assert.equal(found.file, 'model0.json');
  assert.match(found.reason, /Spine/);

  await rm(dir, { recursive: true, force: true });
});

test('模型文件不是 moc 时，校验报出「损坏或被加密」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ Version: 3, FileReferences: { Moc: 'Moc_0', Textures: ['Textures_0_0.png'] } }),
  );
  await writeFile(join(dir, 'Moc_0'), Buffer.alloc(64, 0x5a));
  await writeFile(join(dir, 'Textures_0_0.png'), PNG);

  const check = await inspectModelDir(dir, 'model0.json');
  assert.equal(check.ok, false);
  assert.match(check.errors.join('\n'), /不是有效的 moc/);

  await rm(dir, { recursive: true, force: true });
});

test('资源整体被加密时，说清是加密而不是「文件损坏」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ Version: 3, FileReferences: { Moc: 'Moc_0', Textures: ['Textures_0_0'] } }),
  );
  // moc 与纹理都是随机字节：解包工具没能解密。
  await writeFile(join(dir, 'Moc_0'), Buffer.alloc(64, 0x5a));
  await writeFile(join(dir, 'Textures_0_0'), Buffer.alloc(64, 0x5a));

  const check = await inspectModelDir(dir, 'model0.json');
  assert.equal(check.ok, false);
  assert.match(check.errors.join('\n'), /加密/);

  await rm(dir, { recursive: true, force: true });
});

test('导入非 Cubism 模型时给出说得清的原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ conf_ver: 1, type: 9, skeleton: 'skeleton_0', atlases: ['atlases_0_atlas_0'] }),
  );
  await writeFile(join(dir, 'skeleton_0.json'), JSON.stringify({ skeleton: { spine: '4.0' } }));
  const root = await makeRoot();
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-import-ud-'));

  await assert.rejects(
    () => importModelDir({ sourceDir: dir, rootDir: root, userDataDir: userData }),
    /不是 Cubism 模型/,
  );

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('导入时清掉设置文件里的空纹理引用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  // 游戏的资源清单末尾留了一个空条目：照着加载会得到一个空文件名。
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'Moc_0.moc3', Textures: ['Textures_0_0.png', ''] },
    }),
  );
  await writeFile(join(dir, 'Moc_0.moc3'), MOC3);
  await writeFile(join(dir, 'Textures_0_0.png'), PNG);

  const root = await makeRoot();
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-import-ud-'));
  const model = await importModelDir({ sourceDir: dir, rootDir: root, userDataDir: userData });

  const settings = JSON.parse(
    await readFile(join(userData, 'live2d', 'models', model.id, 'model0.json'), 'utf8'),
  );
  assert.deepEqual(settings.FileReferences.Textures, ['Textures_0_0.png']);

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

/** 摆一个能导入的 Cubism 4 模型目录。 */
async function makeCubism4Model(dir, name = 'model0.json') {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, name),
    JSON.stringify({ Version: 3, FileReferences: { Moc: 'Moc_0.moc3', Textures: ['Textures_0_0.png'] } }),
  );
  await writeFile(join(dir, 'Moc_0.moc3'), MOC3);
  await writeFile(join(dir, 'Textures_0_0.png'), PNG);
}

test('选中的目录自己就是模型时，按单个模型处理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await makeCubism4Model(dir);

  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'single');
  assert.deepEqual(scan.dirs, [dir]);

  await rm(dir, { recursive: true, force: true });
});

test('选中的目录装着若干个模型时，逐个列出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await makeCubism4Model(join(dir, 'a'));
  await makeCubism4Model(join(dir, 'b'));
  // 不是模型的目录要略过。
  await mkdir(join(dir, 'notes'), { recursive: true });

  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'batch');
  assert.equal(scan.dirs.length, 2);
  assert.deepEqual(scan.dirs.map((d) => d.split(/[\\/]/).pop()).sort(), ['a', 'b']);

  await rm(dir, { recursive: true, force: true });
});

test('目录里没有模型时，说清是「没有」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(join(dir, 'readme.txt'), 'hi');

  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'none');

  await rm(dir, { recursive: true, force: true });
});

test('目录里只有非 Cubism 模型时，说清是「不是 Cubism」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ conf_ver: 1, type: 9, skeleton: 'skeleton_0', atlases: ['atlases_0_atlas_0'] }),
  );
  await writeFile(join(dir, 'skeleton_0.json'), JSON.stringify({ skeleton: { spine: '4.0' } }));

  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'foreign');
  assert.match(scan.foreignDirs[0].reason, /Spine/);

  await rm(dir, { recursive: true, force: true });
});

test('骨骼是二进制 Spine 时，也认得出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ conf_ver: 1, type: 9, skeleton: 'skeleton_0', atlases: ['atlases_0_atlas_0'] }),
  );
  // 解包出来的骨骼常常没有扩展名，且是二进制（文件头里带着 Spine 版本号）。
  await writeFile(join(dir, 'skeleton_0'), Buffer.concat([Buffer.from('x7f0a1b'), Buffer.from('4.1.24'), Buffer.alloc(16)]));

  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'foreign');
  assert.match(scan.foreignDirs[0].reason, /Spine/);

  await rm(dir, { recursive: true, force: true });
});
