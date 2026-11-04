import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readMergedRegistry,
  readRemovedBundled,
  removeBundledModel,
} from '../../src/main/live2dModels.js';

/**
 * 形象注册表（内置 + 导入 + 「被移除的内置」）的合并规则。
 *
 * 这里只测合并这一层：真加载模型要 Electron 与 WebGL，
 * 那是 e2e 的事（test/e2e/preset-models.spec.js）。
 */

/** 摆一个假的内置注册表（assets/live2d/index.json 的位置）。 */
async function makeRoot(models) {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-registry-'));
  const dir = join(root, 'assets', 'live2d');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify({ models }, null, 2));
  return root;
}

/** 摆一份用户注册表（导入的模型）。 */
async function writeUserRegistry(userData, models) {
  const dir = join(userData, 'live2d');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'registry.json'), JSON.stringify({ version: 1, models }, null, 2));
}

const BUNDLED = [
  { id: 'haru', name: 'Haru', manifest: 'haru/pet.json', model3: 'Haru.model3.json' },
  { id: 'mao', name: 'Mao', manifest: 'mao/pet.json', model3: 'Mao.model3.json' },
];

test('合并注册表：内置 + 导入的都在', async () => {
  const root = await makeRoot(BUNDLED);
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-ud-'));
  await writeUserRegistry(userData, [
    { id: 'mine', name: '我的模型', model3: 'Mine.model3.json', manifest: 'mine/pet.json' },
  ]);

  const list = await readMergedRegistry(root, userData);
  assert.deepEqual(
    list.map((m) => m.id),
    ['haru', 'mao', 'mine'],
  );
  // 两边合成同一个形状：渲染层不必知道某个形象是哪来的。
  assert.equal(list[0].source, 'bundled');
  assert.equal(list[2].source, 'user');
  assert.equal(list[0].base, '/assets/live2d/models');
  assert.equal(list[2].base, '/__models__');

  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('移除一个内置形象后，它不再出现在列表里', async () => {
  const root = await makeRoot(BUNDLED);
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-ud-'));

  await removeBundledModel({ id: 'mao', userDataDir: userData });

  const list = await readMergedRegistry(root, userData);
  assert.deepEqual(
    list.map((m) => m.id),
    ['haru'],
  );
  // 清单本身记下来了：下次启动还是被移除的。
  assert.deepEqual([...(await readRemovedBundled(userData))], ['mao']);

  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('被移除的内置形象仍然占着 id：算 id 占用时要算进去', async () => {
  const root = await makeRoot(BUNDLED);
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-ud-'));
  await removeBundledModel({ id: 'mao', userDataDir: userData });

  // 展示用的列表里没有它……
  assert.deepEqual(
    (await readMergedRegistry(root, userData)).map((m) => m.id),
    ['haru'],
  );
  // ……但算 id 占用时它还在：用户导入一个叫 mao 的模型不能撞上同一个 id。
  assert.deepEqual(
    (await readMergedRegistry(root, userData, { includeRemoved: true })).map((m) => m.id),
    ['haru', 'mao'],
  );

  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('移除清单只影响内置形象，导入的不受影响', async () => {
  const root = await makeRoot(BUNDLED);
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-ud-'));
  await writeUserRegistry(userData, [
    { id: 'mao', name: '我的mao', model3: 'Mine.model3.json', manifest: 'mine/pet.json' },
  ]);

  await removeBundledModel({ id: 'mao', userDataDir: userData });

  const list = await readMergedRegistry(root, userData);
  // 内置的那个没了，用户自己导入的还在（它有独立的 id 与目录）。
  assert.deepEqual(
    list.map((m) => `${m.id}:${m.source}`),
    ['haru:bundled', 'mao:user'],
  );

  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('移除清单坏了也不影响启动：当作「没移除过」', async () => {
  const root = await makeRoot(BUNDLED);
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-ud-'));
  await mkdir(join(userData, 'live2d'), { recursive: true });
  await writeFile(join(userData, 'live2d', 'removed.json'), '{ 这不是 JSON');

  assert.deepEqual([...(await readRemovedBundled(userData))], []);
  assert.deepEqual(
    (await readMergedRegistry(root, userData)).map((m) => m.id),
    ['haru', 'mao'],
  );

  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});
