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
  await writeFile(join(dir, 'textures_0_0.png'), 'png');

  const found = await findModelSettingsFile(dir);
  assert.equal(found.file, 'model0.json');
  assert.equal(found.version, 2);

  await rm(dir, { recursive: true, force: true });
});

test('Unity AssetBundle 导出的模型被认出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ conf_ver: 1, type: 9, skeleton: 'skeleton_0', atlases: ['atlases_0_atlas_0'] }),
  );

  const found = await findModelSettingsFile(dir);
  assert.equal(found.unity, true);
  assert.equal(found.file, 'model0.json');

  await rm(dir, { recursive: true, force: true });
});

test('模型文件不是 moc 时，校验报出「损坏或被加密」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ Version: 3, FileReferences: { Moc: 'Moc_0', Textures: ['Textures_0_0.png'] } }),
  );
  await writeFile(join(dir, 'Moc_0'), Buffer.alloc(64, 0x5a));
  await writeFile(join(dir, 'Textures_0_0.png'), 'png');

  const check = await inspectModelDir(dir, 'model0.json');
  assert.equal(check.ok, false);
  assert.match(check.errors.join('\n'), /不是有效的 moc/);

  await rm(dir, { recursive: true, force: true });
});

test('导入 Unity 模型时给出说得清的原因', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-import-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({ conf_ver: 1, type: 9, skeleton: 'skeleton_0', atlases: ['atlases_0_atlas_0'] }),
  );
  const root = await makeRoot();
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-import-ud-'));

  await assert.rejects(
    () => importModelDir({ sourceDir: dir, rootDir: root, userDataDir: userData }),
    /Unity AssetBundle/,
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
  await writeFile(join(dir, 'Textures_0_0.png'), 'png');

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
