// 导入 Spine 骨骼动画模型：挑变体、认图集、整理文件名。
//
// 游戏的 Spine 资源不是 Spine 的标准布局（图集叫 atlases_0_atlas_1、
// 页面叫 cutscene_char004192.png、纹理叫 atlases_0_textures_0_1.png），
// 导入时要整理成标准布局，运行时才认得。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findModelSettingsFile,
  importModelDir,
  scanModelDirs,
} from '../../src/main/live2dModels.js';
import { parseAtlasPages, findSpineVariant } from '../../src/main/spineModels.js';

/** 一个够用的 PNG 头（导入只搬文件，不解码）。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]);

/** Spine 4.1 二进制骨架的头：8 字节哈希 + 版本串。 */
function spineBinary(version = '4.1.20', size = 4096) {
  const head = Buffer.alloc(9);
  head[8] = version.length;
  return Buffer.concat([head, Buffer.from(version), Buffer.alloc(size)]);
}

/** 摆一个假的内置注册表目录（assets/models/index.json 的位置）。 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-spine-root-'));
  const dir = join(root, 'assets', 'models');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify({ models: [] }, null, 2));
  return root;
}

/** 摆一个游戏的 Spine 目录：两份配置（本体 + 占位骨架）。 */
async function makeSpineGameDir() {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-spine-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({
      conf_ver: 1,
      type: 9,
      skeleton: 'skeleton_0',
      atlases: [
        {
          atlas: 'atlases_0_atlas_0',
          tex_names: ['cutscene_char0', 'cutscene_char0_2'],
          textures: ['atlases_0_textures_0_0.png', 'atlases_0_textures_1_0.png'],
        },
      ],
    }),
  );
  // 占位骨架：只有一根骨头、几百字节——那是游戏用来占位的。
  await writeFile(
    join(dir, 'model1.json'),
    JSON.stringify({
      conf_ver: 1,
      type: 9,
      skeleton: 'skeleton_1',
      atlases: [
        {
          atlas: 'atlases_0_atlas_1',
          tex_names: ['placeholder'],
          textures: ['atlases_0_textures_0_1.png'],
        },
      ],
    }),
  );
  await writeFile(join(dir, 'skeleton_0'), spineBinary('4.1.20', 4096));
  await writeFile(join(dir, 'skeleton_1'), spineBinary('4.1.20', 32));
  await writeFile(
    join(dir, 'atlases_0_atlas_0'),
    [
      'cutscene_char0.png',
      'size: 1024, 1024',
      'format: RGBA8888',
      'filter: Linear,Linear',
      'repeat: none',
      'A_arm',
      '  bounds: 1, 2, 30, 40',
      '  rotate: false',
      '',
      'cutscene_char0_2.png',
      'size: 1024, 1024',
      'format: RGBA8888',
      'filter: Linear,Linear',
      'repeat: none',
      'B_leg',
      '  bounds: 3, 4, 50, 60',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'atlases_0_atlas_1'),
    ['placeholder.png', 'size: 64, 64', 'A_x', '  bounds: 0, 0, 8, 8', ''].join('\n'),
  );
  await writeFile(join(dir, 'atlases_0_textures_0_0.png'), PNG);
  await writeFile(join(dir, 'atlases_0_textures_1_0.png'), PNG);
  await writeFile(join(dir, 'atlases_0_textures_0_1.png'), PNG);
  return dir;
}

test('图集解析：认出每一页的页名', () => {
  const pages = parseAtlasPages(
    [
      'a.png',
      'size: 100, 100',
      'filter: Linear,Linear',
      'region1',
      '  bounds: 1, 2, 3, 4',
      '',
      'b.png',
      'size: 200, 200',
      'region2',
      '  bounds: 5, 6, 7, 8',
      '',
    ].join('\n'),
  );
  assert.deepEqual(pages.map((p) => p.name), ['a.png', 'b.png']);
});

test('图集解析：页字段写在页名之前也认得', () => {
  const pages = parseAtlasPages(['size: 100, 100', 'a.png', 'region1', '  bounds: 1, 2, 3, 4', ''].join('\n'));
  assert.deepEqual(pages.map((p) => p.name), ['a.png']);
});

test('挑变体：本体骨架赢过占位骨架', async () => {
  const dir = await makeSpineGameDir();
  const variant = await findSpineVariant(dir);
  assert.equal(variant.configFile, 'model0.json');
  assert.equal(variant.skeleton.name, 'skeleton_0');
  assert.equal(variant.atlas.pages.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('Spine 目录被当成模型，而不是「非 Cubism 格式」', async () => {
  const dir = await makeSpineGameDir();
  const found = await findModelSettingsFile(dir);
  assert.equal(found.kind, 'spine');
  assert.equal(found.foreign, undefined);

  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'single');
  await rm(dir, { recursive: true, force: true });
});

test('导入 Spine 模型：文件被整理成标准布局', async () => {
  const dir = await makeSpineGameDir();
  const root = await makeRoot();
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-spine-ud-'));

  const model = await importModelDir({ sourceDir: dir, rootDir: root, userDataDir: userData });
  assert.equal(model.type, 'spine');

  const modelDir = join(userData, 'models', model.id);
  const files = await readdir(modelDir);
  assert.deepEqual(files.sort(), ['0.png', '1.png', 'model.atlas', 'model.skel', 'pet.json']);

  // 图集里的页名改成了整理后的纹理文件名。
  const atlas = await readFile(join(modelDir, 'model.atlas'), 'utf8');
  assert.match(atlas, /^0\.png$/m);
  assert.match(atlas, /^1\.png$/m);
  assert.doesNotMatch(atlas, /cutscene_char0\.png/);
  // 区域还在。
  assert.match(atlas, /A_arm/);

  // 清单点名骨架与图集。
  const pet = JSON.parse(await readFile(join(modelDir, 'pet.json'), 'utf8'));
  assert.equal(pet.type, 'spine');
  assert.equal(pet.spine.skeleton, 'model.skel');
  assert.equal(pet.spine.atlas, 'model.atlas');
  assert.equal(pet.spine.skeletonFormat, 'binary');
  assert.deepEqual(pet.spine.textures, ['0.png', '1.png']);

  // 注册表里有它。
  const registry = JSON.parse(
    await readFile(join(userData, 'models', 'registry.json'), 'utf8'),
  );
  assert.equal(registry.models.length, 1);
  assert.equal(registry.models[0].id, model.id);

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('骨架版本不是 4.1 时，仍然说清是「读不懂」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-spine-'));
  await writeFile(
    join(dir, 'model0.json'),
    JSON.stringify({
      conf_ver: 1,
      type: 9,
      skeleton: 'skeleton_0',
      atlases: [{ atlas: 'atlases_0_atlas_0', tex_names: ['a'], textures: ['t.png'] }],
    }),
  );
  // 3.8 的二进制骨架：哈希是字符串，版本号在后面。
  const hash = Buffer.from('somehash');
  await writeFile(
    join(dir, 'skeleton_0'),
    Buffer.concat([Buffer.from([hash.length]), hash, Buffer.from([6]), Buffer.from('3.8.75')]),
  );
  await writeFile(join(dir, 'atlases_0_atlas_0'), ['a.png', 'size: 1, 1', ''].join('\n'));
  await writeFile(join(dir, 't.png'), PNG);

  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'foreign');
  assert.match(scan.foreignDirs[0].reason, /Spine/);
  await rm(dir, { recursive: true, force: true });
});
