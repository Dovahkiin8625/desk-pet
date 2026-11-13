import test from 'node:test';
import assert from 'node:assert/strict';

import { createPluginOpenTool, resolvePlugin } from '../../src/main/plugins/tools.js';

/**
 * 「打开插件界面」这个工具。
 *
 * 盯的是三件事：
 * - 用户说的多半不是插件的 id（是名字、是顺口的话），所以要能找得到；
 * - 找不到时把现在能打开的插件列出来——模型自己就能改个名字再试；
 * - 开不出来（窗口开不了）要如实说，不能假装开成了。
 */

const PLUGINS = [
  { id: 'system', name: '系统状态', keywords: ['cpu', 'gpu', '内存'] },
  { id: 'music-player', name: '音乐播放器', keywords: ['音乐', '歌'] },
];

/** 造出这个工具（只有一个），并记录开过哪个。 */
function tool(overrides = {}) {
  const opened = [];
  const t = createPluginOpenTool({
    getPlugins: () => PLUGINS,
    openWindow: (id) => {
      opened.push(id);
      return { ok: true };
    },
    ...overrides,
  });
  return { t, opened };
}

test('打开插件：按名字找得到', () => {
  const found = resolvePlugin('系统状态', PLUGINS);
  assert.equal(found.id, 'system');
});

test('打开插件：按 id 也找得到', () => {
  assert.equal(resolvePlugin('music-player', PLUGINS).id, 'music-player');
});

test('打开插件：按关键词找得到', () => {
  assert.equal(resolvePlugin('cpu', PLUGINS).id, 'system');
  assert.equal(resolvePlugin('内存', PLUGINS).id, 'system');
});

test('打开插件：用户的话里带着关键词也找得到', () => {
  assert.equal(resolvePlugin('cpu监控', PLUGINS).id, 'system');
});

test('打开插件：找得到就把那个窗口开出来', async () => {
  const { t, opened } = tool();
  const out = await t.run({ name: '系统状态' }, {});
  assert.deepEqual(opened, ['system']);
  assert.match(out.text, /系统状态/);
  assert.equal(out.data.pluginId, 'system');
});

test('打开插件：风险是只读（开窗口不动用户的东西）', () => {
  assert.equal(tool().t.risk, 'read');
});

test('打开插件：找不到就把现在能打开的列出来', async () => {
  const { t, opened } = tool();
  await assert.rejects(
    () => t.run({ name: '不存在的插件' }, {}),
    /系统状态/
  );
  assert.deepEqual(opened, [], '找不到就不该开窗口');
});

test('打开插件：没给名字要问清楚', async () => {
  const { t } = tool();
  await assert.rejects(() => t.run({}, {}), /name/);
});

test('打开插件：窗口开不出来要如实说', async () => {
  const { t } = tool({
    openWindow: () => ({ ok: false, message: '窗口建不出来' }),
  });
  await assert.rejects(() => t.run({ name: '系统状态' }, {}), /窗口建不出来/);
});

test('打开插件：一个插件也没有时说得清楚', async () => {
  const { t } = tool({ getPlugins: () => [] });
  await assert.rejects(() => t.run({ name: '系统状态' }, {}), /一个也没有/);
});
