import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateManifest } from '../../src/shared/plugin.js';
import { createPluginHost } from '../../src/main/plugins/host.js';
import { createSkillRegistry, createSkillTools, MAX_SKILL_CHARS } from '../../src/main/assistant/agent/skills.js';

/**
 * 插件的技能说明与插件自己的配置。
 *
 * - 技能：清单里写名字与说明，正文在插件目录的 markdown 文件里；
 *   系统提示词里只有「名字：说明」，正文等模型调 skill.read 才给。
 * - 配置：清单里声明 schema，设置页按声明渲染，宿主不替插件猜。
 */

async function makePlugin(root, id, manifest, main, files = {}) {
  const dir = join(root, 'plugins', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (main) await writeFile(join(dir, 'main.js'), main, 'utf8');
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf8');
  }
  return dir;
}

const SKILL_DECL = {
  name: 'weather',
  description: '查天气',
  file: 'skill.md',
};

test('清单：skill 会被规整', () => {
  const out = validateManifest({ id: 'x', name: 'X', skill: SKILL_DECL });
  assert.ok(out.ok);
  assert.equal(out.value.skill.name, 'weather');
  assert.equal(out.value.skill.description, '查天气');
  assert.equal(out.value.skill.file, 'skill.md');
});

test('清单：skill 没写文件就是 skill.md', () => {
  const out = validateManifest({ id: 'x', name: 'X', skill: { name: 'x' } });
  assert.ok(out.ok);
  assert.equal(out.value.skill.file, 'skill.md');
});

test('清单：skill 名不合法只是没有技能，插件还能加载', () => {
  const out = validateManifest({ id: 'x', name: 'X', skill: { name: 'Bad Name' } });
  assert.ok(out.ok, '一个坏技能不该把整个插件干掉');
  assert.equal(out.value.skill, null);
  assert.equal(out.value.skillErrors.length, 1);
});

test('清单：skill 的文件不能越出插件目录', () => {
  const out = validateManifest({ id: 'x', name: 'X', skill: { name: 'x', file: '../secret.md' } });
  assert.ok(out.ok);
  assert.equal(out.value.skill, null);
  assert.equal(out.value.skillErrors.length, 1);
});

test('清单：settings 会按声明规整', () => {
  const out = validateManifest({
    id: 'x',
    name: 'X',
    settings: [
      { key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 },
      { key: 'enabled', label: '开关', type: 'boolean', default: 'true' },
      { key: 'city', label: '城市', type: 'select', options: ['北京', '上海'], default: '上海' },
    ],
  });
  assert.ok(out.ok);
  assert.equal(out.value.settings.length, 3);
  assert.equal(out.value.settings[0].default, 25);
  assert.equal(out.value.settings[1].default, true, '布尔默认值按类型归一');
  assert.equal(out.value.settings[2].default, '上海');
});

test('清单：类型不认识的配置项丢掉，其余照常', () => {
  const out = validateManifest({
    id: 'x',
    name: 'X',
    settings: [
      { key: 'ok', type: 'text', default: 'a' },
      { key: 'bad', type: 'color', default: 'red' },
    ],
  });
  assert.ok(out.ok);
  assert.equal(out.value.settings.length, 1);
  assert.equal(out.value.settingErrors.length, 1);
});

test('清单：同一个配置项 key 重复声明只留第一个', () => {
  const out = validateManifest({
    id: 'x',
    name: 'X',
    settings: [
      { key: 'k', type: 'text', default: 'a' },
      { key: 'k', type: 'text', default: 'b' },
    ],
  });
  assert.equal(out.value.settings.length, 1);
  assert.equal(out.value.settingErrors.length, 1);
});

test('技能表：注册、列出、摘掉', () => {
  const skills = createSkillRegistry();
  skills.register({ name: 'a', description: '甲', read: async () => '正文' });
  skills.register({ name: 'b', description: '乙', read: async () => '正文' }, { owner: 'p1' });
  assert.equal(skills.size, 2);
  assert.deepEqual(skills.list(), [
    { name: 'a', description: '甲' },
    { name: 'b', description: '乙' },
  ]);
  assert.equal(skills.unregister('p1'), 1);
  assert.equal(skills.size, 1);
});

test('技能表：同名先到先得', () => {
  const skills = createSkillRegistry();
  assert.ok(skills.register({ name: 'a', description: '甲', read: async () => 'x' }));
  assert.equal(skills.register({ name: 'a', description: '乙', read: async () => 'y' }), null);
  assert.equal(skills.get('a').description, '甲');
});

test('skill.read：读正文并截断', async () => {
  const skills = createSkillRegistry();
  skills.register({ name: 'a', description: '甲', read: async () => '长'.repeat(MAX_SKILL_CHARS + 100) });
  const [tool] = createSkillTools({ registry: skills });
  const out = await tool.run({ skill: 'a' });
  assert.ok(out.text.length <= MAX_SKILL_CHARS + 10);
  assert.ok(out.text.includes('已截断'));
  assert.equal(out.data.skill, 'a');
});

test('skill.read：技能不存在就抛错', async () => {
  const skills = createSkillRegistry();
  const [tool] = createSkillTools({ registry: skills });
  await assert.rejects(() => tool.run({ skill: 'nope' }), /没有这个技能/);
  await assert.rejects(() => tool.run({}), /给个 skill/);
});

test('skill.read：正文是空的也抛错', async () => {
  const skills = createSkillRegistry();
  skills.register({ name: 'a', description: '甲', read: async () => '   ' });
  const [tool] = createSkillTools({ registry: skills });
  await assert.rejects(() => tool.run({ skill: 'a' }), /正文是空的/);
});

test('宿主：插件的技能挂进技能表，正文从插件目录读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-skill-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气', skill: SKILL_DECL },
      `export default function create() { return {}; }`,
      { 'skill.md': '# 天气\n\n查天气的说明书。' }
    );
    const skills = createSkillRegistry();
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: root,
      assistant: {},
      skillRegistry: skills,
    });
    await host.load();
    assert.deepEqual(skills.list(), [{ name: 'weather', description: '查天气' }]);
    const [tool] = createSkillTools({ registry: skills });
    const out = await tool.run({ skill: 'weather' });
    assert.ok(out.text.includes('查天气的说明书'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：关掉的插件，它的技能从技能表里消失', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-skill-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气', skill: SKILL_DECL },
      `export default function create() { return {}; }`,
      { 'skill.md': '正文' }
    );
    const skills = createSkillRegistry();
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: root,
      assistant: {},
      skillRegistry: skills,
    });
    await host.load();
    assert.equal(skills.size, 1);
    await host.setEnabled('weather', false);
    assert.equal(skills.size, 0, '插件关了，技能就该消失');
    await host.setEnabled('weather', true);
    assert.equal(skills.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：技能正文不能读到插件目录外面', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-skill-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气', skill: SKILL_DECL },
      `export default function create() { return {}; }`,
      { 'skill.md': '正文' }
    );
    await writeFile(join(root, 'secret.md'), '不该被读到', 'utf8');
    const skills = createSkillRegistry();
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: root,
      assistant: {},
      skillRegistry: skills,
    });
    await host.load();
    const [tool] = createSkillTools({ registry: skills });
    await assert.rejects(() => tool.run({ skill: 'weather', path: '../secret.md' }), /不在插件目录里/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：配置项有默认值，改完落盘并能读回来', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-cfg-'));
  try {
    await makePlugin(
      root,
      'pomodoro',
      {
        id: 'pomodoro',
        name: '番茄钟',
        settings: [{ key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 }],
      },
      `export default function create() { return {}; }`
    );
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host.load();
    assert.deepEqual(host.getConfig('pomodoro'), { focusMinutes: 25 });

    const r = await host.setConfig('pomodoro', { focusMinutes: '45' });
    assert.equal(r.ok, true);
    assert.equal(host.getConfig('pomodoro').focusMinutes, 45, '字符串要被归一成数字');

    // 重新建一个宿主：值是从磁盘上读回来的。
    const host2 = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host2.load();
    assert.equal(host2.getConfig('pomodoro').focusMinutes, 45);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：没声明过的 key 写不进去', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-cfg-'));
  try {
    await makePlugin(
      root,
      'pomodoro',
      {
        id: 'pomodoro',
        name: '番茄钟',
        settings: [{ key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 }],
      },
      `export default function create() { return {}; }`
    );
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host.load();
    await host.setConfig('pomodoro', { other: 1 });
    assert.deepEqual(host.getConfig('pomodoro'), { focusMinutes: 25 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：插件拿到的配置是活的，用户改完立刻生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-cfg-'));
  try {
    await makePlugin(
      root,
      'pomodoro',
      {
        id: 'pomodoro',
        name: '番茄钟',
        settings: [{ key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 }],
      },
      `export default function create(ctx) {
         return { tools() { return []; }, readConfig() { return ctx.config.focusMinutes; } };
       }`
    );
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host.load();
    const plugin = host.get('pomodoro');
    assert.equal(plugin.instance.readConfig(), 25);
    await host.setConfig('pomodoro', { focusMinutes: 45 });
    assert.equal(plugin.instance.readConfig(), 45, '配置要能读到新值，不能是快照');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：清单里没有插件的配置——配置归插件自己的页面管', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-cfg-'));
  try {
    await makePlugin(
      root,
      'pomodoro',
      {
        id: 'pomodoro',
        name: '番茄钟',
        settings: [{ key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 }],
      },
      `export default function create() { return {}; }`
    );
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host.load();
    const item = host.listAll().find((p) => p.id === 'pomodoro');
    assert.equal(item.settings, undefined, '设置页不该再拿到插件的配置声明');
    assert.equal(item.config, undefined, '设置页不该再拿到插件的配置值');
    // 值还是能拿到的——只是不经过设置页。
    assert.deepEqual(host.getConfig('pomodoro'), { focusMinutes: 25 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：插件的配置块出现在插件自己的页面上（画在右边的抽屉里）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-cfg-'));
  try {
    await makePlugin(
      root,
      'pomodoro',
      {
        id: 'pomodoro',
        name: '番茄钟',
        settings: [{ key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 }],
      },
      `export default function create() {
         return { page: () => ({ pluginId: 'pomodoro', title: '番茄钟', blocks: [] }) };
       }`
    );
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host.load();
    const page = await host.open('pomodoro');
    // 配置项不进正文：正文留给内容，设置收在右边的抽屉里。
    assert.equal(page.blocks.length, 0, '配置项不该混在正文里');
    const block = page.drawer.at(-1);
    assert.equal(block.kind, 'settings');
    assert.equal(block.items.length, 1);
    assert.equal(block.items[0].key, 'focusMinutes');
    assert.equal(block.items[0].value, 25);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：插件自己放的设置项与清单里的配置项都在抽屉里', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-cfg-'));
  try {
    await makePlugin(
      root,
      'pomodoro',
      {
        id: 'pomodoro',
        name: '番茄钟',
        settings: [{ key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 }],
      },
      `export default function create() {
         return {
           page: () => ({
             pluginId: 'pomodoro',
             title: '番茄钟',
             blocks: [],
             drawer: [{ kind: 'toggle', id: 'beep', label: '响一下', checked: true }],
           }),
         };
       }`
    );
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host.load();
    const page = await host.open('pomodoro');
    // 插件自己放的在前，清单里声明的追加在后——都在抽屉里。
    assert.deepEqual(
      page.drawer.map((block) => block.kind),
      ['toggle', 'settings']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：在插件页面里改配置，值落盘', async () => {  const root = await mkdtemp(join(tmpdir(), 'desk-pet-cfg-'));
  try {
    await makePlugin(
      root,
      'pomodoro',
      {
        id: 'pomodoro',
        name: '番茄钟',
        settings: [{ key: 'focusMinutes', label: '专注时长', type: 'number', default: 25 }],
      },
      `export default function create() {
         return { page: () => ({ pluginId: 'pomodoro', title: '番茄钟', blocks: [] }) };
       }`
    );
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {} });
    await host.load();
    await host.action('pomodoro', 'settings:focusMinutes', '45');
    assert.equal(host.getConfig('pomodoro').focusMinutes, 45);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** 技能正文提到的工具被关掉了：读完补一句，省得模型白试一步。 */
test('skill.read：正文里提到的工具被关掉时补一句提醒', async () => {
  const skills = createSkillRegistry();
  skills.register({
    name: 'weather',
    description: '查天气',
    read: async () => '用 `weather.get` 查天气，用 `weather.list` 列出城市。',
  });
  const [tool] = createSkillTools({
    registry: skills,
    getDisabledTools: () => [{ name: 'weather.get' }],
  });
  const out = await tool.run({ skill: 'weather' });
  assert.ok(out.text.includes('weather.get 已被用户关闭'));
  assert.ok(!out.text.includes('weather.list 已被用户关闭'), '没提到的工具不用提');
});

/** 没提到被关掉的工具就不补。 */
test('skill.read：没提到被关掉的工具就不补', async () => {
  const skills = createSkillRegistry();
  skills.register({ name: 'a', description: '甲', read: async () => '正文' });
  const [tool] = createSkillTools({
    registry: skills,
    getDisabledTools: () => [{ name: 'fs.write' }],
  });
  const out = await tool.run({ skill: 'a' });
  assert.equal(out.text, '正文');
});

/** 按整个名字算：fs.read 被关掉时，正文里的 fs.read.bak 不算提到它。 */
test('skill.read：只是前缀相同的工具不算被提到', async () => {
  const skills = createSkillRegistry();
  skills.register({ name: 'a', description: '甲', read: async () => '用 fs.read.bak 读备份' });
  const [tool] = createSkillTools({
    registry: skills,
    getDisabledTools: () => [{ name: 'fs.read' }],
  });
  const out = await tool.run({ skill: 'a' });
  assert.equal(out.text, '用 fs.read.bak 读备份');
});
