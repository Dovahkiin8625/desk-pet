import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPluginHost } from '../../src/main/plugins/host.js';
import {
  LANGUAGES,
  TARGET_AUTO,
  buildPrompt,
  isChinese,
  languageByLabel,
  parsePublicTranslation,
  resolveTarget,
  translateWithPublic,
} from '../../plugins/translate/lib/translate.js';
import { variableNamesFor } from '../../plugins/translate/lib/variables.js';

/**
 * 翻译插件。
 *
 * 覆盖两半：
 *
 * 1. **纯逻辑**（认语言、定目标、拆接口的回复）——这段最容易写错，
 *    而且错了是「译得很怪」而不是「报错」，所以要单独罩住。
 * 2. **插件接在宿主上**（清单合法、页面在磁盘上、拿到输入框里的字、
 *    翻完把译文推给界面）。
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 把仓库里真的那个插件复制到临时目录（宿主只认自己根目录下的 plugins/）。 */
async function copyTranslate(root) {
  const dir = join(root, 'plugins', 'translate');
  await cp(join(REPO_ROOT, 'plugins', 'translate'), dir, { recursive: true });
  return dir;
}

/** 一个假的助理：只提供插件用得上的那几样。 */
function fakeAssistant({ complete } = {}) {
  return {
    complete:
      complete ||
      (async () => ({ ok: true, text: '译好的那句话' })),
  };
}

/** 造一个宿主（装着真的翻译插件）。 */
async function makeHost({ assistant = fakeAssistant(), inputText = '' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-tr-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-tr-ud-'));
  await copyTranslate(root);
  const host = await createPluginHost({
    rootDir: root,
    userDataDir: userData,
    assistant,
    openSettings: () => {},
    getInputText: () => inputText,
  });
  await host.load();
  return {
    host,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(userData, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

test('翻译：认出中文与外文', () => {
  assert.equal(isChinese('这是中文'), true);
  assert.equal(isChinese('hello world'), false);
  assert.equal(isChinese('hello 世界'), true);
  assert.equal(isChinese(''), false);
});

test('翻译：自动模式——外文译成中文，中文译成英语', () => {
  const foreign = resolveTarget('hello world', TARGET_AUTO);
  assert.equal(foreign.code, 'zh-CN');
  assert.equal(foreign.name, '中文');
  assert.equal(foreign.source, 'other');

  const chinese = resolveTarget('你好', TARGET_AUTO);
  assert.equal(chinese.code, 'en');
  assert.equal(chinese.name, '英语');
  assert.equal(chinese.source, 'zh');
});

test('翻译：定了目标语言就照它来', () => {
  const target = resolveTarget('hello', '日语');
  assert.equal(target.code, 'ja');
  assert.equal(target.name, '日语');
  assert.equal(target.auto, false);
});

test('翻译：认不出来的语言名就当自动', () => {
  assert.equal(languageByLabel('克林贡语').code, 'auto');
  assert.equal(resolveTarget('hello', '克林贡语').code, 'zh-CN');
});

test('翻译：语言表里每一项都有名字与代码', () => {
  for (const item of LANGUAGES) {
    assert.ok(item.label, '语言要有名字');
    assert.ok(item.code, '语言要有代码');
    assert.ok(item.name, '语言要有给模型看的说法');
  }
});

test('翻译：给模型的提示词只让它输出译文', () => {
  const prompt = buildPrompt('hello world', '中文');
  assert.match(prompt, /翻译成中文/);
  assert.match(prompt, /hello world/);
  assert.match(prompt, /只输出译文/);
});

test('翻译：拆公共接口的回复', () => {
  const data = [[['你好', 'hello', null, null, 5], ['世界', 'world']]];
  assert.equal(parsePublicTranslation(data), '你好世界');
  assert.equal(parsePublicTranslation(null), '');
  assert.equal(parsePublicTranslation([[]]), '');
});

test('翻译：公共接口——地址与回包', async () => {
  let called = '';
  const result = await translateWithPublic('hello', 'zh-CN', {
    fetchImpl: async (url) => {
      called = url;
      return { ok: true, json: async () => [[['你好', 'hello']]] };
    },
  });
  assert.equal(result, '你好');
  assert.match(called, /tl=zh-CN/);
  assert.match(called, /q=hello/);
});

test('翻译：公共接口回错误就抛出去', async () => {
  await assert.rejects(
    () =>
      translateWithPublic('hello', 'zh-CN', {
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      }),
    /503/
  );
});

test('变量名：英文短语给出小驼峰与大驼峰', () => {
  assert.deepEqual(variableNamesFor('user name'), { lower: 'userName', upper: 'UserName' });
  assert.deepEqual(variableNamesFor('User-Name'), { lower: 'userName', upper: 'UserName' });
  assert.deepEqual(variableNamesFor('user_name'), { lower: 'userName', upper: 'UserName' });
  assert.deepEqual(variableNamesFor('get user name'), { lower: 'getUserName', upper: 'GetUserName' });
  assert.deepEqual(variableNamesFor('order 2 items'), { lower: 'order2Items', upper: 'Order2Items' });
  // 顺带把撇号黏着的词当一个词看。
  assert.deepEqual(variableNamesFor("don't panic"), { lower: 'dontPanic', upper: 'DontPanic' });
  // 单个词也行。
  assert.deepEqual(variableNamesFor('user'), { lower: 'user', upper: 'User' });
});

test('变量名：不像变量名时不给', () => {
  assert.equal(variableNamesFor(''), null);
  assert.equal(variableNamesFor('数据库'), null, '中文译文不给');
  assert.equal(variableNamesFor('hello 世界'), null, '带非 ASCII 的不给');
  assert.equal(variableNamesFor('class'), null, '保留字不给');
  assert.equal(variableNamesFor('2 hours ago'), null, '数字开头不给');
  assert.equal(variableNamesFor('one two three four five six'), null, '词太多不给');
});

// ---------------------------------------------------------------------------
// 插件接在宿主上
// ---------------------------------------------------------------------------

test('翻译插件：清单合法，目录名与 id 一致，页面在磁盘上', async () => {
  const { host, cleanup } = await makeHost();
  try {
    const meta = host.list().find((p) => p.id === 'translate');
    assert.ok(meta, '翻译插件没被认出来');
    assert.equal(meta.name, '翻译');
    assert.equal(meta.hasPage, true);
    assert.match(meta.pageUrl, /translate\/pages\/translate\.html/);
    // 它要吃面板输入框里的字：面板据此加一行结果。
    assert.deepEqual(meta.panelInput, { label: '翻译' });
  } finally {
    await cleanup();
  }
});

test('翻译插件：首份数据带着输入框里那段文字', async () => {
  const { host, cleanup } = await makeHost({ inputText: 'hello world' });
  try {
    const data = await host.data('translate');
    assert.equal(data.text, 'hello world');
    assert.equal(data.busy, true, '该一边翻一边先把状态摆出来');
    assert.equal(data.target, TARGET_AUTO);
  } finally {
    await cleanup();
  }
});

test('翻译插件：翻完把译文推给界面', async () => {
  const { host, cleanup } = await makeHost({ inputText: 'hello world' });
  try {
    const pushed = [];
    host.attachBroadcaster((pluginId, kind, payload) =>
      pushed.push({ pluginId, kind, payload })
    );
    await host.data('translate');
    // 翻译是异步的：等它跑完。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const last = pushed[pushed.length - 1];
    assert.ok(last, '翻完要推一份给界面');
    assert.equal(last.pluginId, 'translate');
    assert.equal(last.payload.result, '译好的那句话');
    assert.equal(last.payload.busy, false);
  } finally {
    await cleanup();
  }
});

test('翻译插件：翻的引擎是设置里选的那个', async () => {
  let prompt = '';
  const assistant = fakeAssistant({
    complete: async (text) => {
      prompt = text;
      return { ok: true, text: '译好的那句话' };
    },
  });
  const { host, cleanup } = await makeHost({ assistant, inputText: 'hello world' });
  try {
    const result = await host.act('translate', 'translate', { text: 'hello world' });
    assert.equal(result.result, '译好的那句话');
    assert.match(prompt, /翻译成中文/);
  } finally {
    await cleanup();
  }
});

test('翻译插件：自动变量命名——默认关，开了才给命名', async () => {
  const assistant = fakeAssistant({
    complete: async () => ({ ok: true, text: 'user name' }),
  });
  const { host, cleanup } = await makeHost({ assistant, inputText: '用户名' });
  try {
    // 默认关：译文能当变量名也不给。
    const off = await host.act('translate', 'translate', { text: '用户名' });
    assert.equal(off.result, 'user name');
    assert.equal(off.autoVariableName, false);
    assert.equal(off.variables, null);

    // 开了：同一个译文这次给出两种写法。
    const on = await host.act('translate', 'setting', { key: 'autoVariableName', value: true, text: '用户名' });
    assert.equal(on.autoVariableName, true);
    assert.deepEqual(on.variables, { lower: 'userName', upper: 'UserName' });
  } finally {
    await cleanup();
  }
});

test('翻译插件：自动变量命名——中文译文不给命名', async () => {
  const assistant = fakeAssistant({
    complete: async () => ({ ok: true, text: '用户名' }),
  });
  const { host, cleanup } = await makeHost({ assistant, inputText: 'user name' });
  try {
    await host.act('translate', 'setting', { key: 'autoVariableName', value: true, text: 'user name' });
    const result = await host.act('translate', 'translate', { text: 'user name' });
    assert.equal(result.result, '用户名');
    assert.equal(result.variables, null);
  } finally {
    await cleanup();
  }
});

test('翻译插件：复制——写进剪贴板并回报', async () => {
  const written = [];
  globalThis.__deskPetTranslateClipboardWriter = async (text) => {
    written.push(text);
  };
  const { host, cleanup } = await makeHost({ inputText: 'hello world' });
  try {
    const result = await host.act('translate', 'copy', { text: 'userName' });
    assert.equal(result.copied?.ok, true);
    assert.equal(result.copied?.message, '已复制到剪贴板');
    assert.deepEqual(written, ['userName']);

    const empty = await host.act('translate', 'copy', { text: '  ' });
    assert.equal(empty.copied?.ok, false);
    assert.equal(written.length, 1, '空文字不该写剪贴板');
  } finally {
    delete globalThis.__deskPetTranslateClipboardWriter;
    await cleanup();
  }
});

test('翻译插件：复制——写不进去就说明白', async () => {
  globalThis.__deskPetTranslateClipboardWriter = async () => {
    throw new Error('剪贴板被占用');
  };
  const { host, cleanup } = await makeHost({ inputText: 'hello world' });
  try {
    const result = await host.act('translate', 'copy', { text: 'userName' });
    assert.equal(result.copied?.ok, false);
    assert.match(result.copied?.message || '', /剪贴板被占用/);
  } finally {
    delete globalThis.__deskPetTranslateClipboardWriter;
    await cleanup();
  }
});

test('翻译插件：公共接口引擎走的是公共接口', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => [[['你好', 'hello']]],
  });
  const { host, cleanup } = await makeHost({ inputText: 'hello world' });
  try {
    // 把引擎切成公共接口。
    await host.act('translate', 'setting', { key: 'engine', value: '公共接口' });
    const result = await host.act('translate', 'translate', { text: 'hello world' });
    assert.equal(result.result, '你好');
    assert.equal(result.engine, '公共接口');
  } finally {
    globalThis.fetch = original;
    await cleanup();
  }
});
