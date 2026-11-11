// 音乐插件的清单与 agent 对接。
//
// 对着真实的插件目录跑——
// 清单里的工具与实例里实现的**同名**，宿主才会注册它；
// 对不上的时候那个工具就悄悄没了，模型看不见也调不着。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateManifest } from '../../src/shared/plugin.js';
import { createTools } from '../../plugins/music-player/lib/tools.js';

const DIR = join(process.cwd(), 'plugins', 'music-player');

/** 读插件的清单。 */
async function readManifest() {
  return JSON.parse(await readFile(join(DIR, 'plugin.json'), 'utf8'));
}

/** 一个假的播放器：工具只用到这几个方法。 */
function fakePlayer(overrides = {}) {
  const state = {
    trackCount: 2,
    current: { title: '稻香', artist: '周杰伦' },
    playing: true,
    position: 12,
    duration: 200,
    volume: 0.8,
    mode: 'order',
    modeLabel: '顺序播放',
  };
  return {
    ensureStarted: async () => {},
    playMatch: async () => ({ ok: true, message: '在放《稻香》' }),
    pause: () => ({ ok: true, message: '暂停了' }),
    next: async () => ({ ok: true, message: '下一首' }),
    prev: async () => ({ ok: true, message: '上一首' }),
    search: () => [{ title: '稻香', artist: '周杰伦', file: 'C:/music/x.mp3' }],
    setLyrics: async () => ({ ok: true, message: '桌面歌词开了' }),
    snapshot: () => state,
    ...overrides,
  };
}

test('清单合法', async () => {
  const raw = await readManifest();
  const out = validateManifest(raw);
  assert.ok(out.ok, `清单不合法：${out.errors.join('；')}`);
  assert.equal(out.value.id, 'music-player');
  assert.deepEqual(out.value.toolErrors, [], '工具声明有毛病');
  assert.deepEqual(out.value.skillErrors, [], '技能声明有毛病');
  assert.deepEqual(out.value.settingErrors, [], '配置项声明有毛病');
});

test('有技能说明，正文不是空的', async () => {
  const raw = await readManifest();
  assert.ok(raw.skill, '没有技能说明');
  const body = await readFile(join(DIR, raw.skill.file), 'utf8');
  assert.ok(body.trim().length > 0, '技能正文是空的');
});

test('声明的工具都实现了，而且同名', async () => {
  const raw = await readManifest();
  const impls = createTools(fakePlayer());
  const implemented = impls.map((t) => t.name);
  assert.deepEqual(
    implemented.sort(),
    raw.tools.map((t) => t.name).sort(),
    '清单与实现对不上：那个工具就注册不上'
  );
});

test('工具出错要抛出去（模型才能换个参数再试）', async () => {
  const impls = createTools(fakePlayer());
  const play = impls.find((t) => t.name === 'music.play');
  const failing = createTools(
    fakePlayer({ playMatch: async () => ({ ok: false, message: '曲库里没有「不存在」' }) })
  );
  const bad = failing.find((t) => t.name === 'music.play');
  await assert.rejects(() => bad.run({ song: '不存在' }), /曲库里没有/);
  const ok = await play.run({ song: '稻香' });
  assert.ok(ok.text, '成功时要给模型一句话');
});

test('小部件与独立窗口的页面都在磁盘上', async () => {
  const raw = await readManifest();
  assert.ok(raw.widget, '没有小部件段');
  for (const page of [raw.window.page, raw.widget.page]) {
    const body = await readFile(join(DIR, page), 'utf8');
    assert.ok(body.includes('<html'), `页面「${page}」不是 HTML`);
  }
});
