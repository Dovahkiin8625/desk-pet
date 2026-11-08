import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateManifest,
  isSafeRelativePath,
  PLUGIN_ID_RE,
  PLUGIN_WINDOW_MODE,
  PLUGIN_WINDOW_LIMITS,
} from '../../src/shared/plugin.js';
import { discoverPlugins, loadPluginFactory } from '../../src/main/plugins/loader.js';
import { createPluginHost } from '../../src/main/plugins/host.js';
import { createSurfaceController } from '../../src/main/plugins/surface.js';

/**
 * 插件的测试分两层：
 *
 * 1. **清单**（纯函数）：什么样的 plugin.json 才算数；
 * 2. **宿主**（真读磁盘）：摆一个插件目录进去，它该被认出来、
 *    该出现在清单里、该能打开。
 *
 * 宿主这一层不碰 Electron：它只管插件目录与页面描述，
 * 窗口那部分（src/main/plugins/window.js）要 Electron，跑不了。
 */

/**
 * 摆一个插件目录。
 *
 * 摆在 `<root>/plugins/<id>/` 下——内置插件就在项目根的 plugins/ 里，
 * 宿主的发现逻辑找的正是那个位置。
 */
async function makePlugin(root, id, manifest, main) {
  const dir = join(root, 'plugins', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (main) await writeFile(join(dir, 'main.js'), main, 'utf8');
  return dir;
}

/** 一个假的助理：插件读写状态都走它。 */
function fakeAssistant() {
  return {
    todosView: () => ({ items: [{ id: '1', label: '写测试', done: false }], pending: 1, total: 1 }),
    addTodo: (text) => ({ ok: true, message: `加好了：${text}` }),
    toggleTodo: () => ({ ok: true, message: '完成啦' }),
    clearDoneTodos: () => ({ ok: true, message: '清掉了' }),
  };
}

test('清单：id 只能是小写字母、数字与连字符', () => {
  assert.ok(PLUGIN_ID_RE.test('todos'));
  assert.ok(PLUGIN_ID_RE.test('my-plugin-2'));
  assert.ok(!PLUGIN_ID_RE.test('Todos'));
  assert.ok(!PLUGIN_ID_RE.test('待办'));
  assert.ok(!PLUGIN_ID_RE.test('-todos'));
  assert.ok(!PLUGIN_ID_RE.test('to dos'));
});

test('清单：缺 id 或 name 一律不通过', () => {
  assert.equal(validateManifest({ name: '待办' }).ok, false);
  assert.equal(validateManifest({ id: 'todos' }).ok, false);
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
});

test('清单：入口与页面不能跑到插件目录外面', () => {
  assert.ok(isSafeRelativePath('main.js'));
  assert.ok(isSafeRelativePath('pages/widget.html'));
  assert.ok(!isSafeRelativePath('../evil.js'));
  assert.ok(!isSafeRelativePath('a/../../evil.js'));
  assert.ok(!isSafeRelativePath('/etc/passwd'));
  assert.ok(!isSafeRelativePath('C:\\evil.js'));

  const out = validateManifest({ id: 'x', name: 'X', entry: '../../evil.js' });
  assert.equal(out.ok, false);
  assert.match(out.errors.join('；'), /entry/);
});

test('清单：没写的东西用默认值补齐', () => {
  const { ok, value } = validateManifest({ id: 'todos', name: '待办' });
  assert.ok(ok);
  assert.equal(value.entry, 'main.js');
  assert.equal(value.icon, '•');
  assert.deepEqual(value.keywords, []);
  // 没写 `window` / `widget` 段 = 没有这两种形态（不是「有，默认值」）。
  assert.equal(value.window, null);
  assert.equal(value.widget, null);
});

test('清单：写了 window 段才有独立窗口', () => {
  const { ok, value } = validateManifest({
    id: 'todos',
    name: '待办',
    window: { title: '待办', width: 300 },
  });
  assert.ok(ok);
  assert.equal(value.window.mode, PLUGIN_WINDOW_MODE.WINDOW);
  assert.equal(value.window.width, 300);
  assert.equal(value.widget, null);
});

test('清单：窗口尺寸会被夹到合理范围', () => {
  const { value } = validateManifest({
    id: 'x',
    name: 'X',
    window: { width: 999999, height: 1 },
  });
  assert.ok(value.window.width <= 1200);
  assert.ok(value.window.height >= 120);
});

test('发现：目录里没有清单就不是插件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await mkdir(join(root, 'not-a-plugin'), { recursive: true });
    await writeFile(join(root, 'loose.txt'), 'x', 'utf8');
    const found = await discoverPlugins([{ dir: join(root, 'plugins'), source: 'bundled' }]);
    assert.deepEqual(found, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('发现：清单坏了的插件被跳过，好的照常加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(root, 'broken', { id: 'broken' }, 'export default () => ({});');
    await makePlugin(
      root,
      'good',
      { id: 'good', name: '好的', keywords: ['hao'] },
      'export default () => ({ page: () => null });'
    );
    const found = await discoverPlugins([{ dir: join(root, 'plugins'), source: 'bundled' }]);
    assert.equal(found.length, 1);
    assert.equal(found[0].manifest.id, 'good');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('发现：目录名与清单里的 id 不一致时不认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(
      root,
      'dirname',
      { id: 'other', name: '别的' },
      'export default () => ({ page: () => null });'
    );
    const found = await discoverPlugins([{ dir: join(root, 'plugins'), source: 'bundled' }]);
    assert.deepEqual(found, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('加载：入口必须导出默认函数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(root, 'noexport', { id: 'noexport', name: '没有导出' }, 'export const x = 1;');
    const found = await discoverPlugins([{ dir: join(root, 'plugins'), source: 'bundled' }]);
    await assert.rejects(() => loadPluginFactory(found[0]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：插件被认出来，清单里有它', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'todos',
      { id: 'todos', name: '待办', keywords: ['todo'], window: { title: '待办' } },
      `export default function create() {
         return {
           page(ctx) {
             return ctx.ui.makePage({
               pluginId: 'todos',
               title: '待办',
               blocks: [ctx.ui.textBlock(ctx.assistant.todosView().total + ' 件事')],
             });
           },
           action(ctx, actionId, value) {
             if (actionId === 'add') ctx.assistant.addTodo(value);
             return this.page(ctx);
           },
         };
       }`
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    const list = host.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'todos');
    assert.equal(list[0].name, '待办');
    // 清单里写了 window 段 → 面板上就该有「在新窗口打开」这个按钮。
    assert.equal(list[0].canDetach, true);
    assert.equal(list[0].hasWidget, false);

    const page = await host.open('todos');
    assert.equal(page.title, '待办');
    assert.equal(page.blocks[0].text, '1 件事');

    const after = await host.action('todos', 'add', '新的');
    assert.equal(after.title, '待办');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：关掉的插件不出现在清单里，也打不开', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'todo',
      { id: 'todo', name: '待办' },
      'export default () => ({ page: () => ({ pluginId: "todo", title: "待办" }) });'
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();
    assert.equal(host.list().length, 1);

    await host.setEnabled('todo', false);
    assert.equal(host.list().length, 0);
    assert.equal(await host.open('todo'), null);
    // listAll 仍然看得见它——设置窗口的「插件」分区要知道它还在。
    assert.equal(host.listAll()[0].enabled, false);

    await host.setEnabled('todo', true);
    assert.equal(host.list().length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：插件清单变了会通知监听者', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'todo',
      { id: 'todo', name: '待办' },
      'export default () => ({ page: () => null });'
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    const seen = [];
    host.onChange((list) => seen.push(list.length));
    await host.setEnabled('todo', false);
    assert.deepEqual(seen, [0]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：插件自己的数据（窗口/小部件用）与动作', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'stat',
      { id: 'stat', name: '状态', widget: { page: 'widget.html', refreshMs: 1000 } },
      `export default function create() {
         return {
           page: () => null,
           data: () => ({ cpu: 42 }),
           tick: () => ({ cpu: 43 }),
           act: (ctx, actionId, payload) => ({ actionId, payload }),
         };
       }`
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    assert.deepEqual(await host.data('stat'), { cpu: 42 });
    assert.deepEqual(await host.tick('stat'), { cpu: 43 });
    assert.deepEqual(await host.act('stat', 'click', { a: 1 }), { actionId: 'click', payload: { a: 1 } });
    // 清单里的 widget 段：宽度被夹住，页面路径留着。
    const spec = host.spec('stat', PLUGIN_WINDOW_MODE.WIDGET);
    assert.equal(spec.page, 'widget.html');
    assert.equal(spec.refreshMs, 1000);
    assert.ok(spec.width > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：没写 window 段的插件也能拿到一份窗口规格', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'bare',
      { id: 'bare', name: '光秃秃' },
      'export default () => ({ page: () => null });'
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    // 独立窗口是所有插件都有的能力：清单没写，宿主合成一份。
    const spec = host.spec('bare', PLUGIN_WINDOW_MODE.WINDOW);
    assert.equal(spec.title, '光秃秃');
    assert.equal(spec.width, PLUGIN_WINDOW_LIMITS.width);
    assert.equal(spec.height, PLUGIN_WINDOW_LIMITS.height);
    assert.equal(spec.alwaysOnTop, false);

    // 小部件仍然要插件自己声明：没写就是没有。
    assert.equal(host.spec('bare', PLUGIN_WINDOW_MODE.WIDGET), null);
    // 没有这个插件：什么都没有。
    assert.equal(host.spec('nope', PLUGIN_WINDOW_MODE.WINDOW), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：自带页面的 URL——页面在磁盘上才给，否则给空串', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    const dir = await makePlugin(
      root,
      'paged',
      { id: 'paged', name: '带页面', window: { title: '带页面', page: 'index.html' } },
      'export default () => ({ page: () => null });'
    );
    // 清单里写的页面**确实存在**：给完整 URL。
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>插件</title>', 'utf8');
    // 另一个插件：清单里写了页面，磁盘上却没有——不能开白窗口。
    await makePlugin(
      root,
      'ghost',
      { id: 'ghost', name: '页面没了', window: { title: '页面没了', page: 'missing.html' } },
      'export default () => ({ page: () => null });'
    );

    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    const url = host.pageUrl('paged');
    assert.match(url, /^app:\/\/bundle\/plugins\/paged\/index\.html\?plugin=paged$/);
    // 页面不在磁盘上：空串——调用方据此退回积木界面。
    assert.equal(host.pageUrl('ghost'), '');
    // 没有自带页面的插件：也是空串。
    assert.equal(host.pageUrl('nope'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：插件清单里带页面信息（自带页面时给完整 URL）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    const dir = await makePlugin(
      root,
      'paged',
      { id: 'paged', name: '带页面', window: { title: '带页面', page: 'index.html' } },
      'export default () => ({ page: () => null });'
    );
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>插件</title>', 'utf8');
    // 没有自带页面的插件。
    await makePlugin(
      root,
      'plain',
      { id: 'plain', name: '没页面' },
      'export default () => ({ page: () => null });'
    );

    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    const paged = host.list().find((p) => p.id === 'paged');
    // 清单里写了 page → 面板据此装 iframe。
    assert.equal(paged.hasPage, true);
    assert.match(paged.pageUrl, /^app:\/\/bundle\/plugins\/paged\/index\.html\?plugin=paged$/);

    const plain = host.list().find((p) => p.id === 'plain');
    assert.equal(plain.hasPage, false);
    assert.equal(plain.pageUrl, '');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：页面地址走缓存——查盘一次就够，插件清单变了才重算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    const dir = await makePlugin(
      root,
      'paged',
      { id: 'paged', name: '带页面', window: { title: '带页面', page: 'index.html' } },
      'export default () => ({ page: () => null });'
    );
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>插件</title>', 'utf8');

    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    const url = host.listAll()[0].pageUrl;
    assert.match(url, /index\.html/);

    // 把文件删了：清单刷新**不该**每次都 statSync 一遍——
    // 缓存里的地址原样还在（这正是缓存的意义）。
    await rm(join(dir, 'index.html'), { force: true });
    assert.equal(host.listAll()[0].pageUrl, url);

    // 插件清单变了（开关了插件）：缓存作废，重新查盘——
    // 文件真的没了，这次该给空串（调用方据此退回积木界面）。
    await host.setEnabled('paged', false);
    assert.equal(host.listAll()[0].pageUrl, '');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：自带页面的插件——打开时只问标题，周期刷新推数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    const dir = await makePlugin(
      root,
      'paged',
      { id: 'paged', name: '带页面', window: { title: '带页面', page: 'index.html' } },
      `export default function create() {
         return {
           page: () => { throw new Error('自带页面的插件不该被问整页'); },
           meta: () => ({ title: '标题', subtitle: '副标题', status: '状态' }),
           data: () => ({ n: 1 }),
           tick: () => ({ n: 2 }),
         };
       }`
    );
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>插件</title>', 'utf8');

    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    // 打开：只问标题那几个字段，不重算整页。
    const page = await host.open('paged');
    assert.equal(page.title, '标题');
    assert.equal(page.subtitle, '副标题');
    assert.equal(page.status, '状态');
    assert.deepEqual(page.blocks, []);

    // 周期刷新：自带页面的插件推的是**数据**。
    assert.deepEqual(await host.refresh('paged'), { kind: 'tick', data: { n: 2 } });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：页面文件不在磁盘上——打开时退回整页，周期刷新推页面', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    // 清单里写了 page，但磁盘上没有那个文件。
    await makePlugin(
      root,
      'ghost',
      { id: 'ghost', name: '页面没了', window: { title: '页面没了', page: 'missing.html' } },
      `export default function create() {
         return {
           page: () => ({ pluginId: 'ghost', title: '整页', blocks: [] }),
           meta: () => ({ title: '只问标题' }),
         };
       }`
    );

    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    // 页面装不进去 → 退回积木界面：整页得真的算出来。
    const page = await host.open('ghost');
    assert.equal(page.title, '整页');

    // 周期刷新推的是**重算过的页面**（界面是宿主画的）。
    const refreshed = await host.refresh('ghost');
    assert.equal(refreshed.kind, 'page');
    assert.equal(refreshed.data.title, '整页');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('宿主：界面开合会通知订阅者，取消订阅后不再收到', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'todo',
      { id: 'todo', name: '待办' },
      'export default () => ({ page: () => null });'
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    const seen = [];
    const off = host.onSurfaceChange((pluginId, open) => seen.push({ pluginId, open }));
    host.surfaceChanged('todo', true);
    host.surfaceChanged('todo', false);
    assert.deepEqual(seen, [
      { pluginId: 'todo', open: true },
      { pluginId: 'todo', open: false },
    ]);

    // 取消订阅之后：不再收到通知。
    off();
    host.surfaceChanged('todo', true);
    assert.equal(seen.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('插件能通过 ctx.host.onSurfaceChange 订阅界面开合', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    // 插件把订阅到的通知记在自己的工厂闭包里——
    // 宿主要能把它**送到插件手里**（ctx.host.onSurfaceChange）。
    await makePlugin(
      root,
      'todo',
      { id: 'todo', name: '待办' },
      `let seen = [];
export default (ctx) => {
  ctx.host.onSurfaceChange((pluginId, open) => seen.push({ pluginId, open }));
  return {
    page: () => null,
    seen: () => seen,
  };
};
`
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    // 插件**真的**能订阅到：ctx.host 上有这个东西。
    const record = host.get('todo');
    assert.ok(record?.instance, '插件没加载起来');
    host.surfaceChanged('todo', true);
    host.surfaceChanged('todo', false);
    assert.deepEqual(record.instance.seen(), [
      { pluginId: 'todo', open: true },
      { pluginId: 'todo', open: false },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('插件能通过 ctx.push 把数据推给自己的界面', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'pusher',
      { id: 'pusher', name: '推送' },
      `export default function create(ctx) {
         return {
           page: () => null,
           pushIt: (data) => ctx.push(data),
         };
       }`
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();
    const record = host.get('pusher');

    // **通道还没接上**：推出去也不该炸——
    // 插件不知道宿主什么时候把路由建好，它只管推。
    record.instance.pushIt({ n: 1 });

    const pushed = [];
    host.attachBroadcaster((pluginId, kind, payload) =>
      pushed.push({ pluginId, kind, payload })
    );
    record.instance.pushIt({ n: 2 });

    assert.deepEqual(pushed, [{ pluginId: 'pusher', kind: 'data', payload: { n: 2 } }]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('推过去的数据真的到了界面落点（包成信封）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-userdata-'));
  try {
    await makePlugin(
      root,
      'pusher',
      { id: 'pusher', name: '推送' },
      `export default function create(ctx) {
         return {
           page: () => null,
           pushIt: (data) => ctx.push(data),
         };
       }`
    );
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: userData,
      assistant: fakeAssistant(),
      openSettings: () => {},
    });
    await host.load();

    // 界面路由：面板工作台与独立窗口都是「界面落点」。
    const surfaces = createSurfaceController({ host, onChange: () => {} });
    const delivered = [];
    surfaces.attach('pusher', {
      mode: 'window',
      deliver: (kind, payload) => delivered.push({ kind, payload }),
    });
    host.attachBroadcaster((pluginId, kind, payload) =>
      surfaces.broadcast(pluginId, kind, payload)
    );

    host.get('pusher').instance.pushIt({ n: 3 });

    assert.deepEqual(delivered, [
      { kind: 'data', payload: { pluginId: 'pusher', data: { n: 3 } } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
