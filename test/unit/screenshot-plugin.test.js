import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest } from '../../src/shared/plugin.js';
import { createPluginHost } from '../../src/main/plugins/host.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';
import { parseDesk } from '../../plugins/screenshot/lib/windows.js';
import { mergeAuto, dedupe } from '../../plugins/screenshot/lib/ocr.js';

/**
 * 截图插件。
 *
 * 覆盖三块：
 *
 * 1. **清单**：合法、目录名与 id 一致、页面在磁盘上；
 * 2. **接在宿主上**：插件能加载、给 agent 的工具都注册上了；
 * 3. **纯逻辑**：窗口清单怎么读、两个 OCR 引擎的结果怎么合。
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'screenshot');

/** 把插件复制到临时目录（宿主只认自己根目录下的 plugins/）。 */
async function copyPlugin(root) {
  const dir = join(root, 'plugins', 'screenshot');
  await cp(PLUGIN_DIR, dir, { recursive: true });
  return dir;
}

test('截图插件：清单合法', async () => {
  const raw = JSON.parse(await readFile(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  const out = validateManifest(raw);
  assert.ok(out.ok, `清单不合法：${out.errors.join('；')}`);
  assert.equal(out.value.id, 'screenshot');
  assert.deepEqual(out.value.toolErrors, []);
  assert.deepEqual(out.value.skillErrors, []);
  assert.deepEqual(out.value.settingErrors, []);
});

test('截图插件：技能说明与页面都在磁盘上', async () => {
  const raw = JSON.parse(await readFile(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  assert.ok(raw.skill, '没有技能说明');
  const skill = await readFile(join(PLUGIN_DIR, raw.skill.file), 'utf8');
  assert.ok(skill.trim().length > 0, '技能正文是空的');
  const page = await readFile(join(PLUGIN_DIR, raw.window.page), 'utf8');
  const script = await readFile(join(PLUGIN_DIR, 'pages', 'shot.js'), 'utf8');
  assert.ok(page.includes('shot.js'), '页面没有引自己的脚本');
  assert.ok(script.includes('bindSurface'), '页面没有接上界面');
});

test('截图插件：给 agent 的工具都注册上了', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-shot-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-shot-ud-'));
  const registry = createToolRegistry();
  try {
    await copyPlugin(root);
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: {},
      toolRegistry: registry,
    });
    await host.load();
    const record = host.get('screenshot');
    assert.ok(record, '插件没加载上');
    const declared = record.manifest.tools.map((t) => t.name);
    assert.deepEqual(declared.sort(), ['screenshot.capture', 'screenshot.ocr']);
    for (const name of declared) {
      assert.ok(registry.get(name), `工具「${name}」没注册上`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('截图插件：窗口清单读得懂', () => {
  const payload = {
    Monitors: [{ Index: 0, X: 0, Y: 0, W: 2560, H: 1440, Dpi: 96 }],
    Windows: [
      { Pid: 12, X: 10, Y: 20, W: 800, H: 600, Title: '记事本', Monitor: 0 },
      { Pid: 13, X: 0, Y: 0, W: 40, H: 30, Title: '小气泡', Monitor: 0 },
    ],
  };
  const stdout = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const desk = parseDesk(stdout);
  assert.equal(desk.monitors.length, 1);
  assert.equal(desk.monitors[0].w, 2560);
  // 太小的窗口不算（托盘气泡之类）。
  assert.equal(desk.windows.length, 1);
  assert.equal(desk.windows[0].title, '记事本');
  assert.equal(desk.windows[0].monitor, 0);
});

test('截图插件：窗口清单读不懂就当没有', () => {
  assert.deepEqual(parseDesk(''), { monitors: [], windows: [] });
  assert.deepEqual(parseDesk('不是 base64'), { monitors: [], windows: [] });
});

test('截图插件：汉字用中文引擎，纯英文的词用英文引擎', () => {
  const zh = [
    {
      lang: 'zh-Hans-CN',
      text: 'HeIIo WorId 你 好',
      words: [
        { text: 'HeIIo', x: 22, y: 32, w: 114, h: 39 },
        { text: 'WorId', x: 161, y: 32, w: 137, h: 39 },
        { text: '你', x: 318, y: 31, w: 47, h: 47 },
        { text: '好', x: 366, y: 31, w: 47, h: 47 },
      ],
    },
  ];
  const en = [
    {
      lang: 'en-US',
      text: 'Hello World',
      words: [
        { text: 'Hello', x: 22, y: 32, w: 114, h: 39 },
        { text: 'World', x: 161, y: 32, w: 137, h: 39 },
      ],
    },
  ];
  const merged = mergeAuto(zh, en);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'Hello World 你好');
});

test('截图插件：重复的一行只留一遍', () => {
  const lines = [
    { text: 'Hello', x: 0, y: 0 },
    { text: 'hello', x: 0, y: 0 },
    { text: ' ', x: 0, y: 0 },
  ];
  assert.deepEqual(dedupe(lines).map((l) => l.text), ['Hello']);
});
