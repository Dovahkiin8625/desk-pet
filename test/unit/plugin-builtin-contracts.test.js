import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateManifest, resolveWindowSpec, PLUGIN_WINDOW_MODE } from '../../src/shared/plugin.js';
import { createPluginHost } from '../../src/main/plugins/host.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';

/**
 * 内置插件与 agent 的对接。
 *
 * 每个内置插件都要：
 * - 有一份技能说明（skill.md + 清单里的 skill 段）；
 * - 清单里声明的工具与实例里实现的**同名**（宿主才会注册它）。
 *
 * 这份测试对着真实的 `plugins/` 目录跑——
 * 少一个技能、少一个实现，模型就少一项能力。
 */

const ROOT = process.cwd();
const PLUGINS_DIR = join(ROOT, 'plugins');
const IDS = ['pomodoro', 'todos', 'reminders', 'system', 'weather'];
/** 全部内置插件（窗口尺寸那条要对着每一个查）。 */
const ALL_IDS = [
  'chat-history', 'clipboard', 'music-player', 'pomodoro', 'reminders',
  'screen-recorder', 'system', 'tasks', 'todos', 'weather',
];

test('内置插件：清单都合法', async () => {
  for (const id of IDS) {
    const raw = JSON.parse(await readFile(join(PLUGINS_DIR, id, 'plugin.json'), 'utf8'));
    const out = validateManifest(raw);
    assert.ok(out.ok, `插件「${id}」的清单不合法：${out.errors.join('；')}`);
    assert.equal(out.value.id, id);
    assert.deepEqual(out.value.toolErrors, [], `插件「${id}」的工具声明有毛病`);
    assert.deepEqual(out.value.skillErrors, [], `插件「${id}」的技能声明有毛病`);
    assert.deepEqual(out.value.settingErrors, [], `插件「${id}」的配置项声明有毛病`);
  }
});

test('内置插件：都有技能说明', async () => {
  for (const id of IDS) {
    const raw = JSON.parse(await readFile(join(PLUGINS_DIR, id, 'plugin.json'), 'utf8'));
    assert.ok(raw.skill, `插件「${id}」没有技能说明`);
    const body = await readFile(join(PLUGINS_DIR, id, raw.skill.file), 'utf8');
    assert.ok(body.trim().length > 0, `插件「${id}」的技能正文是空的`);
  }
});

test('内置插件：声明的工具都注册上了', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-builtin-'));
  try {
    const registry = createToolRegistry();
    const host = await createPluginHost({
      rootDir: ROOT,
      userDataDir: userData,
      assistant: {},
      toolRegistry: registry,
    });
    await host.load();
    for (const id of IDS) {
      const record = host.get(id);
      assert.ok(record, `插件「${id}」没加载上`);
      const declared = record.manifest.tools.map((t) => t.name);
      assert.ok(declared.length > 0, `插件「${id}」没有给 agent 提供工具`);
      for (const name of declared) {
        assert.ok(registry.get(name), `插件「${id}」的工具「${name}」没注册上`);
      }
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('内置插件：独立窗口都是宽版（宽度 ≥ 620，内容区才够 560）', async () => {
  for (const id of ALL_IDS) {
    const raw = JSON.parse(await readFile(join(PLUGINS_DIR, id, 'plugin.json'), 'utf8'));
    const spec = resolveWindowSpec(raw, PLUGIN_WINDOW_MODE.WINDOW);
    assert.ok(spec.width >= 620, `插件「${id}」的窗口宽度 ${spec.width} 不够宽`);
    assert.ok(spec.height >= 480, `插件「${id}」的窗口高度 ${spec.height} 不够高`);
  }
});
