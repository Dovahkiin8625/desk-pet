import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPluginHost } from '../../src/main/plugins/host.js';

/**
 * 聊天记录插件（规格 §10.1）。
 *
 * 三件事最容易做错：
 * 1. **目录名必须等于清单里的 id**——对不上时插件被静默跳过，
 *    症状是「搜不到聊天记录」，而不是报错；
 * 2. **首份数据是全部记录**（不是最近几条）；
 * 3. **插件自己的页面要真的在磁盘上**——不在的话宿主退回积木界面，
 *    插件的页面就没人看。
 */

/** 仓库根目录（测试文件在 test/unit/ 下，往上两级）。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 把仓库里真的那个插件复制到临时目录（宿主只认自己根目录下的 plugins/）。 */
async function copyChatHistory(root) {
  const dir = join(root, 'plugins', 'chat-history');
  await cp(join(REPO_ROOT, 'plugins', 'chat-history'), dir, { recursive: true });
  return dir;
}

/** 一条记录。 */
function entry(kind, text, meta = {}) {
  return { id: `${kind}-${text}`, kind, role: kind === 'user' ? 'user' : 'assistant', text, at: 1, meta };
}

/** 一个假的 agent 接口：能读历史、能订阅事件。 */
function fakeAgent(entries = []) {
  const listeners = new Set();
  return {
    history: () => entries,
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (item) => {
      for (const cb of [...listeners]) cb(item);
    },
  };
}

/** 造一个只带聊天记录那几样的假助理。 */
function fakeAssistant(entries = []) {
  const agent = fakeAgent(entries);
  return {
    agent,
    clearChatHistory: () => ({ ok: true, message: '记录清空了' }),
  };
}

/** 造一个宿主（装着真的聊天记录插件）。 */
async function makeHost(assistant) {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-ch-'));
  const userData = await mkdtemp(join(tmpdir(), 'desk-pet-ch-ud-'));
  await copyChatHistory(root);
  const host = await createPluginHost({
    rootDir: root,
    userDataDir: userData,
    assistant,
    openSettings: () => {},
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

test('聊天记录插件：清单合法，目录名与 id 一致', async () => {
  const { host, cleanup } = await makeHost(fakeAssistant([]));
  try {
    const meta = host.list().find((p) => p.id === 'chat-history');
    assert.ok(meta, '聊天记录插件没被认出来');
    assert.equal(meta.name, '聊天记录');
    // 自带页面 → 面板上能分离成独立窗口。
    assert.equal(meta.hasPage, true);
    assert.match(meta.pageUrl, /chat-history\/pages\/history\.html/);
  } finally {
    await cleanup();
  }
});

test('聊天记录插件：首份数据是全部记录', async () => {
  const entries = [entry('user', '在吗'), entry('reply', '在呢'), entry('task', '进行中 · 查视频')];
  const { host, cleanup } = await makeHost(fakeAssistant(entries));
  try {
    const data = await host.data('chat-history');
    assert.equal(data.entries.length, 3);
    assert.equal(data.entries[0].text, '在吗');
  } finally {
    await cleanup();
  }
});

test('聊天记录插件：清空记录的动作真的清了', async () => {
  let cleared = false;
  const assistant = fakeAssistant([entry('user', '在吗')]);
  assistant.clearChatHistory = () => {
    cleared = true;
    return { ok: true, message: '记录清空了' };
  };
  const { host, cleanup } = await makeHost(assistant);
  try {
    const res = await host.act('chat-history', 'clear', null);
    assert.equal(cleared, true);
    assert.match(res.message, /清空/);
  } finally {
    await cleanup();
  }
});

test('聊天记录插件：记录一变就推给界面', async () => {
  const assistant = fakeAssistant([entry('user', '在吗')]);
  const { host, cleanup } = await makeHost(assistant);
  try {
    const pushed = [];
    host.attachBroadcaster((pluginId, kind, payload) =>
      pushed.push({ pluginId, kind, payload })
    );

    assistant.agent.emit(entry('reply', '在呢'));

    assert.deepEqual(pushed, [
      { pluginId: 'chat-history', kind: 'data', payload: { entries: [entry('reply', '在呢')] } },
    ]);
  } finally {
    await cleanup();
  }
});
