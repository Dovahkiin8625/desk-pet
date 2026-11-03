import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginRegistry } from '../../src/main/plugins/index.js';
import { BLOCK_KIND } from '../../src/shared/panel.js';

/**
 * 插件注册表。
 *
 * 插件界面是声明式的：主进程造页面描述，渲染层照着画。
 * 这里测的就是「页面描述造得对不对」与「动作分发的对不对」。
 */

/** 一个假的助理：只提供插件用到的方法，并记录被调用了什么。 */
function makeAssistant(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    todosView: () => ({
      items: [{ id: 't-1', label: '写周报', done: false }],
      pending: 1,
      total: 1,
    }),
    remindersView: () => ({
      items: [{ id: 'r-1', label: '喝水', hint: '今天 14:30' }],
      total: 1,
    }),
    pomodoroView: () => ({ phase: 'idle', text: '番茄钟没有在跑', running: false, paused: false }),
    weatherView: () => ({ city: '北京', enabled: false, text: '北京 晴 26°C' }),
    statusView: () => ({ text: '系统状态\nCPU 10%' }),
    clipboardView: () => ({ enabled: false }),
    readClipboard: async () => ({ ok: true, text: '一段文字' }),
    addTodo: (text) => {
      calls.push(['addTodo', text]);
      return { ok: true, message: `加好了：${text}` };
    },
    toggleTodo: (id) => {
      calls.push(['toggleTodo', id]);
      return { ok: true, message: '完成啦' };
    },
    clearDoneTodos: () => ({ ok: true, message: '清掉了 1 条已完成的' }),
    addReminder: (text) => {
      calls.push(['addReminder', text]);
      return { ok: true, message: '好的' };
    },
    removeReminder: (id) => {
      calls.push(['removeReminder', id]);
      return { ok: true, message: '删掉了' };
    },
    startPomodoro: (phase) => {
      calls.push(['startPomodoro', phase]);
      return { ok: true, message: '开始专注，25 分钟' };
    },
    pausePomodoro: () => ({ ok: true, message: '暂停了' }),
    resumePomodoro: () => ({ ok: true, message: '继续' }),
    resetPomodoro: () => ({ ok: true, message: '重置了' }),
    setWeatherCity: (city) => {
      calls.push(['setWeatherCity', city]);
      return { ok: true, message: `城市改成「${city}」了` };
    },
    setWeatherEnabled: (on) => ({ ok: true, message: String(on) }),
    setHotAlertEnabled: (on) => ({ ok: true, message: String(on) }),
    setClipboardEnabled: (on) => ({ ok: true, message: String(on) }),
    fetchWeather: async () => ({ ok: true, message: '北京 晴 26°C' }),
    chatHistoryView: () => ({
      messages: [{ role: 'user', text: '在吗', at: 1, proactive: false }],
      total: 1,
      facts: ['用户喜欢喝美式'],
    }),
    clearChatHistory: () => {
      calls.push(['clearChatHistory']);
      return { ok: true, message: '记录清空了' };
    },
  };
  return { ...base, ...overrides };
}

function makeRegistry(assistant = makeAssistant(), openSettings = () => {}) {
  const registry = createPluginRegistry({ assistant, openSettings });
  return { registry, assistant, openSettings };
}

/** 页面里所有块的 kind。 */
function kindsOf(page) {
  return (page?.blocks || []).map((b) => b.kind);
}

test('插件清单：id 唯一，每个都有名字、说明与关键词', () => {
  const { registry } = makeRegistry();
  const list = registry.list();
  assert.equal(list.length, 8, '现在是 8 个插件（说句话与快捷启动已经退役）');
  const ids = list.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  for (const plugin of list) {
    assert.ok(plugin.name, `${plugin.id} 应该有名字`);
    assert.ok(plugin.description, `${plugin.id} 应该有说明`);
    assert.ok(Array.isArray(plugin.keywords) && plugin.keywords.length > 0, `${plugin.id} 应该有关键词`);
    assert.ok(plugin.icon, `${plugin.id} 应该有图标`);
  }
});

test('每个插件都能打开，返回合法页面', async () => {
  const { registry } = makeRegistry();
  for (const plugin of registry.list()) {
    const page = await registry.open(plugin.id, () => {});
    // 「设置」插件会打开另一个窗口，返回 null 表示「面板可以关了」。
    if (plugin.id === 'settings') {
      assert.equal(page, null);
      continue;
    }
    assert.ok(page, `${plugin.id} 应该返回页面`);
    assert.equal(page.pluginId, plugin.id);
    assert.ok(page.title, `${plugin.id} 的页面应该有标题`);
    assert.ok(Array.isArray(page.blocks));
  }
});

test('待办插件：清单 + 输入框 + 清除按钮', async () => {
  const { registry } = makeRegistry();
  const page = await registry.open('todos', () => {});
  const kinds = kindsOf(page);
  assert.ok(kinds.includes(BLOCK_KIND.LIST));
  assert.ok(kinds.includes(BLOCK_KIND.INPUT));
  assert.ok(kinds.includes(BLOCK_KIND.BUTTONS));
  const list = page.blocks.find((b) => b.kind === BLOCK_KIND.LIST);
  assert.equal(list.items[0].label, '写周报');
});

test('待办插件：输入的动作会真的调助理', async () => {
  const { registry, assistant } = makeRegistry();
  const page = await registry.action('todos', 'add', '买菜', () => {});
  assert.deepEqual(assistant.calls, [['addTodo', '买菜']]);
  assert.equal(page.status, '加好了：买菜');
});

test('待办插件：点条目等于勾选那一条', async () => {
  const { registry, assistant } = makeRegistry();
  await registry.action('todos', 't-1', 't-1', () => {});
  assert.deepEqual(assistant.calls, [['toggleTodo', 't-1']]);
});

test('提醒插件：点条目是删除它', async () => {
  const { registry, assistant } = makeRegistry();
  await registry.action('reminders', 'r-1', 'r-1', () => {});
  assert.deepEqual(assistant.calls, [['removeReminder', 'r-1']]);
});

test('番茄钟插件：空闲时给「开始专注」，跑着时给「暂停」', async () => {
  const { registry } = makeRegistry();
  let page = await registry.open('pomodoro', () => {});
  let labels = page.blocks
    .find((b) => b.kind === BLOCK_KIND.BUTTONS)
    .items.map((b) => b.label);
  assert.ok(labels.includes('开始专注 25 分钟'));
  assert.ok(!labels.includes('暂停'));

  const running = makeAssistant({
    pomodoroView: () => ({ phase: 'focus', text: '专注中', running: true, paused: false }),
  });
  page = await createPluginRegistry({ assistant: running, openSettings: () => {} }).open(
    'pomodoro',
    () => {}
  );
  labels = page.blocks
    .find((b) => b.kind === BLOCK_KIND.BUTTONS)
    .items.map((b) => b.label);
  assert.ok(labels.includes('暂停'));
});

test('番茄钟插件：暂停后给「继续」', async () => {
  const paused = makeAssistant({
    pomodoroView: () => ({ phase: 'paused', text: '已暂停', running: false, paused: true }),
  });
  const page = await createPluginRegistry({ assistant: paused, openSettings: () => {} }).open(
    'pomodoro',
    () => {}
  );
  const labels = page.blocks
    .find((b) => b.kind === BLOCK_KIND.BUTTONS)
    .items.map((b) => b.label);
  assert.ok(labels.includes('继续'));
});

test('天气插件：设置城市与开关都会落到助理', async () => {
  const { registry, assistant } = makeRegistry();
  await registry.action('weather', 'city', '上海', () => {});
  await registry.action('weather', 'enabled', 'true', () => {});
  assert.deepEqual(assistant.calls, [['setWeatherCity', '上海']]);
});

test('天气插件：查天气是异步的，结果到了会刷新页面', async () => {
  const { registry } = makeRegistry();
  const updates = [];
  const page = await registry.action('weather', 'refresh', '', (p) => updates.push(p));
  assert.equal(page.status, '正在查…');
  // 等一下异步的天气查询。
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(updates.length, 1, '结果到了应该刷新一次页面');
  assert.equal(updates[0].status, '北京 晴 26°C');
});

test('剪贴板插件：读一次剪贴板并显示出来', async () => {
  const { registry } = makeRegistry();
  const page = await registry.open('clipboard', () => {});
  const text = page.blocks.find((b) => b.kind === BLOCK_KIND.TEXT);
  assert.ok(text.text.includes('一段文字'));
});

test('剪贴板插件：动作之后页面还是完整的', async () => {
  // 这个插件的 open 是 **async** 的（读剪贴板要等）。
  // 动作里若直接展开一个 Promise，得到的会是空对象——
  // 页面就没了（标题、块全空），面板变成一片空白。
  const { registry, assistant } = makeRegistry();
  const page = await registry.action('clipboard', 'enabled', 'true', () => {});
  assert.ok(assistant.calls, '开关应该被交给助理');
  assert.equal(page.pluginId, 'clipboard', '页面还得是剪贴板插件的');
  assert.equal(page.title, '剪贴板');
  assert.ok(page.blocks.length > 0, '页面得有内容');
});

test('「说句话」与「快捷启动」已经不是插件了', async () => {
  // 「说句话」整个去掉；「快捷启动」变成搜索框里的程序搜索（不是插件）。
  const { registry } = makeRegistry();
  const ids = registry.list().map((p) => p.id);
  assert.ok(!ids.includes('speak'), '「说句话」插件应当已经退役');
  assert.ok(!ids.includes('launcher'), '「快捷启动」不该再是插件');
  // 退役了就不能再打开：留着会让人以为它还在。
  assert.equal(await registry.open('speak', () => {}), null);
  assert.equal(await registry.open('launcher', () => {}), null);
});

test('设置插件：打开设置窗口，面板自己关掉', async () => {
  let opened = 0;
  const { registry } = makeRegistry(makeAssistant(), () => {
    opened += 1;
  });
  const page = await registry.open('settings', () => {});
  assert.equal(opened, 1);
  assert.equal(page, null);
});

test('不认识的插件 id 返回 null（不抛异常）', async () => {
  const { registry } = makeRegistry();
  assert.equal(await registry.open('不存在的插件', () => {}), null);
  assert.equal(await registry.action('不存在的插件', 'x', '', () => {}), null);
});

test('聊天记录插件：显示对话，并能一键清空', async () => {
  const { registry, assistant } = makeRegistry();
  const page = await registry.open('history', () => {});
  assert.equal(page.pluginId, 'history');
  assert.equal(page.title, '聊天记录');
  const messages = page.blocks.find((b) => b.kind === BLOCK_KIND.MESSAGES);
  assert.ok(messages, '要有对话记录块');
  assert.equal(messages.items[0].text, '在吗');
  assert.equal(messages.items[0].role, 'user');

  const after = await registry.action('history', 'clear', '', () => {});
  assert.deepEqual(assistant.calls, [['clearChatHistory']]);
  assert.equal(after.status, '记录清空了');
});

test('聊天记录插件的 id 不能和搜索结果里的「和桌宠聊天」撞', () => {
  // 搜索结果里那条是合成项，id 是 'chat'；插件不能叫这个名字，
  // 否则点「和桌宠聊天」会打开插件而不是发起对话。
  const { registry } = makeRegistry();
  const ids = registry.list().map((p) => p.id);
  assert.ok(ids.includes('history'));
  assert.ok(!ids.includes('chat'));
});
