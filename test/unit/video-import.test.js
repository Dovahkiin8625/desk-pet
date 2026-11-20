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
import {
  normalizeClipList,
  deriveVideoMotions,
  buildClipSection,
  sanitizeReportedClips,
} from '../../src/shared/video.js';

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
  clips: [
    { id: 'idle', file: 'videos/idle.webm', label: '待机', category: 'idle', loop: true, semantic: 'idle' },
  ],
};

test('normalizeClipList：保留合法的、剔除重复 id 的', () => {
  const { clips } = normalizeClipList([
    { id: 'idle', file: 'a.webm', semantic: 'idle' },
    { id: 'idle', file: 'b.webm' },
    { id: '', file: 'c.webm' },
    '垃圾条目',
  ]);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].file, 'a.webm');
});

test('normalizeClipList：情绪类的 semantic 键（应用不认）被丢弃，条目退回点播可见', () => {
  const { clips } = normalizeClipList([
    { id: 'a', file: 'a.webm', semantic: 'smile' },
    { id: 'b', file: 'b.webm', semantic: 'angry' },
    { id: 'c', file: 'c.webm', semantic: 'happy' },
    { id: 'd', file: 'd.webm', semantic: 'dance' },
  ]);
  assert.equal(clips[0].semantic, undefined);
  assert.equal(clips[1].semantic, undefined);
  assert.equal(clips[2].semantic, undefined);
  assert.equal(clips[3].semantic, undefined);
});

test('normalizeClipList：idle 允许多条（待机池），其余语义键只绑第一个', () => {
  const { clips } = normalizeClipList([
    { id: 'idle-1', file: 'a.webm', semantic: 'idle' },
    { id: 'idle-2', file: 'b.webm', semantic: 'idle' },
    { id: 'idle-3', file: 'c.webm', semantic: 'idle' },
    { id: 'other-1', file: 'd.webm', semantic: 'tapHead' },
    { id: 'other-2', file: 'e.webm', semantic: 'tapHead' },
  ]);
  assert.deepEqual(clips.filter((c) => c.semantic === 'idle').map((c) => c.id), ['idle-1', 'idle-2', 'idle-3']);
  assert.equal(clips[3].semantic, 'tapHead');
  assert.equal(clips[4].semantic, undefined);
});

test('normalizeClipList：同一语义只绑第一个，其余退回待机池外可见', () => {
  const { clips } = normalizeClipList([
    { id: 'a', file: 'a.webm', semantic: 'tapHead' },
    { id: 'b', file: 'b.webm', semantic: 'tapHead' },
    { id: 'c', file: 'c.webm', semantic: 'swing' },
  ]);
  assert.equal(clips[0].semantic, 'tapHead');
  assert.equal(clips[1].semantic, undefined);
  // 应用不认的语义键直接丢弃（菜单仍可见）。
  assert.equal(clips[2].semantic, undefined);
});

test('normalizeClipList：分类保留非空字符串（支持文件夹分类），缺省为空串', () => {
  const { clips } = normalizeClipList([
    { id: 'a', file: 'a.webm', category: '待机与呼吸' },
    { id: 'b', file: 'b.webm', category: '开心与喜悦' },
    { id: 'c', file: 'c.webm', category: 'action' },
    { id: 'd', file: 'd.webm', category: 'special' },
    { id: 'e', file: 'e.webm', category: 'bogus' },
    { id: 'f', file: 'f.webm' },
  ]);
  assert.deepEqual(clips.map((c) => c.category), ['待机与呼吸', '开心与喜悦', 'action', 'special', 'bogus', '']);
});

test('deriveVideoMotions：语义键映射到 group，菜单组名用 id；idle 多条时第一个赢', () => {
  const { motions, motionGroups, motionNames } = deriveVideoMotions([
    { id: 'idle-1', file: 'a.webm', label: '待机', semantic: 'idle' },
    { id: 'idle-2', file: 'b.webm', label: '待机2', semantic: 'idle' },
    { id: 'laugh', file: 'c.webm', label: '大笑' },
  ]);
  assert.deepEqual(motions, { idle: { group: 'idle-1', index: 0 } });
  assert.deepEqual(motionGroups, { 'idle-1': 1, 'idle-2': 1, laugh: 1 });
  assert.deepEqual(motionNames.laugh, ['大笑']);
});

test('buildClipSection：按分类分组列出 id 与 label（按文件夹分类顺序）', () => {
  const section = buildClipSection([
    { id: 'laugh', label: '开怀大笑', category: '开心与喜悦' },
    { id: 'idle-1', label: '待机（呼吸）', category: '待机与呼吸', semantic: 'idle' },
    { id: 'greet', label: '挥手打招呼', category: '问候与礼仪' },
  ]);
  assert.match(section, /你能做出的动作/);
  assert.match(section, /<id>/);
  assert.match(section, /待机与呼吸：idle-1=待机（呼吸）/);
  assert.match(section, /开心与喜悦：laugh=开怀大笑/);
  assert.match(section, /问候与礼仪：greet=挥手打招呼/);
  // 已知文件夹分类按目录顺序输出
  assert.ok(section.indexOf('待机与呼吸：') < section.indexOf('开心与喜悦：'));
  assert.ok(section.indexOf('开心与喜悦：') < section.indexOf('问候与礼仪：'));
});

test('buildClipSection：空清单返回空串', () => {
  assert.equal(buildClipSection([]), '');
  assert.equal(buildClipSection(null), '');
});

test('sanitizeReportedClips：去重、限长、分类与语义校验', () => {
  const out = sanitizeReportedClips([
    { id: ' a ', label: ' 待机 ', category: 'idle', semantic: 'idle', loop: true },
    { id: 'a', label: '重复', category: 'action' },
    { id: 'x', label: 'q', category: 'bogus', semantic: 'happy' },
    '垃圾',
    { id: '', label: '空 id' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[0].label, '待机');
  assert.equal(out[0].semantic, 'idle');
  assert.equal(out[0].loop, true);
  // 非空分类原样保留，应用不认的语义（含情绪键）丢弃。
  assert.equal(out[1].category, 'bogus');
  assert.equal(out[1].semantic, '');
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
      clips: [
        { id: 'idle', file: 'videos/idle.webm', label: '待机', category: 'idle', loop: true, semantic: 'idle' },
        { id: 'laugh', file: 'videos/laugh.webm', label: '大笑', category: 'emotion' },
        { id: 'todo', file: null, label: '还没做', category: 'action' },
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
    pet.clips.map((c) => c.id),
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
      clips: [{ id: 'todo', file: null, label: '还没做', category: 'action' }],
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
      clips: [{ id: 'evil', file: '../outside.webm', label: '越界', category: 'action' }],
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
