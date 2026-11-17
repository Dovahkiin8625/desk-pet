// 视频形象（type: 'video'）：清单解析、校验、导入。
//
// 视频形象 = avatar.json + 被引用到的视频文件。
// 缺失的视频条目不该让整个形象导不进去，但用户必须看得见缺了什么；
// 没有一条可用视频才算失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scanModelDirs,
  importModelDir,
  readMergedRegistry,
} from '../../src/main/live2dModels.js';
import { normalizeVideoList, deriveVideoMotions } from '../../src/shared/video.js';

/** 摆一个够用的内置注册表目录（根目录里要有 assets/models/index.json）。 */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-video-root-'));
  const dir = join(root, 'assets', 'models');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.json'), JSON.stringify({ models: [] }, null, 2));
  return root;
}

/** 摆一个视频形象目录：avatar.json + 若干假视频。 */
async function makeVideoAvatarDir(avatar, files = ['videos/idle.webm']) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-video-'));
  await mkdir(join(dir, 'videos'), { recursive: true });
  for (const f of files) {
    await writeFile(join(dir, f), Buffer.from([0x1a, 0x45, 0xdf, 0xa3])); // webm 魔数
  }
  await writeFile(join(dir, 'avatar.json'), JSON.stringify(avatar, null, 2));
  return dir;
}

const BASE_AVATAR = {
  type: 'video',
  viewport: { width: 300, height: 560 },
  fit: { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] },
  videos: [
    { key: 'idle', file: 'videos/idle.webm', label: '待机', loop: true, semantic: 'idle' },
  ],
};

test('normalizeVideoList：保留合法的、剔除重复 key 的', () => {
  const { videos } = normalizeVideoList([
    { key: 'idle', file: 'a.webm', semantic: 'idle' },
    { key: 'idle', file: 'b.webm' },
    { key: '', file: 'c.webm' },
    '垃圾条目',
  ]);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].file, 'a.webm');
});

test('normalizeVideoList：情绪/表情语义键也被接受', () => {
  const { videos } = normalizeVideoList([
    { key: 'a', file: 'a.webm', semantic: 'smile' },
    { key: 'b', file: 'b.webm', semantic: 'angry' },
    { key: 'c', file: 'c.webm', semantic: 'happy' },
    { key: 'd', file: 'd.webm', semantic: 'dance' },
  ]);
  assert.equal(videos[0].semantic, 'smile');
  assert.equal(videos[1].semantic, 'angry');
  assert.equal(videos[2].semantic, 'happy');
  assert.equal(videos[3].semantic, undefined);
});

test('normalizeVideoList：idle 允许多条（待机池），其余语义键只绑第一个', () => {
  const { videos } = normalizeVideoList([
    { key: 'idle-1', file: 'a.webm', semantic: 'idle' },
    { key: 'idle-2', file: 'b.webm', semantic: 'idle' },
    { key: 'idle-3', file: 'c.webm', semantic: 'idle' },
    { key: 'other-1', file: 'd.webm', semantic: 'tapHead' },
    { key: 'other-2', file: 'e.webm', semantic: 'tapHead' },
  ]);
  assert.deepEqual(videos.filter((v) => v.semantic === 'idle').map((v) => v.key), ['idle-1', 'idle-2', 'idle-3']);
  assert.equal(videos[3].semantic, 'tapHead');
  assert.equal(videos[4].semantic, undefined);
});

test('normalizeVideoList：同一语义只绑第一个，其余退回菜单', () => {
  const { videos } = normalizeVideoList([
    { key: 'a', file: 'a.webm', semantic: 'tapHead' },
    { key: 'b', file: 'b.webm', semantic: 'tapHead' },
    { key: 'c', file: 'c.webm', semantic: 'swing' },
  ]);
  assert.equal(videos[0].semantic, 'tapHead');
  assert.equal(videos[1].semantic, undefined);
  // 应用不认的语义键直接丢弃（菜单仍可见）。
  assert.equal(videos[2].semantic, undefined);
});

test('deriveVideoMotions：语义键映射到 group，菜单组名用 key；idle 多条时第一个赢', () => {
  const { motions, motionGroups, motionNames } = deriveVideoMotions([
    { key: 'idle-1', file: 'a.webm', label: '待机', semantic: 'idle' },
    { key: 'idle-2', file: 'b.webm', label: '待机2', semantic: 'idle' },
    { key: 'laugh', file: 'c.webm', label: '大笑' },
  ]);
  assert.deepEqual(motions, { idle: { group: 'idle-1', index: 0 } });
  assert.deepEqual(motionGroups, { 'idle-1': 1, 'idle-2': 1, laugh: 1 });
  assert.deepEqual(motionNames.laugh, ['大笑']);
});

test('视频目录被识别为视频形象', async () => {
  const dir = await makeVideoAvatarDir(BASE_AVATAR);
  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'single');
  await rm(dir, { recursive: true, force: true });
});

test('avatar.json 的 type 不是 video：给出可读的原因', async () => {
  const dir = await makeVideoAvatarDir({ ...BASE_AVATAR, type: 'live2d' });
  const scan = await scanModelDirs(dir);
  assert.equal(scan.mode, 'foreign');
  assert.match(scan.foreignDirs[0].reason, /type/);
  await rm(dir, { recursive: true, force: true });
});

test('导入：缺失的视频被跳过并报警告，其余照常导入', async () => {
  const dir = await makeVideoAvatarDir(
    {
      ...BASE_AVATAR,
      videos: [
        { key: 'idle', file: 'videos/idle.webm', label: '待机', loop: true, semantic: 'idle' },
        { key: 'laugh', file: 'videos/laugh.webm', label: '大笑' },
        { key: 'todo', file: null, label: '还没做' },
      ],
    },
    ['videos/idle.webm'],
  );
  const root = await makeRoot();
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-video-ud-'));

  const model = await importModelDir({ sourceDir: dir, rootDir: root, userDataDir: userData });
  assert.equal(model.type, 'video');
  assert.ok(model.warnings.some((w) => w.includes('大笑')));
  assert.ok(model.warnings.some((w) => w.includes('还没做')));

  const modelDir = join(userData, 'models', model.id);
  const files = await readdir(modelDir);
  assert.deepEqual(files.sort(), ['avatar.json', 'videos']);

  const pet = JSON.parse(await readFile(join(modelDir, 'avatar.json'), 'utf8'));
  assert.equal(pet.type, 'video');
  assert.deepEqual(
    pet.videos.map((v) => v.key),
    ['idle'],
  );
  // 被跳过的视频没有拷进来。
  const registry = await readMergedRegistry(root, userData);
  assert.equal(registry.length, 1);
  assert.equal(registry[0].type, 'video');
  assert.equal(registry[0].manifest, `${model.id}/avatar.json`);

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('导入：一条可用视频都没有 → 失败且不写注册表', async () => {
  const dir = await makeVideoAvatarDir(
    {
      ...BASE_AVATAR,
      videos: [{ key: 'todo', file: null, label: '还没做' }],
    },
    [],
  );
  const root = await makeRoot();
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-video-ud-'));

  await assert.rejects(
    importModelDir({ sourceDir: dir, rootDir: root, userDataDir: userData }),
    /没有任何可用的视频/,
  );
  const registry = await readMergedRegistry(root, userData);
  assert.equal(registry.length, 0);

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});

test('导入：越出目录的路径被拒绝（不外泄文件）', async () => {
  const dir = await makeVideoAvatarDir(
    {
      ...BASE_AVATAR,
      videos: [{ key: 'evil', file: '../outside.webm', label: '越界' }],
    },
    [],
  );
  const root = await makeRoot();
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-video-ud-'));

  await assert.rejects(
    importModelDir({ sourceDir: dir, rootDir: root, userDataDir: userData }),
    /没有任何可用的视频/,
  );

  await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
});
