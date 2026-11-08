# agent 运行时 L5 · 界面（聊天记录插件化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「聊天记录」从面板里的内置功能改成**真插件**——它能按分类显示、能实时更新、能分离成独立窗口。

**Architecture:** 宿主给插件补一条 `ctx.push`（把数据推给自己的界面落点）；聊天记录插件拿 `ctx.agent.history()` 当首份快照、订阅 `ctx.agent.onEvent` 拿增量；**所有**聊天记录的写入收口到一个 `createRecordSink`，写一条就通知一次订阅者；页面把记录按 kind 分块画出来。

**Tech Stack:** Electron 主进程 + 普通 Node 模块（`node --test` 单元测试）+ 无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-07-agent-runtime-design.md` §4、§10（**L5 = 界面**：T15 / T16 / T17）。

---

## Global Constraints

- **注释与文档用中文。** 每个新文件开头一段块注释，说明「这是什么」和**「为什么这么写」**；反直觉的设计尤其要写清楚。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `fix(助手): …` / `test(助手): …` / `docs(助手): …`。
- **UI 界面上不出现代码逻辑的说明。** 页面只写用户看得懂的话（不写「kind: task」这种字段名）。
- **单元测试不引 electron。** `src/main/assistant/chat/`、`src/main/plugins/`、`plugins/chat-history/pages/groups.js` 全部要能在普通 node 里跑。
- **契约只有一份。** 「记录有哪些分类」放在 `src/shared/assistant.js`，主进程与插件页面都从那儿取。
- **不新增依赖。**
- **不重构与本计划无关的代码。** 每一处改动都要能指回规格的某一条。

---

## 与别的计划的交界（先对一遍，别打架）

| 别的计划 | 交界处 | 本计划怎么做 |
|---|---|---|
| `2026-11-08-two-layer-agent.md`（双层 agent，**进行中**） | 它��� Task 4 要在 `src/main/assistant/index.js` 里加一个具名的 `appendChatRecord` | **本计划先加**（Task 3），名字与职责一致：写一条记录 = 追加 + 落盘 + 通知订阅者。那个计划执行到 Task 4 时**直接复用**本计划这一个，不要再写第二份 |
| 同上 | 它的 Task 4 把完成通知写成一条 `reply` 记录 | 本计划的收口函数会自动把那条记录也通知出去——它的界面也就实时更新了 |
| 同上 | 它退役 `llm.backend`、加 `agent.dispatch` | 本计划不碰这两样 |
| `2026-11-07-agent-runtime-design.md` §4.2 | 记录的分类已有六种（多了一种 `dispatch`） | 本计划的页面**六种都认**：`user` / `reply` / `dispatch` / `task` / `step` / `approval` |

---

## Review Focus

规格没有穷举、但最容易咬人的五个输入/状况。每一条都落到下面某个任务的测试里。

1. **插件没接上推数据的通道就推数据**（`ctx.push` 在宿主建好之前被调用）——期望：不炸 quietly，推的数据丢掉；接上之后才真的送出去。→ Task 1 `plugin-host.test.js`「插件能通过 ctx.push 把数据推给自己的界面」
2. **推过去的数据没包信封**（页面收到的是裸数据）——期望：界面落点收到的是 `{pluginId, data}`，页面靠 pluginId 过滤串台。→ Task 1「推过去的数据真的到了界面落点」
3. **目录名与清单 id 对不上**——期望：插件被**静默跳过**（只剩一行日志），症状是「搜不到聊天记录」而不是报错。→ Task 2 `chat-history-plugin.test.js`「聊天记录插件：清单合法，目录名与 id 一致」
4. **通知给订阅者的不是规整后的那一条**（页面拿到的条目没有 id）——期望：订阅者拿到的是**规整后**的条目（带 id、带 kind），页面靠 id 去重、靠 kind 分区。→ Task 3 `agent-record-sink.test.js`「写一条记录：订阅者收到的是规整后的那一条」
5. **任务的过程散成一堆噪音**——期望：同一个任务的状态、步骤、审批合成一块，页面上才看得出「这件事干到哪了」。→ Task 4 `chat-history-view.test.js`「分组：对话一句一条，任务的过程合成一块」

---

## 文件地图

**新建**

| 文件 | 职责 |
|---|---|
| `src/main/assistant/chat/recordSink.js` | 写聊天记录的唯一入口：追加 + 按分类截断 + 通知订阅者 |
| `plugins/chat-history/plugin.json` | 聊天记录插件的清单 |
| `plugins/chat-history/main.js` | 首份快照 + 订阅增量 + 清空记录的动作 |
| `plugins/chat-history/pages/groups.js` | 把记录分块（纯函数，渲染层与单元测试共用） |
| `plugins/chat-history/pages/history.html` | 页面外壳 |
| `plugins/chat-history/pages/history.js` | 画记录、接推送、报高度 |
| `test/unit/agent-record-sink.test.js` | Task 3：写记录 → 通知订阅者 |
| `test/unit/chat-history-plugin.test.js` | Task 2 / Task 3：插件清单、首份数据、实时推送 |
| `test/unit/chat-history-view.test.js` | Task 4：记录的分组 |

**修改**

| 文件 | 改什么 |
|---|---|
| `src/main/plugins/host.js` | `ctx.push`；`attachBroadcaster` |
| `src/main/index.js` | 接上推数据的通道 |
| `src/main/builtins.js` | 撤掉「聊天记录」这个内置功能，只留「设置」 |
| `src/main/panel.js` | 内置功能只剩「设置」；`builtinPage` / `builtinAction` 撤掉 |
| `src/main/assistant/index.js` | 四个写入点收口到 `appendChatRecord`；不再把原始事件当记录推给插件 |
| `src/main/assistant/agent/facade.js` | `emit` 的语义写清楚：推的是**聊天记录条目** |
| `src/shared/plugin.js` | 注释里「内置功能（设置、聊天记录）」过时了，改掉 |
| `test/unit/builtins.test.js` | 只剩「设置」了 |
| `test/unit/plugin-host.test.js` | 加两条 `ctx.push` 的用例 |

---

## 名字约定（各任务共用，别改）

```js
// src/main/assistant/chat/recordSink.js
export function createRecordSink({ getMessages = () => [], setMessages = () => {}, onEntry = () => {} } = {})
  // → write(entry) → 规整后的那一条（带 id、带 kind）

// src/main/plugins/host.js
ctx.push(data)                                  // 推给自己的界面落点
host.attachBroadcaster((pluginId, kind, payload) => {})  // 接上通道

// plugins/chat-history/pages/groups.js
export function groupEntries(entries) → Array<block>
// block: { type: 'chat' | 'dispatch' | 'task' | ..., ... }
```

**推送的数据形状**：一律 `{ entries: [...] }`。
首份快照（`data()`）与后续推送**用同一个形状**——页面只有一条处理路径，
不用去猜「这次推的是全部还是一条」。

---

## Task 1: 宿主给插件加 `ctx.push`

**Files:**
- Modify: `src/main/plugins/host.js`
- Modify: `src/main/index.js`
- Test: `test/unit/plugin-host.test.js`

**Interfaces:**
- Consumes: 现有 `createSurfaceController` 的 `broadcast(pluginId, kind, payload)`
- Produces: `ctx.push(data)`、`host.attachBroadcaster(fn)`

- [ ] **Step 1: 写失败的测试**

在 `test/unit/plugin-host.test.js` 末尾追加两条（并补一个 import）：

```js
import { createSurfaceController } from '../../src/main/plugins/surface.js';
```

```js
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
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/plugin-host.test.js`
Expected: FAIL —— `host.attachBroadcaster is not a function`（宿主还没有这个口子）。

- [ ] **Step 3: 宿主加 `ctx.push`**

`src/main/plugins/host.js`：

1. 在 `let windowOpener = null;` 后面加：

```js
  /**
   * 把数据推给某个插件的界面落点。
   *
   * **接缝**：界面路由（surface.js）在宿主之后才建好，
   * 所以宿主先留一个口子（`ctx.push`），main/index.js 建好路由再接上
   * （`attachBroadcaster`）——与 `attachWindows` 同一个套路。
   */
  let broadcaster = null;
```

2. 在 `makeContext` 的返回对象里，`update:` 后面加：

```js
      /**
       * 把数据推给自己的界面（实时更新用）。
       *
       * **界面没开着时推了也没有地方去**——推不丢：
       * 界面打开时宿主会先给一份完整快照（`data()`），
       * 插件自己保证快照与推送说的是同一件事。
       */
      push(data) {
        broadcaster?.(record.manifest.id, 'data', data);
      },
```

3. 在返回对象里（`attachWindows` 旁边）加：

```js
    /**
     * 接上「推数据」的通道。
     *
     * 与 `attachWindows` 同一个套路：宿主比界面路由先建，
     * 晚建的那边来接上。
     */
    attachBroadcaster: (fn) => {
      broadcaster = typeof fn === 'function' ? fn : null;
    },
```

- [ ] **Step 4: 主进程接上通道**

`src/main/index.js`，在 `plugins.attachWindows(pluginWindows);` 后面加：

```js
  // 插件推数据的通道：接上界面路由。
  //
  // **晚一步接上**：界面路由（surface.js）在宿主之后才建好，
  // 所以宿主先留了 ctx.push 这个口子，这里把真正的通道接上去。
  plugins.attachBroadcaster((pluginId, kind, payload) => {
    pluginSurfaces?.broadcast(pluginId, kind, payload);
  });
```

- [ ] **Step 5: 跑测试，确认全绿**

Run: `node --test test/unit/plugin-host.test.js`
Expected: PASS（全部 ok）。

- [ ] **Step 6: 提交**

```bash
git add src/main/plugins/host.js src/main/index.js test/unit/plugin-host.test.js
git commit -m "feat(插件): 插件能通过 ctx.push 把数据推给自己的界面"
```

---

## Task 2: 聊天记录插件化

**Files:**
- Create: `plugins/chat-history/plugin.json`
- Create: `plugins/chat-history/main.js`
- Modify: `src/main/builtins.js`
- Modify: `src/main/panel.js`
- Modify: `src/shared/plugin.js`（过时的注释）
- Test: `test/unit/chat-history-plugin.test.js`（新建）
- Test: `test/unit/builtins.test.js`（改）

**Interfaces:**
- Consumes: Task 1 的 `ctx.push`；现有 `ctx.agent`（`history()` / `onEvent()`）、`ctx.assistant.clearChatHistory()`
- Produces: 插件 `chat-history`（清单 + 入口 + 页面外壳）；内置功能只剩 `settings`

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/chat-history-plugin.test.js`：

```js
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
  return { host, cleanup: async () => {
    await rm(root, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  } };
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
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/chat-history-plugin.test.js`
Expected: FAIL —— `ENOENT`（`plugins/chat-history` 还不存在）。

- [ ] **Step 3: 写清单**

新建 `plugins/chat-history/plugin.json`：

```json
{
  "id": "chat-history",
  "name": "聊天记录",
  "icon": "📜",
  "description": "和桌宠说过的话，还有它做过的事",
  "keywords": ["history", "chat", "record", "duihua", "liaotian", "jl", "聊天", "记录", "对话", "记忆", "任务"],
  "window": {
    "title": "聊天记录",
    "page": "pages/history.html",
    "width": 520,
    "height": 640,
    "refreshMs": 0
  }
}
```

- [ ] **Step 4: 写插件入口**

新建 `plugins/chat-history/main.js`：

```js
/**
 * 聊天记录（从内置功能变成插件）。
 *
 * ## 为什么改成插件
 *
 * 原来它是面板里的一个内置功能，只能用声明式积木画，
 * 只能显示「谁在什么时候说了什么」。agent 之后记录里会有任务、步骤、审批，
 * 它们要**分类显示**、要**实时更新**、还要能分离成独立窗口——
 * 声明式积木表达不了这些，做成插件它们是白送的。
 *
 * ## 数据从哪儿来
 *
 * - **首份快照**：`ctx.agent.history()`（全部记录）；
 * - **之后的增量**：订阅 `ctx.agent.onEvent`，一条记录进来就推给界面。
 *
 * 插件与宿主同生共死，所以订阅不用退订。
 */
export default function createChatHistoryPlugin(ctx) {
  const agent = ctx.agent;
  const assistant = ctx.assistant;

  // 记录一变就推给界面。
  agent.onEvent((entry) => ctx.push({ entries: [entry] }));

  return {
    /**
     * 首份快照：全部记录。
     *
     * 页面拿到它就把界面画出来；之后的推送接着往下加。
     */
    data: () => ({ entries: agent.history() }),

    /** 标题那几个字段（面板上显示的）。 */
    meta: () => ({
      title: '聊天记录',
      subtitle: `${agent.history().length} 条记录`,
    }),

    /**
     * 页面里的动作：清空记录。
     *
     * 清完由页面自己重新取一份快照（`data()` 这时返回空数组）。
     */
    act(actionCtx, actionId) {
      if (actionId !== 'clear') return null;
      const r = actionCtx.assistant.clearChatHistory();
      return { ok: true, message: r?.message || '记录清空了' };
    },
  };
}
```

- [ ] **Step 5: 撤掉内置的「聊天记录」**

`src/main/builtins.js` 整段替换为：

```js
/**
 * 内置功能。
 *
 * 「设置」**不是插件**：它是程序自带的一块功能，不能被关掉、
 * 也不住在插件目录里——所以它不进插件宿主，
 * 而是直接待在面板的搜索清单里。
 *
 * 「聊天记录」原来也是内置功能，现在**改成插件**了
 * （见 `plugins/chat-history/`）：它要按分类显示、要实时更新、
 * 还要能分离成独立窗口——这些用插件才做得出来。
 */
export const BUILTIN_SETTINGS = 'settings';

const FEATURES = Object.freeze([
  {
    id: BUILTIN_SETTINGS,
    name: '设置',
    icon: '⚙️',
    description: '桌宠的偏好与语音配置',
    keywords: ['settings', 'setting', 'shezhi', 'sz', '设置', '偏好', '配置'],
  },
]);

/**
 * 搜索清单用的形状。
 *
 * 字段与插件的元数据**刻意一致**（多出来的 builtin/canDetach/hasWidget
 * 是显式的「false」）：面板画结果时不分插件与内置功能，
 * 一视同仁地画，用户也分不出差别——本来就不该分得出。
 */
export function builtinFeatures() {
  return FEATURES.map((f) => ({
    ...f,
    canDetach: false,
    hasWidget: false,
    builtin: true,
  }));
}

/** 这个 id 是不是内置功能。 */
export function isBuiltin(id) {
  return FEATURES.some((f) => f.id === id);
}
```

`src/main/panel.js`：

1. import 改成：

```js
import { BUILTIN_SETTINGS, builtinFeatures, isBuiltin } from './builtins.js';
```

2. `openBuiltin` 改成：

```js
  /**
   * 打开一个内置功能。
   *
   * 现在只剩「设置」了：它开的是**另一个窗口**（设置窗口），
   * 面板这时候就该收起来，否则两块界面叠在一起，用户不知道该看哪儿。
   */
  function openBuiltin(pluginId) {
    if (pluginId === BUILTIN_SETTINGS) {
      hide();
      openSettings?.();
    }
  }
```

3. `handleAction` 里的内置分支改成：

```js
    // 内置功能没有动作（「设置」开的是另一个窗口）。
    if (isBuiltin(pluginId)) return;
```

（原来那一段调 `builtinAction` 的分支整段删掉。）

- [ ] **Step 6: 改掉过时的注释**

`src/shared/plugin.js` 的 `canDetach` 注释里那句：

```js
 * 内置功能（设置、聊天记录）不是插件，它们不走这条路——
 * 它们的元数据里 `canDetach` 是显式的 false（见 src/main/builtins.js）。
```

改成：

```js
 * 内置功能（设置）不是插件，它们不走这条路——
 * 它们的元数据里 `canDetach` 是显式的 false（见 src/main/builtins.js）。
```

- [ ] **Step 7: 改内置功能的测试**

`test/unit/builtins.test.js` 整段替换为：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_SETTINGS, builtinFeatures, isBuiltin } from '../../src/main/builtins.js';

/**
 * 内置功能的测试。
 *
 * 它们**不是插件**：不住在插件目录里、不能被关掉、
 * 也不出现在插件清单里——但它们要和插件一起出现在面板的搜索结果中，
 * 所以形状必须与插件的元数据一致。
 *
 * 「聊天记录」原来也是内置功能，现在改成插件了
 * （见 plugins/chat-history/），所以这里只剩「设置」。
 */

test('内置：设置在清单里，形状与插件一致', () => {
  const list = builtinFeatures();
  assert.deepEqual(list.map((f) => f.id), [BUILTIN_SETTINGS]);

  for (const f of list) {
    assert.ok(f.name, '得有个名字');
    assert.ok(f.icon, '得有个图标');
    assert.ok(Array.isArray(f.keywords) && f.keywords.length > 0, '得有关键词，不然搜不到');
    // 内置的不能分离成独立窗口/小部件——它们不是插件。
    assert.equal(f.canDetach, false);
    assert.equal(f.hasWidget, false);
    assert.equal(f.builtin, true);
  }
});

test('内置：认得出内置功能，认不出插件', () => {
  assert.equal(isBuiltin(BUILTIN_SETTINGS), true);
  assert.equal(isBuiltin('todos'), false);
  assert.equal(isBuiltin('chat-history'), false);
  assert.equal(isBuiltin(''), false);
});
```

- [ ] **Step 8: 跑测试，确认全绿**

Run: `node --test test/unit/chat-history-plugin.test.js test/unit/builtins.test.js test/unit/plugin-host.test.js`
Expected: PASS（全部 ok）。

- [ ] **Step 9: 提交**

```bash
git add plugins/chat-history src/main/builtins.js src/main/panel.js src/shared/plugin.js test/unit/chat-history-plugin.test.js test/unit/builtins.test.js
git commit -m "feat(助手): 聊天记录从内置功能改成插件"
```

---

## Task 3: 记录写进去就通知插件（实时追加）

**Files:**
- Create: `src/main/assistant/chat/recordSink.js`
- Modify: `src/main/assistant/index.js`（四个写入点收口；不再把原始事件当记录推出去）
- Modify: `src/main/assistant/agent/facade.js`（`emit` 的语义写清楚）
- Test: `test/unit/agent-record-sink.test.js`（新建）
- Test: `test/unit/chat-history-plugin.test.js`（加一条）

**Interfaces:**
- Consumes: `chat/memory.js` 的 `appendMessage` / `normalizeChatEntry`
- Produces: `createRecordSink({getMessages, setMessages, onEntry})` → `write(entry)`

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/agent-record-sink.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecordSink } from '../../src/main/assistant/chat/recordSink.js';

/**
 * 写聊天记录的唯一入口。
 *
 * 写一条要做三件事：追加、按分类截断、**通知订阅者**
 * （插件的聊天记录界面要实时更新——写一条就推一条）。
 *
 * 订阅者拿到的必须是**规整后**的那一条：
 * 页面靠 id 去重、靠 kind 分区，缺了 id 它就认不出是不是同一条。
 */
test('写一条记录：数组多了一条，订阅者收到规整后的那一条', () => {
  const seen = [];
  let messages = [];
  const write = createRecordSink({
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
    onEntry: (entry) => seen.push(entry),
  });

  const written = write({ role: 'user', text: '在吗' });

  assert.equal(messages.length, 1);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].id, '条目要有 id：页面靠它去重');
  assert.equal(seen[0].kind, 'user');
  assert.equal(seen[0].text, '在吗');
  // 通知给订阅者的与返回的是同一条。
  assert.equal(seen[0], written);
});

test('写一条记录：分类截断照旧（一条新步骤不挤掉最老的用户输入）', () => {
  let messages = [];
  const write = createRecordSink({
    getMessages: () => messages,
    setMessages: (next) => {
      messages = next;
    },
  });

  write({ kind: 'user', text: '最早那句话' });
  for (let i = 0; i < 45; i += 1) write({ kind: 'step', text: `第 ${i} 步`, meta: { taskId: 't-1' } });

  assert.ok(messages.some((m) => m.kind === 'user'), '最老的用户输入不该被步骤挤掉');
  assert.equal(messages.filter((m) => m.kind === 'step').length, 40, '步骤那一路有自己的上限');
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/agent-record-sink.test.js`
Expected: FAIL —— `Cannot find module '.../chat/recordSink.js'`。

- [ ] **Step 3: 写收口模块**

新建 `src/main/assistant/chat/recordSink.js`：

```js
import { appendMessage, normalizeChatEntry } from './memory.js';

/**
 * 聊天记录的写入口。
 *
 * 「写一条记录」要做三件事：追加、按分类截断、**通知订阅者**
 * （插件的聊天记录界面要实时更新——写一条就推一条）。
 *
 * ## 为什么单独一个文件
 *
 * `assistant/index.js` 引了 electron，在普通 node 里测不了；
 * 而「写一条就通知一次」这条规矩必须有人守。
 * 所以整件事搬到这里：不碰 electron，测得了。
 */
export function createRecordSink({
  getMessages = () => [],
  setMessages = () => {},
  onEntry = () => {},
} = {}) {
  /**
   * 写一条记录。
   *
   * @returns {object} 规整后的那一条（订阅者拿到的就是它）
   */
  return function write(entry) {
    const normalized = normalizeChatEntry(entry);
    setMessages(appendMessage(getMessages(), normalized));
    onEntry(normalized);
    return normalized;
  };
}
```

- [ ] **Step 4: 主进程收口**

`src/main/assistant/index.js`：

1. import 补上：

```js
import { createRecordSink } from './chat/recordSink.js';
```

2. 在 `const agentFacade = createAgentFacade({...});` 后面加：

```js
  /**
   * 写一条聊天记录。
   *
   * **所有写入都走它**——写一条就通知一次订阅者，
   * 插件的聊天记录界面要实时更新（规格 §10.2）。
   *
   * **收口的原因**：「记录什么时候多了一条」只有一个地方知道，
   * 就是写记录的地方。散着写，插件就只能轮询。
   */
  const appendChatRecord = createRecordSink({
    getMessages: () => state?.chat?.messages || [],
    setMessages: (messages) => {
      if (!state) return;
      state.chat.messages = messages;
      scheduleSave();
    },
    onEntry: (entry) => agentFacade.emit(entry),
  });
```

3. `createAgentTasks({...})` 里的 `appendRecord` 换成 `appendChatRecord`：

```js
    appendRecord: appendChatRecord,
```

（原来是内联的箭头函数：`state.chat.messages = appendMessage(...); scheduleSave();`——现在由收口的那一份负责。**不要留两份**。）

4. `createAgentTasks({...})` 里的 `onEvent: (event) => agentFacade.emit(event),` **删掉**。

   **为什么删**：接口现在推的是**聊天记录条目**，
   而这里是运行时的原始事件（task / step / approval）。
   两者混在一起，插件页面会收到认不出来的东西。
   那些事件已经被写成条目了（`tasks.js` 的 `publish` → `recordFor` → `appendRecord`），
   条目里什么都有（`meta` 里带着 taskId / status / tool）。

5. 对话路径里的 `onEvent: (event) => agentFacade.emit(event),`（`backend.chat({...})` 的参数里）**也删掉**——同一个理由。

6. 用户那句话的写入改成：

```js
    if (trigger === 'user') {
      appendChatRecord({
        role: 'user',
        text: content,
        at: Date.now(),
        proactive: false,
      });
      lastUserMessageAt = Date.now();
    }
```

（`scheduleSave()` 由收口的那一份负责，这里不再单独调。）

7. 桌宠答复的写入改成：

```js
    appendChatRecord({
      role: 'assistant',
      text: result.text,
      at: Date.now(),
      proactive: trigger === 'proactive',
    });
```

8. 启动时标「已中断」的写入改成：

```js
      for (const task of interrupted) {
        appendChatRecord(
          taskRecord({
            taskId: task.taskId,
            status: TASK_STATUS.INTERRUPTED,
            title: task.title,
          })
        );
      }
```

（后面那句 `if (interrupted.length > 0) scheduleSave();` 删掉——收口的那一份已经存了。）

- [ ] **Step 5: 把接口的语义写清楚**

`src/main/assistant/agent/facade.js`：

1. `emit` 的注释改成：

```js
    /**
     * 把一条**聊天记录条目**推给订阅者。
     *
     * 运行时（L3）每写一条记录就调它——插件的聊天记录界面
     * 靠它实时更新（规格 §10.2）。
     *
     * **推的是条目，不是运行时事件**：条目里有 kind、text、meta，
     * 页面拿到就能画；原始事件（task / step / approval）
     * 在写成条目之前是中间产物。
     */
    emit(entry) {
```

2. `onEvent` 的注释补一句：

```js
    /**
     * 订阅 agent 的动静。返回取消订阅的函数。
     *
     * **收到的是聊天记录条目**（带 kind / text / meta）：
     * 写一条记录就推一条，插件页面照着画就行。
     *
     * 订阅者抛异常不许带崩别人——一个插件的坏回调不该让
     * 另一个插件收不到事件。
     */
```

- [ ] **Step 6: 补一条插件侧的实时推送测试**

在 `test/unit/chat-history-plugin.test.js` 末尾追加：

```js
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
```

- [ ] **Step 7: 跑测试，确认全绿**

Run: `node --test test/unit/agent-record-sink.test.js test/unit/chat-history-plugin.test.js test/unit/agent-facade.test.js test/unit/agent-tasks.test.js test/unit/agent-record.test.js`
Expected: PASS（全部 ok）。

- [ ] **Step 8: 提交**

```bash
git add src/main/assistant/chat/recordSink.js src/main/assistant/index.js src/main/assistant/agent/facade.js test/unit/agent-record-sink.test.js test/unit/chat-history-plugin.test.js
git commit -m "feat(助手): 写一条记录就通知插件——聊天记录能实时更新"
```

---

## Task 4: 记录分类渲染

**Files:**
- Create: `plugins/chat-history/pages/groups.js`
- Create: `plugins/chat-history/pages/history.html`
- Create: `plugins/chat-history/pages/history.js`
- Test: `test/unit/chat-history-view.test.js`

**Interfaces:**
- Consumes: `CHAT_KIND`（`src/shared/assistant.js`）、`bindSurface()`（`src/renderer/ui/pluginPage.js`）
- Produces: `groupEntries(entries)`

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/chat-history-view.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { groupEntries } from '../../plugins/chat-history/pages/groups.js';

/**
 * 聊天记录的分块（规格 §10.4）。
 *
 * 记录有六种，两头看的人不一样：
 * - `user` / `reply`：对话，一句一条；
 * - `dispatch`：前台派了一个后台任务；
 * - `task` / `step` / `approval`：**同一个任务**的过程——
 *   散着看是一堆噪音，合起来才是「这件事干到哪了」。
 */

/** 一条记录。 */
function entry(kind, text, meta = {}) {
  return { id: `${kind}:${text}`, kind, role: 'assistant', text, at: 1, meta };
}

test('分组：对话一句一条，任务的过程合成一块', () => {
  const blocks = groupEntries([
    entry('user', '在吗'),
    entry('reply', '在呢'),
    entry('task', '进行中 · 查视频', { taskId: 't-1', title: '查视频', status: 'running' }),
    entry('step', 'fs.list', { taskId: 't-1', tool: 'fs.list' }),
    entry('approval', 'shell.exec：等你点头', { taskId: 't-1', tool: 'shell.exec' }),
    entry('dispatch', '派了个任务：查视频', { taskId: 't-1' }),
  ]);

  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].type, 'chat');
  assert.equal(blocks[1].type, 'chat');

  const task = blocks[2];
  assert.equal(task.type, 'task');
  assert.equal(task.taskId, 't-1');
  assert.equal(task.title, '查视频');
  assert.equal(task.statuses.length, 1);
  assert.equal(task.steps.length, 1);
  assert.equal(task.approvals.length, 1);

  // 派单是**前台**的事，不跟后台任务的过程混在一块。
  assert.equal(blocks[3].type, 'dispatch');
});

test('分组：同一个任务的步骤聚到同一块', () => {
  const blocks = groupEntries([
    entry('task', '排队中 · 查视频', { taskId: 't-1', title: '查视频' }),
    entry('step', 'fs.list', { taskId: 't-1' }),
    entry('task', '完成 · 查视频', { taskId: 't-1', title: '查视频', status: 'done' }),
    entry('step', 'fs.read', { taskId: 't-1' }),
    entry('task', '排队中 · 别的', { taskId: 't-2', title: '别的' }),
  ]);
  const tasks = blocks.filter((b) => b.type === 'task');
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].steps.length, 2);
  assert.equal(tasks[0].statuses.length, 2);
  assert.equal(tasks[1].taskId, 't-2');
});

test('分组：没有任务号的记录各归各的', () => {
  const blocks = groupEntries([
    entry('step', 'fs.list', {}),
    entry('user', '在吗'),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'step');
  assert.equal(blocks[1].type, 'chat');
});

test('分组：空记录不炸', () => {
  assert.deepEqual(groupEntries([]), []);
  assert.deepEqual(groupEntries(null), []);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/chat-history-view.test.js`
Expected: FAIL —— `Cannot find module '.../chat-history/pages/groups.js'`。

- [ ] **Step 3: 写分组模块**

新建 `plugins/chat-history/pages/groups.js`：

```js
/**
 * 把聊天记录分成块（页面照着块画）。
 *
 * ## 为什么要分组
 *
 * 记录有六种，看的人不一样：
 * - `user` / `reply`：对话，一句一条；
 * - `dispatch`：前台派了一个后台任务；
 * - `task` / `step` / `approval`：**同一个任务**的过程——
 *   散着看是一堆噪音，合起来才是「这件事干到哪了」。
 *
 * ## 纯函数
 *
 * 页面在渲染层跑，这里在普通 node 里跑——所以不碰 DOM，
 * 分组的规矩能直接被测。
 */

/** 这三种记录按任务号归到一块。 */
const TASK_KINDS = new Set(['task', 'step', 'approval']);

/**
 * 把记录分成块。
 *
 * @param {Array} entries 聊天记录（按时间先后）
 * @returns {Array} 块
 */
export function groupEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const blocks = [];
  const taskBlocks = new Map();

  for (const entry of list) {
    const kind = String(entry?.kind || '');
    const taskId = String(entry?.meta?.taskId || '');

    if (TASK_KINDS.has(kind) && taskId) {
      let block = taskBlocks.get(taskId);
      if (!block) {
        block = {
          type: 'task',
          id: `task:${taskId}`,
          taskId,
          title: '',
          statuses: [],
          steps: [],
          approvals: [],
        };
        taskBlocks.set(taskId, block);
        blocks.push(block);
      }
      if (kind === 'task') {
        block.statuses.push(entry);
        if (!block.title) block.title = String(entry?.meta?.title || '');
      } else if (kind === 'step') {
        block.steps.push(entry);
      } else {
        block.approvals.push(entry);
      }
      continue;
    }

    if (kind === 'user' || kind === 'reply') {
      blocks.push({ type: 'chat', id: String(entry?.id || ''), entry });
      continue;
    }
    blocks.push({ type: kind || 'other', id: String(entry?.id || ''), entry });
  }

  return blocks;
}
```

- [ ] **Step 4: 写页面外壳**

新建 `plugins/chat-history/pages/history.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>聊天记录</title>
    <link rel="stylesheet" href="/src/renderer/ui/theme.css" />
    <style>
      body {
        margin: 0;
        font: var(--dp-font);
        color: var(--dp-text);
        background: var(--dp-bg);
      }
      #wrap {
        display: flex;
        flex-direction: column;
        gap: var(--dp-gap);
        padding: 12px;
      }
      #head {
        display: flex;
        align-items: baseline;
        gap: var(--dp-gap);
      }
      #head h1 {
        margin: 0;
        font-size: 15px;
      }
      #count {
        color: var(--dp-text-soft);
        font-size: 12px;
      }
      #head .spacer {
        flex: 1;
      }
      #list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      /* 对话：用户靠右，桌宠靠左。 */
      .chat {
        max-width: 82%;
        padding: 7px 11px;
        border-radius: var(--dp-radius);
        background: var(--dp-surface);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .chat.user {
        align-self: flex-end;
        background: var(--dp-accent);
        color: var(--dp-accent-ink);
      }
      .chat.reply {
        align-self: flex-start;
      }
      /* 派单：前台的动作。 */
      .dispatch {
        padding: 6px 10px;
        border: 1px dashed var(--dp-border);
        border-radius: var(--dp-radius);
        color: var(--dp-text-soft);
        font-size: 12px;
      }
      /* 任务：一件事一卡。 */
      .task {
        border: 1px solid var(--dp-border-soft);
        border-radius: var(--dp-radius);
        background: var(--dp-surface);
        padding: 8px 10px;
      }
      .task > .title {
        font-weight: 600;
      }
      .task .status {
        color: var(--dp-text-soft);
        font-size: 12px;
        margin-top: 2px;
      }
      .task details {
        margin-top: 6px;
      }
      .task summary {
        cursor: pointer;
        color: var(--dp-text-soft);
        font-size: 12px;
      }
      .task ol {
        margin: 6px 0 0;
        padding-left: 20px;
        font-size: 12px;
        color: var(--dp-text-soft);
      }
      .task .approval {
        margin-top: 6px;
        padding: 6px 8px;
        border-left: 3px solid var(--dp-accent-strong);
        background: var(--dp-bg);
        font-size: 12px;
      }
      #empty {
        color: var(--dp-text-faint);
        text-align: center;
        padding: 24px 0;
      }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="head">
        <h1>聊天记录</h1>
        <span id="count"></span>
        <span class="spacer"></span>
        <button id="clear" class="dp-button" type="button">清空</button>
      </div>
      <div id="list"></div>
      <div id="empty">还没和桌宠聊过天</div>
    </div>
    <script type="module" src="history.js"></script>
  </body>
</html>
```

- [ ] **Step 5: 写页面的脚本**

新建 `plugins/chat-history/pages/history.js`：

```js
import { bindSurface } from '/src/renderer/ui/pluginPage.js';
import { groupEntries } from './groups.js';

/**
 * 聊天记录的页面。
 *
 * 页面只做三件事：
 * - 画记录（按分类分块，见 groups.js）；
 * - 接住宿主推来的新记录，追加到下面；
 * - 报自己的高度（面板的窗口是按内容撑开的）。
 *
 * **不用 innerHTML**：记录里全是用户与模型的原话，
 * 直接拼进 HTML 就是一个注入的口子。用 createElement + textContent。
 */

const surface = bindSurface();

/** 全部记录（按时间先后）。 */
let entries = [];
/** 已经显示过的条目 id：同一条不显示两遍。 */
const seen = new Set();

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');

/** 把一份记录并进来（重复的跳过）。 */
function merge(payload) {
  const list = Array.isArray(payload?.entries) ? payload.entries : [];
  for (const entry of list) {
    const id = String(entry?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
}

/** 清空重来。 */
function reset(payload) {
  entries = [];
  seen.clear();
  merge(payload);
}

/** 一个元素。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** 画一句对话。 */
function renderChat(entry) {
  return el('div', `chat ${entry.kind === 'user' ? 'user' : 'reply'}`, entry.text);
}

/** 画一次派单。 */
function renderDispatch(entry) {
  return el('div', 'dispatch', entry.text);
}

/** 画一个任务：状态一行一条，步骤可折叠，审批单列。 */
function renderTask(block) {
  const card = el('section', 'task');
  card.appendChild(el('div', 'title', block.title || `任务 ${block.taskId}`));
  for (const status of block.statuses) {
    card.appendChild(el('div', 'status', status.text));
  }
  if (block.steps.length) {
    const details = el('details');
    details.appendChild(el('summary', '', `步骤（${block.steps.length}）`));
    const ol = el('ol');
    for (const step of block.steps) {
      ol.appendChild(el('li', '', step.text));
    }
    details.appendChild(ol);
    card.appendChild(details);
  }
  for (const approval of block.approvals) {
    card.appendChild(el('div', 'approval', approval.text));
  }
  return card;
}

/** 画全部。 */
function render() {
  listEl.textContent = '';
  const blocks = groupEntries(entries);
  for (const block of blocks) {
    if (block.type === 'task') {
      listEl.appendChild(renderTask(block));
    } else if (block.type === 'chat') {
      listEl.appendChild(renderChat(block.entry));
    } else {
      listEl.appendChild(renderDispatch(block.entry));
    }
  }
  emptyEl.style.display = blocks.length ? 'none' : '';
  countEl.textContent = `${entries.length} 条`;
  reportHeight();
}

/**
 * 报高度：面板的窗口是按内容撑开的。
 *
 * 量**内容**的高度，不是视口的——视口至少那么高，
 * 报多了窗口就再也缩不回去。
 */
function reportHeight() {
  requestAnimationFrame(() => {
    const rect = document.body.getBoundingClientRect();
    const height = Math.ceil(Math.max(rect.height, document.body.scrollHeight));
    surface.setHeight(height);
  });
}

// 首份快照：打开时给一次。
void surface.data().then((payload) => {
  reset(payload);
  render();
});

// 之后的增量：一条记录进来就推一条。
surface.onData((payload) => {
  merge(payload);
  render();
});

// 清空记录：清完自己重新取一份快照。
document.getElementById('clear').addEventListener('click', async () => {
  await surface.act('clear');
  reset(await surface.data());
  render();
});
```

- [ ] **Step 6: 跑测试，确认全绿**

Run: `node --test test/unit/chat-history-view.test.js test/unit/chat-history-plugin.test.js`
Expected: PASS（全部 ok）。

- [ ] **Step 7: 跑全量单元测试**

Run: `npm run test:unit`
Expected: PASS（全部 ok，0 失败）。

- [ ] **Step 8: 提交**

```bash
git add plugins/chat-history/pages test/unit/chat-history-view.test.js
git commit -m "feat(助手): 聊天记录按分类渲染——任务的过程合成一块"
```

---

## 收尾

- [ ] **Step 1: 全量单元测试**

Run: `npm run test:unit`
Expected: PASS。

- [ ] **Step 2: 全量 e2e（回归）**

Run: `npm run test:e2e`
Expected: 与改动前一致（本机有两条已知必挂：剪贴板助手、录屏遮罩——见记忆里的两条）。

- [ ] **Step 3: 记一笔给双层 agent 计划**

在 `.superpowers/sdd/2026-11-08-two-layer-agent/progress.md` 的「任务进度」下面加一行：

```
- **L5 先加了 `appendChatRecord`**（`src/main/assistant/index.js`）：写一条记录 = 追加 + 落盘 + 通知订阅者。
  那个计划的 Task 4 要加的正是这个函数——**直接复用，不要再写第二份**。
```
