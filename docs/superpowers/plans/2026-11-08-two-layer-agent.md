# 双层 agent（交互层 + 执行层）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌宠的前台对话拆成两层——交互层（秒级回应、可派单）与执行层（后台长任务），让长任务的结果不再被用户中途搭话吞掉。

**Architecture:** 前台对话恒定走**交互层**后端（最多 3 步、只读快工具整轮 1 次、5 个任务管理工具不限次数）；耗时的事由交互层 `task.submit` 派成**后台任务**，由现有的 agent 循环 + 运行时在后台执行，完成后用不打断的气泡通知。聊天记录新增 `dispatch` 分类，模型上下文按层过滤（交互层看得见 dispatch，执行层看不见）。`llm.backend` 退役，换成 `agent.dispatch`（能否派单）。

**Tech Stack:** Electron 主进程 + 普通 Node 模块（`node --test` 单元测试）+ Playwright e2e；OpenAI 兼容协议客户端（`src/main/assistant/llm/openai.js`）；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-08-two-layer-agent-design.md`（设计规格，与本计划一起读）

---

## Global Constraints

- **注释与文档用中文。** 每个新文件开头一段块注释，说明「这是什么」和**「为什么这么写」**；反直觉的设计尤其要写清楚。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `fix(助手): …` / `test(助手): …` / `docs(助手): …`。
- **UI 界面上不出现代码逻辑的说明。** 设置页只写用户看得懂的后果（不写「agent.dispatch」这种字段名）。
- **单元测试不引 electron。** `src/main/assistant/layer/`、`src/main/assistant/chat/`、`src/main/assistant/agent/` 全部要能在普通 node 里跑。
- **契约只有一份。** 「有哪些派单模式」「哪些记录进哪一层的上下文」都放在 `src/shared/assistant.js`，主进程与设置页都从那儿取。
- **不新增依赖。** 用现成的 `node:test` 与 `@playwright/test`。
- **不重构与本计划无关的代码。** 每一处改动都要能指回规格的某一条。

---

## Review Focus

规格没有穷举、但最容易咬人的五个输入/状况。每一条都落到下面某个任务的测试里。

1. **交互层把不该派的单派出去了**（闲聊也派单，桌宠显得神经质）——期望：能自己答的先自己答，提示词里明确「派单前先自己答一次」。→ T2 `agent-interaction.test.js`「提示词：写着先自己答一次，别动不动就派单」。
2. **快工具失败后还在原地重试**（永远出不来，用户以为程序坏了）——期望：快工具整轮只有一次，失败即用掉配额，模型只能转派后台任务。→ T2 `agent-interaction.test.js`「快工具：失败的也算用掉配额」。
3. **归档掉的任务仍然算在「正在跑 N 个」里**（提示词预置的状态说谎）——期望：归档的任务不进列表、不进计数。→ T3 `agent-runtime-tasks.test.js`「计数：在跑的和排队的分开算，归档的不算」。
4. **steer 到达时任务的状态不对**（用户补了一句要求，却什么也没发生，用户以为坏了）——期望：任务**还在跑** → 收下；**刚好结束** → 丢弃但不报错（时序问题不是用户的错）；**已被取消** → 作废并返回 `{ok:false}`。→ T3 `agent-runtime-tasks.test.js`「steer：追加的要求能在任务里取出来」「steer：任务已经结束的，指令丢弃但不报错」「steer：任务被取消的，指令作废并返回失败」、T5 `agent-steer.test.js`「steer：任务被取消后队列作废」。
5. **模型不支持工具调用**（选了不支持 tools 的模型，用户只看到一句英文报错）——期望：这一轮退回普通对话，并明确告诉用户「这个模型不支持工具调用，先按普通对话来」。→ T4 `agent-two-layers.test.js`「模型不支持工具调用：这一轮退回普通对话，并告诉用户」。

---

## 文件地图

**新建**

| 文件 | 职责 |
|---|---|
| `src/main/assistant/layer/interaction.js` | 交互层后端：拼工具集、拼提示词、跑最多 3 步的循环 |
| `src/main/assistant/layer/fastTools.js` | 快工具白名单 + 整轮一次的配额计数 |
| `src/main/assistant/layer/prompt.js` | 交互层的系统提示词（人设 + 派单规则 + 实时状态） |
| `src/main/assistant/layer/taskTools.js` | 五个任务管理工具（submit / list / cancel / delete / steer） |
| `src/main/assistant/layer/foreground.js` | 前台那一轮的跑法：交互层优先，模型不支持工具时退回普通对话 |
| `src/main/assistant/chat/caller.js` | 「带着工具调一次模型」的共用件（请求体拼法只有一份） |
| `test/unit/agent-dispatch-record.test.js` | T1：dispatch 记录 + 按层过滤 |
| `test/unit/agent-interaction.test.js` | T2：快工具配额、预置提示词、轮次上限 |
| `test/unit/agent-runtime-tasks.test.js` | T3：运行时归档 / steer / 计数 |
| `test/unit/agent-task-tools.test.js` | T3：五个任务管理工具 |
| `test/unit/agent-two-layers.test.js` | T4：两层端到端 + 不支持工具的退路 |
| `test/unit/agent-steer.test.js` | T5：steer 在步骤边界注入 |
| `test/unit/dispatch-modes.test.js` | T6：派单模式契约 + 旧配置迁移 |
| `test/e2e/two-layer-agent.spec.js` | T4：派单 → 完成通知；中途搭话不丢结果；喊停任务 |

**修改**

| 文件 | 改什么 |
|---|---|
| `src/shared/assistant.js` | 加 `CHAT_KIND.DISPATCH`、`LAYER`、`CHAT_KIND_FOR_LAYER`；加 `DISPATCH_MODES` / `dispatchModeInfo`；`DEFAULT_AGENT.dispatch`；退役 `LLM_BACKENDS` / `DEFAULT_LLM.backend` |
| `src/main/assistant/chat/prompt.js` | `buildChatMessages` 改成按层过滤；新增 `buildHistoryMessages` |
| `src/main/assistant/chat/agent.js` | 导出 `fallbackText` / `translateError` / `isToolsUnsupportedError`；改用 `createModelCaller`；把 steer 传进循环 |
| `src/main/assistant/chat/caller.js` | （新建）见上 |
| `src/main/assistant/agent/record.js` | 新增 `dispatchRecord()` |
| `src/main/assistant/agent/runtime.js` | 任务加 `steerNotes` / `archived`；加 `steer()` / `archive()`；`list()` 默认不含归档 |
| `src/main/assistant/agent/tasks.js` | 加 `counts()` / `steer()` / `archive()`；`list()` 改成精简视图；去掉 `foreground`；被取消的任务不弹通知 |
| `src/main/assistant/agent/loop.js` | 加 `summarize` 开关与 `steer` 注入点 |
| `src/main/assistant/index.js` | 前台接交互层；删掉 `backends.register('agent')`；完成通知写成 `reply` 记录 |
| `src/main/assistant/state.js` | 删 `llm.backend`；加 `agent.dispatch` 的迁移 |
| `src/settings/index.html` | 「对话后端」下拉框 → 「桌宠能做什么」下拉框 |
| `src/settings/main.js` | 跟着改下拉框的填法、说明、摘要与补丁 |
| `test/unit/agent-task-record.test.js` | `CHAT_KIND_FOR_MODEL` → `CHAT_KIND_FOR_LAYER` |
| `test/unit/agent-backend.test.js` | 后端取值断言换成 dispatch 迁移断言 |
| `test/unit/agent-tasks.test.js` | 去掉「前台任务不通知」那条（`foreground` 已删） |
| `test/unit/llm-backends.test.js` | 改名 `test/unit/dispatch-modes.test.js`，内容重写 |
| `test/e2e/backend-select.spec.js` | 改名 `test/e2e/dispatch-mode.spec.js`，内容重写 |
| `docs/superpowers/specs/2026-11-07-agent-runtime-design.md` | 清掉 `llm.backend` 的旧说法 |

> **与规格的一处偏差（有意为之）**：规格 §10.1 列了 `assistant/agent/steer.js`（任务级指令队列）。实现上 steer 队列直接挂在任务对象上（`runtime.js` 里的 `task.steerNotes`），单独一个文件只是把一个数组包一层——所以不新建那个文件。规格 §10.2 说「`assistant/agent/runtime.js` 加 `steer(taskId, note)`、`archive(taskId)`」，本计划按 §10.2 走。

---

## 名字约定（各任务共用，别改）

跨任务引用的标识符只有这一份，动手前先对一遍：

```js
// src/shared/assistant.js
export const CHAT_KIND = Object.freeze({
  USER: 'user', REPLY: 'reply', TASK: 'task', STEP: 'step',
  APPROVAL: 'approval',
  DISPATCH: 'dispatch',            // 新增
});
export const CHAT_KIND_LIMITS = Object.freeze({
  user: 40, reply: 40, step: 200, task: 100, approval: 100,
  dispatch: 100,                    // 新增
});
export const LAYER = Object.freeze({ INTERACTION: 'interaction', EXECUTION: 'execution' });
export const CHAT_KIND_FOR_LAYER = Object.freeze({
  interaction: Object.freeze([CHAT_KIND.USER, CHAT_KIND.REPLY, CHAT_KIND.DISPATCH]),
  execution: Object.freeze([CHAT_KIND.USER, CHAT_KIND.REPLY]),
});
export const DISPATCH_MODES = Object.freeze(['auto', 'off']);
export function dispatchModeInfo(id) { /* 同 llmBackendInfo 的形状 */ }
```

```js
// src/main/assistant/chat/prompt.js
export function buildHistoryMessages({ history = [], layer = LAYER.INTERACTION } = {})  // → [{role, content}]
export function buildChatMessages({ history = [], userText = '', trigger = 'user', layer = LAYER.INTERACTION } = {})
```

```js
// src/main/assistant/agent/record.js
export function dispatchRecord({ tool = '', taskId = '', title = '', action = '', at = Date.now() } = {})
```

```js
// src/main/assistant/layer/fastTools.js
export const FAST_TOOL_NAMES = Object.freeze(['clock.now', 'clipboard.read', 'fs.read', 'fs.list']);
export const FAST_TOOL_LIMIT = 1;
export function createFastToolSet({ registry = null, limit = FAST_TOOL_LIMIT, now = () => new Date() } = {})  // → 工具描述符数组
```

```js
// src/main/assistant/layer/prompt.js
export function buildInteractionPrompt({ persona = {}, facts = [], now = new Date(), runningCount = 0, queuedCount = 0, dispatchEnabled = true, hasFastTools = true } = {})
```

```js
// src/main/assistant/layer/taskTools.js
export function createTaskTools({ tasks = null, turn = {}, dispatchEnabled = true, appendRecord = () => {}, now = () => Date.now() } = {})  // → 工具描述符数组
```

```js
// src/main/assistant/layer/interaction.js
export const INTERACTION_MAX_STEPS = 3;
export function createInteractionBackend({ fetchImpl = fetch, getRegistry = () => null, getTaskTools = () => [], getDispatchEnabled = () => true, getPersona = () => ({}), getFacts = () => [], getNow = () => new Date(), getTaskCounts = () => ({ running: 0, queued: 0 }), getMaxSteps = () => INTERACTION_MAX_STEPS, logger = null } = {})
```

```js
// src/main/assistant/layer/foreground.js
export async function runForeground({ interaction, plain, ctx, onFallback = null })
```

```js
// src/main/assistant/chat/caller.js
export function createModelCaller({ fetchImpl = fetch, minMaxTokens = 0 } = {})
```

```js
// src/main/assistant/chat/agent.js（新增导出）
export function fallbackText(run)
export function translateError(err, hadTools)
export function isToolsUnsupportedError(err)
```

```js
// src/main/assistant/agent/runtime.js（新增）
runtime.steer(taskId, note)   // → { ok, message? }
runtime.archive(taskId)       // → { ok, message? }
runtime.list({ includeArchived = false })
```

```js
// src/main/assistant/agent/tasks.js（新增）
tasks.counts()                // → { running, queued }
tasks.steer(taskId, note)
tasks.archive(taskId)
tasks.list()                  // → [{ taskId, title, status, lastStep, result, elapsedMs }]
```

---

## Task 1: 派单记录与按层过滤

**Files:**
- Modify: `src/shared/assistant.js`（`CHAT_KIND` / `CHAT_KIND_LIMITS` / 新的 `LAYER` / `CHAT_KIND_FOR_LAYER`；退役 `CHAT_KIND_FOR_MODEL`）
- Modify: `src/main/assistant/agent/record.js`（新增 `dispatchRecord`）
- Modify: `src/main/assistant/chat/prompt.js`（`buildHistoryMessages` + `buildChatMessages` 按层过滤）
- Modify: `test/unit/agent-task-record.test.js`（`CHAT_KIND_FOR_MODEL` → `CHAT_KIND_FOR_LAYER`）
- Test: `test/unit/agent-dispatch-record.test.js`

**Interfaces:**
- Consumes: 无（本计划第一个任务）
- Produces: `CHAT_KIND.DISPATCH`、`CHAT_KIND_LIMITS.dispatch`、`LAYER.INTERACTION/EXECUTION`、`CHAT_KIND_FOR_LAYER`、`dispatchRecord({tool, taskId, title, action, at})`、`buildHistoryMessages({history, layer})`、`buildChatMessages({history, userText, trigger, layer})`

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/agent-dispatch-record.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_KIND,
  CHAT_KIND_LIMITS,
  LAYER,
  CHAT_KIND_FOR_LAYER,
} from '../../src/shared/assistant.js';
import { dispatchRecord } from '../../src/main/assistant/agent/record.js';
import { appendMessage } from '../../src/main/assistant/chat/memory.js';
import {
  buildChatMessages,
  buildHistoryMessages,
} from '../../src/main/assistant/chat/prompt.js';

/**
 * 派单记录与「按层过滤」（规格 §6）。
 *
 * 两条规矩最容易做错：
 * 1. **交互层要看得见自己派过什么**——不然它下一句又派一遍单，
 *    用户会觉得「怎么一直在重复」；
 * 2. **执行层看不见 dispatch**——它不需要知道用户还派了别的任务，
 *    知道反而会分心。
 */

/** 造一段历史：用户的话、桌宠的话、一次派单、一条任务状态。 */
function sampleHistory() {
  let list = [];
  list = appendMessage(list, { kind: CHAT_KIND.USER, role: 'user', text: 'F 盘 video 下有什么' });
  list = appendMessage(list, { kind: CHAT_KIND.REPLY, role: 'assistant', text: '我去看看' });
  list = appendMessage(list, dispatchRecord({ tool: 'task.submit', taskId: 't-1', title: '查视频', action: '派了个任务' }));
  list = appendMessage(list, { kind: CHAT_KIND.TASK, role: 'assistant', text: '进行中 · 查视频', meta: { taskId: 't-1' } });
  list = appendMessage(list, { kind: CHAT_KIND.STEP, role: 'assistant', text: 'fs.list', meta: { taskId: 't-1' } });
  return list;
}

test('派单记录：分类是 dispatch，正文里带着任务号', () => {
  const entry = dispatchRecord({
    tool: 'task.submit',
    taskId: 't-42',
    title: '查视频',
    action: '派了个任务：查视频',
  });
  assert.equal(entry.kind, CHAT_KIND.DISPATCH);
  // 任务号必须在正文里：交互层下一轮要靠它说「停掉 t-42」。
  assert.match(entry.text, /t-42/);
  assert.equal(entry.meta.taskId, 't-42');
  assert.equal(entry.meta.tool, 'task.submit');
});

test('按层过滤：交互层看得见 dispatch，执行层看不见', () => {
  const history = sampleHistory();
  const inter = buildHistoryMessages({ history, layer: LAYER.INTERACTION }).map((m) => m.content);
  const exec = buildHistoryMessages({ history, layer: LAYER.EXECUTION }).map((m) => m.content);

  assert.ok(inter.some((t) => String(t).includes('t-1')), '交互层要看得见自己派过的单');
  assert.ok(!exec.some((t) => String(t).includes('t-1')), '执行层不该看见派单记录');
});

test('按层过滤：任务、步骤、审批两层都看不见', () => {
  const history = sampleHistory();
  for (const layer of [LAYER.INTERACTION, LAYER.EXECUTION]) {
    const texts = buildHistoryMessages({ history, layer }).map((m) => String(m.content));
    assert.ok(!texts.some((t) => t.includes('fs.list')), `${layer} 不该看见步骤`);
    assert.ok(!texts.some((t) => t.includes('进行中')), `${layer} 不该看见任务状态`);
  }
});

test('历史助手：只给历史，不带当前这句话', () => {
  const history = sampleHistory();
  const only = buildHistoryMessages({ history, layer: LAYER.INTERACTION });
  assert.ok(!only.some((m) => String(m.content).includes('再说一句')));
  // 带当前这句话时，它在最后。
  const withNow = buildChatMessages({ history, userText: '再说一句', layer: LAYER.INTERACTION });
  assert.equal(withNow.at(-1).role, 'user');
  assert.equal(withNow.at(-1).content, '再说一句');
});

test('分层的分类清单', () => {
  assert.deepEqual(
    [...CHAT_KIND_FOR_LAYER.interaction].sort(),
    [CHAT_KIND.USER, CHAT_KIND.REPLY, CHAT_KIND.DISPATCH].sort()
  );
  assert.deepEqual(
    [...CHAT_KIND_FOR_LAYER.execution].sort(),
    [CHAT_KIND.USER, CHAT_KIND.REPLY].sort()
  );
  assert.equal(CHAT_KIND_LIMITS.dispatch, 100);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/agent-dispatch-record.test.js`
Expected: FAIL —— `Cannot find module ... CHAT_KIND_FOR_LAYER`（导出还不存在）。

- [ ] **Step 3: 改共享契约**

`src/shared/assistant.js`：

1. 在 `CHAT_KIND` 里加一项：

```js
  /** 交互层的一次任务管理调用（派单 / 查看 / 停止 / 归档 / 追加指令）。 */
  DISPATCH: 'dispatch',
```

2. 在 `CHAT_KIND_LIMITS` 里加一项：

```js
  // 派单记录留 100 条：一条交互层对话最多派几个单，
  // 留少了模型会忘掉自己派过什么，重复派单。
  dispatch: 100,
```

3. 把 `CHAT_KIND_FOR_MODEL` 换成按层的清单：

```js
/**
 * 哪些分类进**哪一层**的模型上下文。
 *
 * ## 为什么不是「进不进上下文」这一个维度
 *
 * 有了两层之后，同一条记录对两层的意义不一样：
 * - `dispatch`（派单记录）：交互层**要**看得见（不然它重复派单），
 *   执行层**不**要看见（它只管自己那件事）；
 * - `task` / `step` / `approval`：两层都看不见——它们是给人看的，
 *   进了上下文会把对话冲垮，而且症状是「模型突然变笨」而不是报错。
 *
 * 定义只有一份：主进程拼上下文与设置页都从这儿取。
 */
export const LAYER = Object.freeze({
  /** 交互层：跟用户说话的那一层。 */
  INTERACTION: 'interaction',
  /** 执行层：后台干活的那一层。 */
  EXECUTION: 'execution',
});

export const CHAT_KIND_FOR_LAYER = Object.freeze({
  [LAYER.INTERACTION]: Object.freeze([CHAT_KIND.USER, CHAT_KIND.REPLY, CHAT_KIND.DISPATCH]),
  [LAYER.EXECUTION]: Object.freeze([CHAT_KIND.USER, CHAT_KIND.REPLY]),
});
```

（把原来的 `CHAT_KIND_FOR_MODEL` 整段删掉。）

- [ ] **Step 4: 加派单记录**

`src/main/assistant/agent/record.js` 末尾追加：

```js
/**
 * 交互层的一次任务管理调用（派单 / 查看 / 停止 / 归档 / 追加指令）。
 *
 * **正文里必须带任务号**：交互层下一轮要靠它说「停掉刚才那个」——
 * 没有任务号，它只能瞎猜一个。
 */
export function dispatchRecord({
  tool = '',
  taskId = '',
  title = '',
  action = '',
  at = Date.now(),
} = {}) {
  const name = String(tool || '任务');
  const id = String(taskId || '');
  const parts = [name, action];
  if (id) parts.push(`（任务 ${id}）`);
  return {
    kind: CHAT_KIND.DISPATCH,
    role: 'assistant',
    text: parts.filter(Boolean).join(' '),
    at,
    meta: { tool: name, taskId: id, title: String(title || ''), action: String(action || '') },
  };
}
```

- [ ] **Step 5: 提示词按层过滤**

`src/main/assistant/chat/prompt.js`：

1. 把 import 里的 `CHAT_KIND_FOR_MODEL` 换成 `CHAT_KIND_FOR_LAYER` 与 `LAYER`：

```js
import {
  EMOTIONS,
  PROMPT_HISTORY_MESSAGES,
  CHAT_KIND_FOR_LAYER,
  LAYER,
  chatKindOf,
} from '../../../shared/assistant.js';
```

2. 用下面这段替换 `buildChatMessages`（并在其前面新增 `buildHistoryMessages`）：

```js
/**
 * 从历史里挑出**这一层**该看见的对话。
 *
 * 「哪一层」是新的维度：交互层看得见自己派过什么（dispatch），
 * 执行层看不见（规格 §6）。
 *
 * **只取最近若干条**：磁盘上留的条数按分类分路（见 memory.js），
 * 提示词里只带 12 条——「记多少」与「发多少」是两回事。
 */
export function buildHistoryMessages({ history = [], layer = LAYER.INTERACTION } = {}) {
  const kinds = CHAT_KIND_FOR_LAYER[layer] || CHAT_KIND_FOR_LAYER[LAYER.INTERACTION];
  const list = Array.isArray(history) ? history : [];
  return list
    .filter((item) => item && item.text && kinds.includes(chatKindOf(item)))
    .slice(-PROMPT_HISTORY_MESSAGES)
    .map((item) => ({
      role: item.role === 'user' ? 'user' : 'assistant',
      content: item.text,
    }));
}

/**
 * 组装要发给接口的消息数组：历史 + 当前这一句。
 *
 * 历史里**不带**当前这句（调用方拿的是还没追加这句话的历史），
 * 否则模型会看到同一句话出现两次。
 */
export function buildChatMessages({
  history = [],
  userText = '',
  trigger = 'user',
  layer = LAYER.INTERACTION,
} = {}) {
  const messages = buildHistoryMessages({ history, layer });
  messages.push({
    role: 'user',
    content: trigger === 'proactive' ? PROACTIVE_TRIGGER : String(userText ?? ''),
  });
  return messages;
}
```

- [ ] **Step 6: 修掉引用旧导出的测试**

`test/unit/agent-task-record.test.js`：把 import 里的 `CHAT_KIND_FOR_MODEL` 换成 `CHAT_KIND_FOR_LAYER`，并把那条断言改成：

```js
  // 只有 user 与 reply 两种分类进**任何一层**的上下文；
  // dispatch 只进交互层（见 agent-dispatch-record.test.js）。
  assert.ok(
    [...CHAT_KIND_FOR_LAYER.execution].every(
      (k) => k === CHAT_KIND.USER || k === CHAT_KIND.REPLY
    )
  );
```

- [ ] **Step 7: 跑测试，确认全绿**

Run: `node --test test/unit/agent-dispatch-record.test.js test/unit/agent-task-record.test.js test/unit/agent-record.test.js`
Expected: PASS（全部 ok）。

- [ ] **Step 8: 提交**

```bash
git add src/shared/assistant.js src/main/assistant/agent/record.js src/main/assistant/chat/prompt.js test/unit/agent-dispatch-record.test.js test/unit/agent-task-record.test.js
git commit -m "feat(助手): 加派单记录与按层过滤"
```

---

## Task 2: 交互层后端（快工具配额 + 预置提示词）

**Files:**
- Create: `src/main/assistant/chat/caller.js`
- Create: `src/main/assistant/layer/fastTools.js`
- Create: `src/main/assistant/layer/prompt.js`
- Create: `src/main/assistant/layer/interaction.js`
- Modify: `src/main/assistant/chat/agent.js`（改用 `createModelCaller`；导出 `fallbackText` / `translateError` / `isToolsUnsupportedError`）
- Modify: `src/main/assistant/agent/loop.js`（加 `summarize` 开关）
- Test: `test/unit/agent-interaction.test.js`

**Interfaces:**
- Consumes: T1 的 `LAYER` / `CHAT_KIND_FOR_LAYER`；现有 `createAgentLoop` / `chatCompletionStreamWithProbe` / `parseReply` / `createStreamSplitter`
- Produces: `createModelCaller({fetchImpl, minMaxTokens})`、`FAST_TOOL_NAMES`、`FAST_TOOL_LIMIT`、`createFastToolSet({registry, limit, now})`、`buildInteractionPrompt({...})`、`INTERACTION_MAX_STEPS`、`createInteractionBackend({...})`、`fallbackText(run)`、`translateError(err, hadTools)`、`isToolsUnsupportedError(err)`；`createAgentLoop` 新增 `summarize`（默认 `true`）选项

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/agent-interaction.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionBackend } from '../../src/main/assistant/layer/interaction.js';

/**
 * 交互层（规格 §4）。
 *
 * 三件事最容易做错：
 * 1. **快工具整轮只有一次**——不靠提示词自觉，靠执行器强制；
 * 2. **配额按尝试计数**——失败的快工具也算用掉了，
 *    失败之后的唯一出路是转派后台任务，不是重试；
 * 3. **实时状态写在提示词里**——「现在几点」「还有几个任务在跑」
 *    不该花一次工具调用。
 */

const CONFIG = {
  apiKey: 'k',
  baseUrls: ['http://stub/v1'],
  model: 'stub-model',
  temperature: 0.7,
  maxTokens: 800,
  maxTokensField: 'max_tokens',
};

/** 造一个假接口：按顺序回预设的响应。 */
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

/** 造一句「调工具」的响应。 */
function toolCall(name, args = {}) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

/** 造一句「说点什么」的响应。 */
function say(text) {
  return { choices: [{ message: { content: text } }] };
}

/** 造一个假工具表。 */
function fakeRegistry(tools = []) {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n) => map.get(n) || null, list: () => [...map.values()] };
}

/** 一个能列目录的假工具。 */
function listTool(overrides = {}) {
  return {
    name: 'fs.list',
    label: '列目录',
    description: '列出一个目录里的内容',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => ({ text: 'a.txt' }),
    ...overrides,
  };
}

test('快工具：整轮只能用一次，第二次被拒', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('clock.now'),
    toolCall('fs.list'),
    say('现在十点。'),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '现在几点' }],
    config: CONFIG,
  });

  assert.equal(result.steps, 3);
  // 第二次快工具被拒了：那一句拒绝要喂回模型。
  //
  // **看的是第三次请求**：拒绝发生在第二步（跑工具的时候），
  // 它的内容要等下一次调模型才进上下文——所以在第三次请求里。
  const third = calls[2].body.messages;
  assert.ok(
    third.some((m) => String(m.content).includes('这一轮只能用一次快工具')),
    '第二次快工具没有被拒'
  );
  assert.equal(result.text, '现在十点。');
});

test('快工具：失败的也算用掉配额', async () => {
  const failing = listTool({
    run: async () => {
      throw new Error('列不了那个目录');
    },
  });
  const { calls, fetchImpl } = fakeFetch([
    toolCall('fs.list'),
    toolCall('fs.list'),
    say('那个目录我打不开。'),
  ]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([failing]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '列一下 D 盘' }],
    config: CONFIG,
  });

  // 第一次失败；第二次**不是**再试一次，而是被配额拦住。
  //
  // **看的是第三次请求**：配额拒绝是在第二步跑工具时发生的，
  // 它的内容要等下一次调模型才进上下文。
  const third = calls[2].body.messages;
  assert.ok(
    third.some((m) => String(m.content).includes('这一轮只能用一次快工具')),
    '失败的快工具没有消耗掉配额'
  );
});

test('提示词：预置了时间与在跑的任务数', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
    getTaskCounts: () => ({ running: 2, queued: 1 }),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '有几次任务在跑' }],
    config: CONFIG,
  });

  const system = calls[0].body.messages[0].content;
  assert.ok(
    system.includes('后台正在跑 2 个任务，排队 1 个'),
    `提示词里没有实时状态：\n${system}`
  );
  // 现在几点不用花工具调用：日期就写在提示词里。
  assert.match(system, /\d{4} 年 \d{1,2} 月 \d{1,2} 日/);
});

test('提示词：写着先自己答一次，别动不动就派单', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
  });
  const system = calls[0].body.messages[0].content;
  assert.ok(system.includes('先自己答一次'), `提示词没写清楚派单条件：\n${system}`);
});

test('轮次上限：3 步还没给答复就收尾，不空着', async () => {
  // 每次都调工具：模型一直没交卷。
  const { fetchImpl } = fakeFetch([toolCall('clock.now')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '做点什么' }],
    config: CONFIG,
  });
  assert.equal(result.steps, 3);
  assert.match(result.text, /没能在这 3 步之内/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/agent-interaction.test.js`
Expected: FAIL —— `Cannot find module '.../layer/interaction.js'`。

- [ ] **Step 3: 抽出「带工具调一次模型」的共用件**

新建 `src/main/assistant/chat/caller.js`：

```js
import { chatCompletionStreamWithProbe } from '../llm/openai.js';

/**
 * 造一个「带着工具调一次模型」的函数（给 agent 循环用）。
 *
 * ## 为什么要单独一个文件
 *
 * 执行层（chat/agent.js）与交互层（layer/interaction.js）都要
 * 「带工具调一次模型」——请求体的拼法必须两处**完全一致**：
 * 只发一个 token 字段、空的 `tools` 不发、think 参数怎么处理。
 * 各写一份的话，改了一处忘了另一处，
 * 症状是「某个后端的工具参数莫名其妙坏了」，极难查。
 *
 * 两边的差别只有两处，都由参数控制：
 * - token 下限（执行层要 2048，交互层按普通对话）；
 * - 传进来的 config。
 */
export function createModelCaller({ fetchImpl = fetch, minMaxTokens = 0 } = {}) {
  return async function callModel(
    { system = '', messages = [], tools = [], onDelta = null, signal = null } = {},
    config = {}
  ) {
    const result = await chatCompletionStreamWithProbe(
      {
        apiKey: config.apiKey,
        model: config.model,
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: config.temperature,
        maxTokens: Math.max(Number(config.maxTokens) || 0, minMaxTokens),
        maxTokensField: config.maxTokensField,
        // think 模式：模型先思考再回答（关着时只是一个「不要思考」）。
        think: config.think,
        tools,
      },
      { fetchImpl, baseUrls: config.baseUrls, signal, onDelta }
    );
    return { text: result.text, toolCalls: result.toolCalls, baseUrl: result.baseUrl };
  };
}
```

- [ ] **Step 4: 快工具与配额**

新建 `src/main/assistant/layer/fastTools.js`：

```js
import { TOOL_RISK } from '../../../shared/assistant.js';

/**
 * 交互层的快工具（规格 §4.1、§4.2）。
 *
 * 「快」= 瞬时、只读、毫秒级——这是交互层能保持秒级的**唯一原因**。
 * 「最多一次」由这里的执行器强制，**不靠提示词自觉**：
 * 提示词只是提醒，执行器才是保证。
 */

/** 快工具白名单：只读、瞬时。 */
export const FAST_TOOL_NAMES = Object.freeze([
  'clock.now',
  'clipboard.read',
  'fs.read',
  'fs.list',
]);

/** 一轮对话里快工具合计能用几次。 */
export const FAST_TOOL_LIMIT = 1;

/** 配额用完时给模型的话。 */
const QUOTA_REFUSAL =
  '这一轮只能用一次快工具，请直接给出答复；' +
  '要动手就派一个后台任务（task.submit）。';

/** 把时间格式化成人看得懂的一行。 */
function formatNow(when) {
  const d = when instanceof Date ? when : new Date(when);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * 造这一轮的快工具集。
 *
 * **配额按尝试计数，失败也算用掉**：失败之后的唯一出路是转派后台任务，
 * 不是重试（规格 §4.2）。所以计数在**调用之前**加。
 *
 * 计数是**每轮重置**的：`createFastToolSet` 每轮调一次，
 * 计数器就是那一轮一个。
 *
 * @param {object} options
 * @param {object} [options.registry] 工具表（取 fs.read / fs.list / clipboard.read）
 * @param {number} [options.limit] 整轮配额
 * @param {Function} [options.now] 取当前时刻
 */
export function createFastToolSet({
  registry = null,
  limit = FAST_TOOL_LIMIT,
  now = () => new Date(),
} = {}) {
  /** 这一轮已经试过几次快工具（所有快工具合计，不分工具）。 */
  let attempts = 0;

  /** 时钟工具：内置工具表里没有，这里就地造一个。 */
  const clockTool = {
    name: 'clock.now',
    label: '当前时间',
    description: '取当前时间（精确到分钟）。',
    parameters: { type: 'object', properties: {}, required: [] },
    risk: TOOL_RISK.READ,
    async run() {
      const when = now();
      return { text: formatNow(when), data: { at: new Date(when).toISOString() } };
    },
  };

  const tools = [];
  for (const name of FAST_TOOL_NAMES) {
    const tool = name === 'clock.now' ? clockTool : registry?.get?.(name) || null;
    if (!tool) continue;
    tools.push({
      ...tool,
      run: async (args, ctx) => {
        attempts += 1;
        if (attempts > limit) throw new Error(QUOTA_REFUSAL);
        return tool.run(args, ctx);
      },
    });
  }
  return tools;
}
```

- [ ] **Step 5: 交互层的提示词**

新建 `src/main/assistant/layer/prompt.js`：

```js
import { buildSystemPrompt } from '../chat/prompt.js';

/**
 * 交互层的系统提示词（规格 §4.3、§4.5）。
 *
 * 每轮重建，尾部拼一段**实时状态**：
 *
 * ```
 * 后台正在跑 2 个任务，排队 0 个。
 * 对话模式：可以派单（task.submit）。
 * ```
 *
 * 所以「现在几点」「还有几个任务在跑」**不需要任何工具调用**。
 */
export function buildInteractionPrompt({
  persona = {},
  facts = [],
  now = new Date(),
  runningCount = 0,
  queuedCount = 0,
  dispatchEnabled = true,
  hasFastTools = true,
} = {}) {
  return [
    buildSystemPrompt({ persona, facts, now }),
    '',
    '你这轮的职责：先试着直接回答用户，别动不动就派单。',
    '- 能自己答的（聊天、你知道的事、本提示词里写着的状态）就直接答。',
    '- 要查本机、要动手、要跑一会儿的，才派后台任务（task.submit）。',
    '- 派单前**先自己答一次**：能答就别派。',
    '- 同一个需求别重复派：你派过的单在上面的对话里写着。',
    '- 快工具失败了就别重试：转成后台任务（task.submit）。',
    '实时状态：',
    `- 后台正在跑 ${Number(runningCount) || 0} 个任务，排队 ${Number(queuedCount) || 0} 个。`,
    `- 对话模式：${dispatchEnabled ? '可以派单（task.submit）' : '不能派单，只有快工具'}。`,
    hasFastTools
      ? '- 快工具（整轮只能用一次）：clock.now / clipboard.read / fs.read / fs.list。'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
```

- [ ] **Step 6: 给循环加「不做总结那一轮」的开关**

`src/main/assistant/agent/loop.js`：

1. 在 `createAgentLoop({...})` 的参数里加一项：

```js
  /**
   * 步数用尽时要不要再让模型总结一次。
   *
   * 执行层要（用户得知道做到哪一步了）；交互层不要——
   * 它要的是秒级回应，多一次模型往返就慢一倍（规格 §4.2）。
   */
  summarize = true,
```

2. 把总结那一段的判断改成：

```js
    if (outcome === AGENT_OUTCOME.MAX_STEPS && finalText === '' && !signal?.aborted && summarize) {
```

- [ ] **Step 7: 写交互层后端**

新建 `src/main/assistant/layer/interaction.js`：

```js
import { createAgentLoop } from '../agent/loop.js';
import { createModelCaller } from '../chat/caller.js';
import { createStreamSplitter, parseReply } from '../chat/prompt.js';
import { fallbackText, translateError } from '../chat/agent.js';
import { createFastToolSet } from './fastTools.js';
import { buildInteractionPrompt } from './prompt.js';

/**
 * 交互层后端（规格 §3、§4）。
 *
 * ## 它是唯一跟用户说话的那一层
 *
 * 执行层只产出结果，不说话。交互层负责：
 * - 秒级回应（最多 3 步、快工具整轮 1 次）；
 * - 判断该不该派单；
 * - 管后台任务（派单 / 查看 / 停止 / 归档 / 追加指令）。
 *
 * ## 为什么复用 agent 循环
 *
 * 循环那套「每个 tool_call 都要配一条 tool 消息」「工具出错喂回模型」
 * 的规矩，交互层一个字都不能改（改了模型就会开始说胡话）。
 * 所以直接用 `createAgentLoop`，只换提示词、工具与步数上限。
 */

/** 交互层一轮最多走几步。 */
export const INTERACTION_MAX_STEPS = 3;

/**
 * 造一个交互层后端。
 *
 * @param {object} options
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.getRegistry] 工具表（取快工具）
 * @param {Function} [options.getTaskTools] (turn) => 任务管理工具数组
 * @param {Function} [options.getDispatchEnabled] 能不能派单
 * @param {Function} [options.getPersona]
 * @param {Function} [options.getFacts]
 * @param {Function} [options.getNow]
 * @param {Function} [options.getTaskCounts] () => {running, queued}
 * @param {number|Function} [options.getMaxSteps]
 */
export function createInteractionBackend({
  fetchImpl = fetch,
  getRegistry = () => null,
  getTaskTools = () => [],
  getDispatchEnabled = () => true,
  getPersona = () => ({}),
  getFacts = () => [],
  getNow = () => new Date(),
  getTaskCounts = () => ({ running: 0, queued: 0 }),
  getMaxSteps = () => INTERACTION_MAX_STEPS,
  logger = null,
} = {}) {
  return {
    id: 'interaction',
    label: '交互层',

    async chat(ctx) {
      const { messages = [], config = {}, onDelta, turn = {} } = ctx || {};
      const registry = getRegistry();
      const dispatchEnabled = Boolean(getDispatchEnabled());

      // **每轮新建**：快工具的配额是「每轮一次」，计数器必须每轮归零。
      const fastTools = createFastToolSet({ registry, now: getNow });
      // 关了派单就**不把任务管理工具给模型**：
      // 给了它就会去调，然后被拒——白白浪费一轮。
      const taskTools = dispatchEnabled ? getTaskTools(turn) : [];
      const tools = [...fastTools, ...taskTools];
      const toolMap = new Map(tools.map((t) => [t.name, t]));

      const counts = getTaskCounts() || {};
      const system = buildInteractionPrompt({
        persona: getPersona(),
        facts: getFacts(),
        now: getNow(),
        runningCount: counts.running || 0,
        queuedCount: counts.queued || 0,
        dispatchEnabled,
        hasFastTools: fastTools.length > 0,
      });

      // **流式正文与元数据要分开**：模型会在正文后面接一段 <<META>> 的 JSON，
      // 那段不能显示在气泡里。
      const splitter = createStreamSplitter();
      const callModel = createModelCaller({ fetchImpl });

      const loop = createAgentLoop({
        callModel: (params) => callModel(params, config),
        resolveTool: (name) => toolMap.get(name) || null,
        // **不设闸门**：交互层的工具全是瞬时只读或任务管理，不需要用户点头。
        gate: null,
        maxSteps: getMaxSteps(),
        // 步数用尽时不做总结那一轮：交互层要的是秒级回应。
        summarize: false,
        logger,
      });

      let run;
      try {
        run = await loop.run({
          system,
          messages,
          tools,
          onDelta: (delta) => {
            const out = splitter.push(delta);
            if (out) onDelta?.(out);
          },
        });
      } catch (err) {
        // 「模型不支持工具调用」在这里被翻译成人话（规格 §10.4）。
        throw translateError(err, tools.length > 0);
      }

      const tail = splitter.finish();
      if (tail) onDelta?.(tail);

      const parsed = parseReply(run.text || '');
      return {
        text: parsed.text || fallbackText(run),
        emotion: parsed.emotion,
        mood: parsed.mood,
        memories: parsed.memories,
        baseUrl: run.baseUrl,
        steps: run.steps,
        outcome: run.outcome,
      };
    },
  };
}
```

- [ ] **Step 8: 让执行层复用共用件，并导出三个函数**

`src/main/assistant/chat/agent.js`：

1. 顶部加 import：

```js
import { createModelCaller } from './caller.js';
```

2. 把 `createAgentLoop` 里的 `callModel` 换成共用件。删掉原来那整段内联的 `callModel: async ({...}) => {...}`，改成：

```js
      const callModel = createModelCaller({
        fetchImpl,
        minMaxTokens: AGENT_MIN_MAX_TOKENS,
      });

      const loop = createAgentLoop({
        callModel: (params) => callModel(params, config),
        resolveTool: (name) =>
          registry && typeof registry.get === 'function' ? registry.get(name) : null,
        gate,
        maxSteps: getMaxSteps(),
        onEvent,
        logger,
      });
```

3. 把 `fallbackText`、`translateError` 改成导出，另加一个导出的 `isToolsUnsupportedError`，
   并把翻译后的那句改成新文案：

```js
export function fallbackText(run) {
  if (run.outcome === AGENT_OUTCOME.MAX_STEPS) {
    return `我没能在这 ${run.steps} 步之内做完这件事，先停下了。`;
  }
  if (run.outcome === AGENT_OUTCOME.REPEATED_ERRORS) {
    return `这个工具连着出了几次错，我先停下了：${run.error || ''}`;
  }
  if (run.outcome === AGENT_OUTCOME.ABORTED) {
    return '这件事取消了。';
  }
  return '我没能完成这件事。';
}

export function translateError(err, hadTools) {
  if (hadTools && isToolsUnsupportedError(err)) {
    return new LlmError(
      '这个模型不支持工具调用，先按普通对话来。',
      { code: LLM_ERRORS.BAD_REQUEST, status: err.status, body: err.body }
    );
  }
  return err;
}

/**
 * 这个错误是不是「模型不认工具调用」？
 *
 * **不能见 400 就这么说**：上下文超长、参数不对、额度用完也都是 400。
 * 照着「换个模型」去折腾，用户真正的问题一个字都没被说到。
 */
export function isToolsUnsupportedError(err) {
  if (!(err instanceof LlmError) || err.code !== LLM_ERRORS.BAD_REQUEST) return false;
  return mentionsTools(err);
}

/** 错误原文里有没有提到「工具」——只有提到才该翻译成「模型不支持工具调用」。 */
function mentionsTools(err) {
  const text = `${err?.message || ''} ${err?.body || ''}`.toLowerCase();
  return /tool|function_call|工具/.test(text);
}
```

（`mentionsTools` 保持私有即可；`isToolsUnsupportedError` 是对外的那个。）

- [ ] **Step 9: 跑测试，确认全绿**

Run: `node --test test/unit/agent-interaction.test.js test/unit/agent-backend.test.js test/unit/agent-loop.test.js`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/main/assistant/chat/caller.js src/main/assistant/chat/agent.js src/main/assistant/agent/loop.js src/main/assistant/layer/ test/unit/agent-interaction.test.js
git commit -m "feat(助手): 交互层后端——快工具配额与预置提示词"
```

## Task 3: 五个任务管理工具（运行时归档 / steer / 计数）

**Files:**
- Modify: `src/main/assistant/agent/runtime.js`（`steerNotes` / `archived` / `steer()` / `archive()` / `list({includeArchived})`）
- Modify: `src/main/assistant/agent/tasks.js`（`counts()` / `steer()` / `archive()`；`list()` 改成精简视图）
- Create: `src/main/assistant/layer/taskTools.js`
- Test: `test/unit/agent-runtime-tasks.test.js`、`test/unit/agent-task-tools.test.js`

**Interfaces:**
- Consumes: T1 的 `dispatchRecord`；T2 的 `buildHistoryMessages`（在 `chat/prompt.js` 里）；T1 的 `LAYER`
- Produces: `runtime.steer(taskId, note)`、`runtime.archive(taskId)`、`runtime.list({includeArchived})`、`scope.steer()`；`tasks.counts()`、`tasks.steer()`、`tasks.archive()`、`tasks.list()`（精简视图）；`createTaskTools({tasks, turn, dispatchEnabled, appendRecord, now})`

- [ ] **Step 1: 写失败的测试（运行时）**

新建 `test/unit/agent-runtime-tasks.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../src/main/assistant/agent/runtime.js';
import { createAgentTasks } from '../../src/main/assistant/agent/tasks.js';

/**
 * 运行时与任务中枢的新增能力（规格 §6.2、§5.2）。
 *
 * 三件事最容易做错：
 * 1. **归档只影响可见性**：记录要留着（那是安全审计），只是不再出现在列表里；
 * 2. **归档不了还在跑的任务**：要先停掉；
 * 3. **steer 到达时任务已经结束**：要明确说「已经结束了」，
 *    不能假装收下了——用户会以为追加的要求生效了。
 */

/** 一个会等闸门的后台任务。 */
function blockingTask(runtime, gate) {
  return runtime.submit({
    title: '查视频',
    run: async () => {
      await gate;
      return 'ok';
    },
  });
}

/** 造一个闸门（用来把任务挂住）。 */
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('归档：跑着的任务不能归档', async () => {
  const runtime = createAgentRuntime();
  const g = gate();
  const task = blockingTask(runtime, g.promise);
  const res = runtime.archive(task.taskId);
  assert.equal(res.ok, false);
  assert.match(res.message, /还在跑/);
  g.release();
  await task.done;
});

test('归档：结束的任务可以归档，归档后不在列表里', async () => {
  const runtime = createAgentRuntime();
  const task = runtime.submit({ title: '查视频', run: async () => 'ok' });
  await task.done;
  assert.equal(runtime.list().length, 1);

  const res = runtime.archive(task.taskId);
  assert.equal(res.ok, true);
  assert.equal(runtime.list().length, 0, '归档后不该出现在列表里');
  assert.equal(runtime.list({ includeArchived: true }).length, 1, '归档的记录要留着');
});

test('steer：追加的要求能在任务里取出来', async () => {
  const runtime = createAgentRuntime();
  let notes = null;
  const task = runtime.submit({
    title: '查视频',
    run: async (scope) => {
      notes = scope.steer();
      return 'ok';
    },
  });
  const res = runtime.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, true);
  await task.done;
  assert.deepEqual(notes, ['顺便看看 D 盘']);
});

test('steer：任务已经结束的，指令丢弃但不报错', async () => {
  const runtime = createAgentRuntime();
  const task = runtime.submit({ title: '查视频', run: async () => 'ok' });
  await task.done;
  const res = runtime.steer(task.taskId, '顺便看看 D 盘');
  // **不是错误**：任务刚好结束时那句追加确实没送出去，
  // 但这是时序问题，不是用户的错——报错只会让人以为程序坏了。
  assert.equal(res.ok, true);
  assert.equal(res.dropped, true);
});

test('steer：任务被取消的，指令作废并返回失败', async () => {
  const runtime = createAgentRuntime();
  const g = gate();
  const task = blockingTask(runtime, g.promise);
  runtime.cancel(task.taskId);
  const res = runtime.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, false);
  assert.match(res.message, /取消/);
  g.release();
});

test('steer：没有这个任务就说没有', () => {
  const runtime = createAgentRuntime();
  const res = runtime.steer('nope', '随便');
  assert.equal(res.ok, false);
  assert.match(res.message, /没有这个任务/);
});

/** 一个假的后端：报一步工具调用，然后给结果。 */
function fakeBackend() {
  return {
    id: 'fake',
    async chat(ctx) {
      ctx.onEvent?.({
        type: 'step',
        index: 1,
        tool: 'fs.list',
        args: {},
        result: 'a.txt',
        error: '',
      });
      return { text: '查完了', emotion: 'neutral', mood: 0, memories: [] };
    },
  };
}

test('中枢：列表是给人看的精简视图，带上最近一步', async () => {
  const tasks = createAgentTasks({ backend: fakeBackend() });
  const t = tasks.submit({ prompt: '查视频', messages: [] });
  await t.done;
  const list = tasks.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, t.taskId);
  assert.equal(list[0].title, '查视频');
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].lastStep, 'fs.list');
  assert.ok(Number.isFinite(list[0].elapsedMs));
  // 精简视图里不该有内部字段（run / scope / controller）。
  assert.equal(list[0].run, undefined);
});

test('计数：在跑的和排队的分开算，归档的不算', async () => {
  const tasks = createAgentTasks({ backend: fakeBackend() });
  const done = tasks.submit({ prompt: '查视频', messages: [] });
  await done.done;
  assert.equal(tasks.counts().running, 0);
  assert.equal(tasks.counts().queued, 0);

  // 归档之后：不在列表里，也不在计数里。
  tasks.archive(done.taskId);
  assert.equal(tasks.list().length, 0);
  assert.equal(tasks.counts().running, 0);
});
```

- [ ] **Step 2: 写失败的测试（任务管理工具）**

新建 `test/unit/agent-task-tools.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_KIND } from '../../src/shared/assistant.js';
import { createTaskTools } from '../../src/main/assistant/layer/taskTools.js';

/**
 * 五个任务管理工具（规格 §4.1、§6.2）。
 *
 * 派单要带三样东西：**用户原话**、**交互层的理解**、**相关历史**——
 * 只给一样，执行层要么不知道约束，要么细节全丢。
 */

/** 一个假的任务中枢。 */
function fakeTasks() {
  const calls = [];
  return {
    calls,
    submit(job) {
      calls.push({ op: 'submit', job });
      return {
        ok: true,
        taskId: 't-9',
        position: 1,
        queued: false,
        done: Promise.resolve({ ok: true }),
      };
    },
    list() {
      return [
        { taskId: 't-9', title: '查视频', status: 'running', lastStep: 'fs.list', result: '', elapsedMs: 1200 },
      ];
    },
    cancel(id) {
      calls.push({ op: 'cancel', id });
      return { ok: true };
    },
    archive(id) {
      calls.push({ op: 'archive', id });
      return { ok: true };
    },
    steer(id, note) {
      calls.push({ op: 'steer', id, note });
      return { ok: true };
    },
  };
}

/** 造这一轮的工具集。 */
function makeTools({ tasks = fakeTasks(), dispatchEnabled = true, records = [], history = [] } = {}) {
  const tools = createTaskTools({
    tasks,
    dispatchEnabled,
    appendRecord: (entry) => records.push(entry),
    now: () => 1000,
    turn: {
      history,
      userText: 'F 盘 video 下有什么',
      config: { model: 'stub-model' },
    },
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, byName, tasks, records };
}

test('派单：把用户原话与简报一起交给后台任务', async () => {
  const { byName, tasks } = makeTools();
  const out = await byName.get('task.submit').run({
    title: '查视频',
    brief: '看看 F:\\video 下有什么',
  });
  assert.equal(out.data.taskId, 't-9');

  const job = tasks.calls[0].job;
  assert.equal(job.title, '查视频');
  const last = job.messages.at(-1);
  assert.match(last.content, /看看 F:\\video 下有什么/, '简报要带过去');
  assert.match(last.content, /用户原话：F 盘 video 下有什么/, '用户原话也要带过去');
});

test('派单：记一条 dispatch 记录，正文里有任务号', async () => {
  const { byName, records } = makeTools();
  await byName.get('task.submit').run({ title: '查视频', brief: '看看' });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, CHAT_KIND.DISPATCH);
  assert.match(records[0].text, /t-9/, '任务号要在正文里：交互层下一轮要靠它说「停掉 t-9」');
});

test('派单关了：不能派，也不该真的派出去', async () => {
  const { byName, tasks } = makeTools({ dispatchEnabled: false });
  await assert.rejects(
    () => byName.get('task.submit').run({ title: '查视频', brief: '看看' }),
    /不能派单/
  );
  assert.equal(tasks.calls.length, 0, '不能派单就不该提交任务');
});

test('查看：把任务列出来', async () => {
  const { byName } = makeTools();
  const out = await byName.get('task.list').run({});
  assert.match(out.text, /t-9/);
  assert.match(out.text, /查视频/);
});

test('停掉 / 归档 / 追加要求：都转给中枢', async () => {
  const { byName, tasks } = makeTools();
  await byName.get('task.cancel').run({ taskId: 't-9' });
  await byName.get('task.delete').run({ taskId: 't-9' });
  await byName.get('task.steer').run({ taskId: 't-9', note: '顺便看看 D 盘' });
  assert.deepEqual(
    tasks.calls.map((c) => c.op),
    ['cancel', 'archive', 'steer']
  );
  assert.equal(tasks.calls[2].note, '顺便看看 D 盘');
});

test('失败要如实说：中枢不认就不假装成', async () => {
  const { byName } = makeTools({
    tasks: fakeTasks(),
  });
  byName.get('task.cancel');
  const tasks = fakeTasks();
  tasks.cancel = () => ({ ok: false, message: '这个任务已经结束了' });
  const tools = createTaskTools({
    tasks,
    dispatchEnabled: true,
    appendRecord: () => {},
    now: () => 1,
    turn: { history: [], userText: '停掉', config: {} },
  });
  const cancel = tools.find((t) => t.name === 'task.cancel');
  await assert.rejects(() => cancel.run({ taskId: 't-9' }), /已经结束/);
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `node --test test/unit/agent-runtime-tasks.test.js test/unit/agent-task-tools.test.js`
Expected: FAIL —— `runtime.steer is not a function` / `Cannot find module '.../layer/taskTools.js'`。

- [ ] **Step 4: 运行时加 steer 与归档**

`src/main/assistant/agent/runtime.js`：

1. `submit()` 里造任务对象的地方加两个字段：

```js
        // 待追加的指令（steer）：执行层在步骤边界取走。
        steerNotes: [],
        // 归档了：不再出现在列表里，也不再计入「正在跑 N 个」。
        // **记录仍然留着**——那是安全审计。
        archived: false,
```

2. `launch()` 里的 `scope` 加一个 `steer`：

```js
    const scope = {
      taskId: task.id,
      signal: controller.signal,
      hooks: makeHooks(task),
      /**
       * 取出并清空待追加的指令。
       *
       * **取走即清空**：一条指令只该被读一次——
       * 留在队列里的话，下一个步骤会再读一遍，模型会当成新要求重复执行。
       */
      steer: () => task.steerNotes.splice(0),
    };
```

3. 在 `cancel()` 之前插入两个新方法：

```js
    /**
     * 给正在跑的任务追加一句要求。
     *
     * **三种结局分得清**（规格 §8）：
     * - 任务还在跑 → 收下（`ok: true`）；
     * - 任务**刚好结束** → 指令丢弃，但**不报错**——
     *   这是时序问题，不是用户的错，报错只会让人以为程序坏了；
     * - 任务**已被取消** → 指令作废，返回 `{ ok: false }`——
     *   取消是明确的用户意图，往一个已经不存在的任务上追加是白做。
     */
    steer(taskId, note) {
      const task = tasks.get(String(taskId || ''));
      if (!task) return { ok: false, message: '没有这个任务' };
      if (task.status === TASK_STATUS.CANCELLED) {
        return { ok: false, message: '这个任务已经被取消了' };
      }
      if (task.finished || FINAL.has(task.status)) {
        return { ok: true, dropped: true };
      }
      const text = String(note || '').trim();
      if (!text) return { ok: false, message: '要追加什么？' };
      task.steerNotes.push(text);
      return { ok: true };
    },

    /**
     * 归档一个**已结束**的任务。
     *
     * 归档只影响可见性：记录条目留着（那是安全审计），
     * 只是它不再出现在列表里，也不再计入「正在跑 N 个」（规格 §6.2）。
     *
     * 还在跑的任务不能归档——要先停掉它。
     */
    archive(taskId) {
      const task = tasks.get(String(taskId || ''));
      if (!task) return { ok: false, message: '没有这个任务' };
      if (!task.finished && !FINAL.has(task.status)) {
        return { ok: false, message: '这个任务还在跑，先停掉它再归档' };
      }
      task.archived = true;
      return { ok: true };
    },
```

4. `cancel()` 里加一行——取消后待追加的指令作废：

```js
      task.status = TASK_STATUS.CANCELLED;
      // 取消了，待追加的指令也就作废了（规格 §5.2）——
      // 留着它们只会在任务万一复活时冒出来。
      task.steerNotes.length = 0;
```

5. `list()` 改成：

```js
    /**
     * 所有任务（新的在前）。
     *
     * **默认不含归档的**：归档就是「从列表里收起来」，
     * 记录还在磁盘上（`list({includeArchived: true})` 能看到）。
     */
    list({ includeArchived = false } = {}) {
      const all = [...tasks.values()].reverse();
      return includeArchived ? all : all.filter((t) => !t.archived);
    },
```

- [ ] **Step 5: 中枢加计数、steer、归档与精简列表**

`src/main/assistant/agent/tasks.js`：

1. 在 `const runtime = createAgentRuntime({...})` 之后加：

```js
  /** 每个任务最近一步的摘要（给「看看任务」用）。 */
  const lastSteps = new Map();
```

2. 在 `publish(event)` 里，事件往外走之前记一步：

```js
  function publish(event) {
    if (event?.type === AGENT_EVENT.STEP) {
      const name = String(event.tool || '工具');
      lastSteps.set(event.taskId, event.error ? `${name} 出错` : name);
    }
    try {
      onEvent?.(event);
    } catch (err) {
```

3. 把 `list()` 换掉，并加上 `counts()` / `steer()` / `archive()`：

```js
    /**
     * 任务列表：**给人看的精简视图**。
     *
     * 不给内部字段（run / scope / controller）——
     * 它们是实现细节，露出去只会被误用。
     */
    list() {
      return runtime.list().map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        lastStep: lastSteps.get(task.id) || '',
        result: task.result?.text ? String(task.result.text).slice(0, 200) : '',
        elapsedMs: (task.finishedAt || now()) - task.createdAt,
      }));
    },

    /**
     * 在跑的和排队的各有几个。
     *
     * **归档的不算**：归档就是「从列表里收起来」，
     * 它不该继续占着提示词里的「正在跑 N 个」（规格 §6.2）。
     */
    counts() {
      let running = 0;
      let queued = 0;
      for (const task of runtime.list()) {
        if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.WAITING_APPROVAL) {
          running += 1;
        } else if (task.status === TASK_STATUS.QUEUED) {
          queued += 1;
        }
      }
      return { running, queued };
    },

    /** 给正在跑的任务追加一句要求。 */
    steer(taskId, note) {
      return runtime.steer(taskId, note);
    },

    /** 归档一个已结束的任务。 */
    archive(taskId) {
      return runtime.archive(taskId);
    },
```

（上面 `tasks.js` 用到的 `TASK_STATUS`：`src/main/assistant/agent/tasks.js` 现在的 import 只有 `AGENT_EVENT` 与 `APPROVAL_DECISION`，要补上 `TASK_STATUS`——从 `../../../shared/assistant.js` 导。）

- [ ] **Step 6: 写五个任务管理工具**

新建 `src/main/assistant/layer/taskTools.js`：

```js
import { LAYER, TOOL_RISK } from '../../../shared/assistant.js';
import { buildHistoryMessages } from '../chat/prompt.js';
import { dispatchRecord } from '../agent/record.js';

/**
 * 交互层的五个任务管理工具（规格 §4.1）。
 *
 * ## 全部免审批
 *
 * 它们全是 `risk: 'read'`：查状态、派单、停任务都不碰用户的东西。
 * 审批是给「写文件 / 跑命令」准备的，不是给「管理自己的任务」准备的。
 *
 * ## 派单要带三样东西
 *
 * 1. **用户原话**（逐字）：执行层要能自纠——简报写歪了还能靠原话找回来；
 * 2. **交互层的理解**（title + brief）：要干什么、要什么结果、有什么约束；
 * 3. **相关历史**：执行层自己再读最近几条 user/reply。
 */
export function createTaskTools({
  tasks = null,
  turn = {},
  dispatchEnabled = true,
  appendRecord = () => {},
  now = () => Date.now(),
} = {}) {
  const history = Array.isArray(turn.history) ? turn.history : [];
  const userText = String(turn.userText || '');
  const config = turn.config || {};

  /** 记一条派单记录：交互层下一轮要看得见自己派过什么。 */
  function record(tool, { taskId = '', title = '', action = '' } = {}) {
    appendRecord(dispatchRecord({ tool, taskId, title, action, at: now() }));
  }

  return [
    {
      name: 'task.submit',
      label: '派个后台任务',
      description:
        '派一个后台任务去做耗时的活（查本机、翻文件、跑命令）。做完会另行通知你。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话说明这个任务要做什么' },
          brief: { type: 'string', description: '任务说明：要干什么、要什么结果、有什么约束' },
        },
        required: ['title', 'brief'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        if (!dispatchEnabled) throw new Error('现在不能派单（对话模式里派单关着）');
        const title = String(args?.title || '').trim() || '一件事';
        const brief = String(args?.brief || '').trim();
        if (!brief) throw new Error('任务说明还没写：要说清要干什么');
        const messages = [
          ...buildHistoryMessages({ history, layer: LAYER.EXECUTION }),
          { role: 'user', content: `${brief}\n\n用户原话：${userText}` },
        ];
        const task = tasks.submit({ prompt: brief, title, messages, config });
        if (!task?.ok) throw new Error('派不出去：运行时没有收下这个任务');
        record('task.submit', { taskId: task.taskId, title, action: `派了个任务：${title}` });
        return {
          text: `已派出任务 ${task.taskId}（${title}）`,
          data: { taskId: task.taskId, queued: Boolean(task.queued) },
        };
      },
    },

    {
      name: 'task.list',
      label: '看后台任务',
      description: '列出后台任务：每个任务在做什么、到哪一步了。',
      parameters: { type: 'object', properties: {}, required: [] },
      risk: TOOL_RISK.READ,
      async run() {
        const list = tasks.list();
        const text = list.length
          ? list
              .map((t) => `${t.taskId}｜${t.title}｜${t.status}｜${t.lastStep || ''}`)
              .join('\n')
          : '（现在没有后台任务）';
        record('task.list', { action: `看了看后台任务：${list.length} 个` });
        return { text, data: { list } };
      },
    },

    {
      name: 'task.cancel',
      label: '停掉后台任务',
      description: '停掉一个正在跑的后台任务。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务号' } },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要停哪个任务？给个 taskId');
        const res = tasks.cancel(taskId);
        if (!res?.ok) throw new Error(res?.message || '停不下来');
        record('task.cancel', { taskId, action: `停掉了个任务：${taskId}` });
        return { text: `已停掉任务 ${taskId}`, data: { taskId } };
      },
    },

    {
      name: 'task.delete',
      label: '归档后台任务',
      description: '把一个已经结束的任务从列表里归档（记录仍然留着）。',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务号' } },
        required: ['taskId'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const taskId = String(args?.taskId || '').trim();
        if (!taskId) throw new Error('要归档哪个任务？给个 taskId');
        const res = tasks.archive(taskId);
        if (!res?.ok) throw new Error(res?.message || '归档不了');
        record('task.delete', { taskId, action: `归档了个任务：${taskId}` });
        return { text: `已归档任务 ${taskId}`, data: { taskId } };
      },
    },

    {
      name: 'task.steer',
      label: '给后台任务追加要求',
      description: '给一个正在跑的任务追加一句要求（不改它原本要做什么）。',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: '任务号' },
          note: { type: 'string', description: '要追加的那句话' },
        },
        required: ['taskId', 'note'],
      },
      risk: TOOL_RISK.READ,
      async run(args) {
        const taskId = String(args?.taskId || '').trim();
        const note = String(args?.note || '').trim();
        if (!taskId) throw new Error('要给哪个任务追加要求？给个 taskId');
        if (!note) throw new Error('要追加什么？给个 note');
        const res = tasks.steer(taskId, note);
        if (!res?.ok) throw new Error(res?.message || '追加不了');
        record('task.steer', { taskId, action: `给任务追加了一句要求：${note}` });
        return { text: `已给任务 ${taskId} 追加要求`, data: { taskId, note } };
      },
    },
  ];
}
```

- [ ] **Step 7: 跑测试，确认全绿**

Run: `node --test test/unit/agent-runtime-tasks.test.js test/unit/agent-task-tools.test.js test/unit/agent-runtime.test.js test/unit/agent-tasks.test.js`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/main/assistant/agent/runtime.js src/main/assistant/agent/tasks.js src/main/assistant/layer/taskTools.js test/unit/agent-runtime-tasks.test.js test/unit/agent-task-tools.test.js
git commit -m "feat(助手): 五个任务管理工具与运行时的归档、steer"
```

---

## Task 4: 两层接线（前台交互层、后台执行层）

**Files:**
- Create: `src/main/assistant/layer/foreground.js`
- Modify: `src/main/assistant/index.js`（注册交互层；删掉 `backends.register('agent')`；完成通知写成 `reply` 记录；`agentTasks.getMessages` 改成执行层）
- Modify: `src/main/assistant/agent/tasks.js`（去掉 `foreground`；被取消的任务不弹「没做成」）
- Modify: `test/unit/agent-tasks.test.js`（去掉「前台任务不通知」那条）
- Test: `test/unit/agent-two-layers.test.js`、`test/e2e/two-layer-agent.spec.js`

**Interfaces:**
- Consumes: T2 的 `createInteractionBackend` / `fallbackText` / `translateError` / `isToolsUnsupportedError`；T3 的 `createTaskTools` / `tasks.counts()`
- Produces: `runForeground({interaction, plain, ctx, onFallback})`；主进程里前台恒定走交互层

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/agent-two-layers.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { LAYER } from '../../src/shared/assistant.js';
import { buildChatMessages } from '../../src/main/assistant/chat/prompt.js';
import { createPlainBackend } from '../../src/main/assistant/chat/plain.js';
import { createAgentBackend } from '../../src/main/assistant/chat/agent.js';
import { createAgentTasks } from '../../src/main/assistant/agent/tasks.js';
import { createInteractionBackend } from '../../src/main/assistant/layer/interaction.js';
import { createTaskTools } from '../../src/main/assistant/layer/taskTools.js';
import { runForeground } from '../../src/main/assistant/layer/foreground.js';
import { LlmError, LLM_ERRORS } from '../../src/main/assistant/llm/openai.js';

/**
 * 两层接线的端到端（规格 §7）。
 *
 * 这里盯的是**那条硬 bug**：用户在任务跑着的时候又说了句话，
 * 任务的结果就没了。现在前台对话与后台任务彻底分开，
 * 两者的序号互不干涉。
 */

const CONFIG = {
  apiKey: 'k',
  baseUrls: ['http://stub/v1'],
  model: 'stub-model',
  temperature: 0.7,
  maxTokens: 800,
  maxTokensField: 'max_tokens',
};

/** 造一个假接口：按顺序回预设的响应。 */
function fakeFetch(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

/** 造一句「调工具」的响应。 */
function toolCall(name, args = {}) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

/** 造一句「说点什么」的响应。 */
function say(text) {
  return { choices: [{ message: { content: text } }] };
}

/** 造一个假工具表。 */
function fakeRegistry(tools = []) {
  const map = new Map(tools.map((t) => [t.name, t]));
  return { get: (n) => map.get(n) || null, list: () => [...map.values()] };
}

/** 等某个条件成立。 */
async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

/** 按主进程的样子把两层接起来（不引 electron）。 */
function wire({ interactionFetch, executionFetch }) {
  const records = [];
  const notices = [];

  const execRegistry = fakeRegistry([
    {
      name: 'fs.list',
      label: '列目录',
      description: '列目录',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      run: async () => ({ text: 'a.txt' }),
    },
  ]);

  const agentBackend = createAgentBackend({
    // **要的是那个函数**：`fakeFetch()` 返回的是 {calls, fetchImpl}，
    // 直接把那个对象塞进来，调用时会炸「fetchImpl is not a function」。
    fetchImpl: executionFetch.fetchImpl,
    getTools: () => execRegistry,
    getGate: () => null,
    getMaxSteps: () => 5,
  });

  const tasks = createAgentTasks({
    backend: agentBackend,
    appendRecord: (entry) => records.push(entry),
    notify: (n) => notices.push(n),
    getMessages: (prompt) =>
      buildChatMessages({ history: [], userText: prompt, layer: LAYER.EXECUTION }),
  });

  const interaction = createInteractionBackend({
    fetchImpl: interactionFetch.fetchImpl,
    getRegistry: () => fakeRegistry([]),
    getTaskTools: (turn) =>
      createTaskTools({
        tasks,
        turn,
        dispatchEnabled: true,
        appendRecord: (entry) => records.push(entry),
        now: () => 1,
      }),
    getTaskCounts: () => tasks.counts(),
  });

  return { tasks, interaction, records, notices };
}

test('派单 → 后台跑 → 完成通知', async () => {
  const interactionFetch = fakeFetch([
    toolCall('task.submit', { title: '查视频', brief: '看看 F:\\video 下有什么' }),
    say('我去看看。'),
  ]);
  const executionFetch = fakeFetch([say('F:\\video 下有 3 个视频。')]);
  const { interaction, records, notices } = wire({ interactionFetch, executionFetch });

  const result = await interaction.chat({
    messages: buildChatMessages({ history: [], userText: 'F 盘 video 下有什么', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: 'F 盘 video 下有什么', config: CONFIG },
  });
  assert.equal(result.text, '我去看看。');

  const notice = await waitFor(() => notices[0]);
  assert.ok(notice, '任务做完了要通知用户');
  assert.match(notice.text, /3 个视频/);

  // 派单记录里有任务号：交互层下一轮要靠它说「停掉刚才那个」。
  const dispatch = records.find((r) => r.kind === 'dispatch');
  assert.ok(dispatch, '派单要有记录');
  assert.ok(dispatch.meta.taskId, '派单记录要带任务号');
});

test('用户中途又说话：任务不受影响，结果照样送到', async () => {
  const interactionFetch = fakeFetch([
    toolCall('task.submit', { title: '查视频', brief: '看看' }),
    say('我去看看。'),
    say('你好。'),
  ]);
  const executionFetch = fakeFetch([say('查完了。')]);
  const { interaction, tasks, notices } = wire({ interactionFetch, executionFetch });

  await interaction.chat({
    messages: buildChatMessages({ history: [], userText: 'F 盘 video 下有什么', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: 'F 盘 video 下有什么', config: CONFIG },
  });

  // 用户又说话了：这是**另一轮前台对话**，不该碰到后台任务。
  await interaction.chat({
    messages: buildChatMessages({ history: [], userText: '顺便问一句', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: '顺便问一句', config: CONFIG },
  });

  const notice = await waitFor(() => notices[0]);
  assert.ok(notice, '结果被新对话吞掉了');
  assert.match(notice.text, /查完了/);
  assert.equal(tasks.list()[0].status, 'done');
});

test('模型不支持工具调用：这一轮退回普通对话，并告诉用户', async () => {
  const plainFetch = fakeFetch([say('你好呀。')]);
  const plain = createPlainBackend({ fetchImpl: plainFetch.fetchImpl });

  // 用真的错误来跑：isToolsUnsupportedError 只认 LlmError + BAD_REQUEST
  // 且原文里提到工具，普通 Error 它不认（那样就不该退回）。
  const interaction = {
    async chat() {
      throw new LlmError('这个模型不支持工具调用，先按普通对话来。', {
        code: LLM_ERRORS.BAD_REQUEST,
        status: 400,
        body: 'tools is not supported',
      });
    },
  };

  let fallback = null;
  const result = await runForeground({
    interaction,
    plain,
    ctx: {
      system: '你是小桌',
      messages: [{ role: 'user', content: '你好' }],
      config: CONFIG,
    },
    onFallback: (err) => {
      fallback = err;
    },
  });

  assert.equal(result.text, '你好呀。');
  assert.ok(fallback, '要告诉用户这个模型不支持工具调用');
});

test('别的错误不退回：还是把错误抛出去', async () => {
  const plainFetch = fakeFetch([say('你好呀。')]);
  const plain = createPlainBackend({ fetchImpl: plainFetch.fetchImpl });

  const interaction = {
    async chat() {
      throw new LlmError('接口超时了', { code: LLM_ERRORS.TIMEOUT, status: 504, body: '' });
    },
  };

  await assert.rejects(
    () =>
      runForeground({
        interaction,
        plain,
        ctx: { system: '你是小桌', messages: [{ role: 'user', content: '你好' }], config: CONFIG },
      }),
    /接口超时了/,
    '不是「模型不支持工具」的错误就别退回'
  );
});

test('任务被取消：不弹「这件事没做成」', async () => {
  // 执行层的接口**永远不回来**：任务会一直跑着，直到被取消。
  // （这是唯一能确定「任务还在跑」的办法——真接口可能秒回。）
  const executionFetch = {
    calls: [],
    fetchImpl: async (url, options) => {
      executionFetch.calls.push({ url, body: JSON.parse(options.body) });
      return new Promise(() => {});
    },
  };
  const interactionFetch = fakeFetch([
    toolCall('task.submit', { title: '查视频', brief: '看看' }),
    say('我去看看。'),
  ]);
  const { interaction, tasks, records, notices } = wire({ interactionFetch, executionFetch });

  await interaction.chat({
    messages: buildChatMessages({ history: [], userText: 'F 盘 video 下有什么', layer: LAYER.INTERACTION }),
    config: CONFIG,
    turn: { history: [], userText: 'F 盘 video 下有什么', config: CONFIG },
  });

  const dispatch = records.find((r) => r.kind === 'dispatch');
  assert.ok(dispatch?.meta.taskId, '派单记录要带任务号');

  const res = tasks.cancel(dispatch.meta.taskId);
  assert.equal(res.ok, true, '取消要成功');

  // 取消是异步收尾的：等它走完。
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notices.length, 0, `取消的任务不该弹通知：${JSON.stringify(notices)}`);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/agent-two-layers.test.js`
Expected: FAIL —— `Cannot find module '.../layer/foreground.js'`。

- [ ] **Step 3: 前台那一轮的跑法**

新建 `src/main/assistant/layer/foreground.js`：

```js
import { isToolsUnsupportedError } from '../chat/agent.js';

/**
 * 跑一轮前台对话（规格 §10.4）。
 *
 * 交互层要调工具；模型不认 `tools` 字段时会直接 400。
 * 这时候这一轮**退回普通对话**，并告诉用户「这个模型不支持工具调用，
 * 先按普通对话来」——否则用户只看到一句报错，不知道该怎么办。
 *
 * **只有这一种错才退**：上下文超长、key 不对、限流……退了也只是换个姿势再错一次。
 */
export async function runForeground({ interaction, plain, ctx, onFallback = null }) {
  try {
    return await interaction.chat(ctx);
  } catch (err) {
    if (!isToolsUnsupportedError(err)) throw err;
    onFallback?.(err);
    return plain.chat(ctx);
  }
}
```

- [ ] **Step 4: 主进程接线**

`src/main/assistant/index.js`：

1. import 补上：

```js
import { LAYER, ... } from '../../shared/assistant.js';   // 已有 import 里加 LAYER
import { createInteractionBackend, INTERACTION_MAX_STEPS } from './layer/interaction.js';
import { createTaskTools } from './layer/taskTools.js';
import { runForeground } from './layer/foreground.js';
```

2. 在 `agentTasks` 之前加一个写记录的函数（两处都要用：中枢的事件记录、任务管理工具的派单记录）：

```js
  /** 写一条聊天记录（分类记录都走它）。 */
  function appendChatRecord(entry) {
    if (!state) return;
    state.chat.messages = appendMessage(state.chat.messages, entry);
    scheduleSave();
  }
```

（`scheduleSave` 与 `state` 在同一个闭包里，函数声明会提升，位置无所谓。）

3. `createAgentTasks({...})` 里把 `appendRecord` 换成 `appendChatRecord`，把 `getMessages` 改成执行层，把 `notify` 改成会记一条 `reply`：

```js
    getMessages: (prompt) =>
      buildChatMessages({
        history: state?.chat?.messages || [],
        userText: prompt,
        trigger: 'user',
        layer: LAYER.EXECUTION,
      }),
    appendRecord: appendChatRecord,
    notify: ({ text, ok }) => {
      // 完成通知也是**桌宠说的话**：记成 reply，
      // 交互层下一轮要记得「刚才那件事做完了」（规格 §7.3）。
      appendChatRecord({
        role: 'assistant',
        text: String(text || ''),
        at: Date.now(),
        proactive: false,
      });
      // **不带 interrupt**：用户正在说话或正在做决定时，完成通知要排队，
      // 不能把气泡顶掉（规格 §5.3）。
      say(text, { emotion: ok ? 'happy' : 'sad', sound: ok ? 'success' : '' });
    },
```

4. 删掉 `backends.register('agent', {...})` 那一整段（前台不再有「agent 模式」这个选择）。

5. 在 `agentTasks` 之后注册交互层：

```js
  // ------------------------------------------------------------------
  // 交互层：前台唯一跟用户说话的那一层（规格 §3）。
  //
  // **它不经过任务运行时**：交互层要秒级回应，
  // 排队等槽位会把「你好」变成「你好（排第 3 位）」。
  // ------------------------------------------------------------------
  const interactionBackend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => toolRegistry,
    // 任务管理工具**每轮新建**：它们绑着这一轮的历史与配置。
    getTaskTools: (turn) =>
      createTaskTools({
        tasks: agentTasks,
        turn,
        dispatchEnabled: dispatchEnabled(),
        appendRecord: appendChatRecord,
        now: () => Date.now(),
      }),
    getDispatchEnabled: () => dispatchEnabled(),
    getPersona: () => state?.llm?.persona || {},
    getFacts: () => state?.chat?.facts || [],
    getNow: () => new Date(),
    getTaskCounts: () => agentTasks.counts(),
    getMaxSteps: () => INTERACTION_MAX_STEPS,
    logger: console,
  });
  backends.register('interaction', interactionBackend);
```

6. 加一个「能不能派单」的取值函数（放在 `createAssistant` 里）：

```js
  /**
   * 能不能派单。
   *
   * **这里先一律返回 true**：设置里的「桌宠能做什么」是 Task 6 才接上的，
   * 那时再改成读 `state.agent.dispatch`。
   * （`state.agent.dispatch` 这个键在 Task 6 之前根本存不住——
   * 状态的清洗会把 `agent` 整块换掉，所以这时候读它只会读到 undefined。）
   */
  function dispatchEnabled() {
    return true;
  }
```

7. `runChat` 里改三处：

   a. 后端固定成交互层：

```js
    const backend = backends.get('interaction');
    if (!backend) return { ok: false, message: '没有可用的对话后端' };
```

   b. 上下文按交互层过滤：

```js
    const messages = buildChatMessages({
      history,
      userText: content,
      trigger,
      layer: LAYER.INTERACTION,
    });
```

   c. 调后端那一段换成 `runForeground`：

```js
    let result;
    try {
      result = await runForeground({
        interaction: backend,
        plain: backends.get('chat'),
        ctx: {
          system,
          messages,
          // 这一句的原话：派单时执行层要拿到「派单那一刻的对话」。
          prompt: content,
          trigger,
          config,
          // **这一轮的历史快照**（还没追加当前这句话的那份）：
          // 派单时执行层要读最近几条 user/reply。
          turn: { history, userText: content, config },
          onDelta: (delta) => {
            if (!delta) return;
            ack.noteText();
            reply?.push(delta);
          },
          // 交互层的工具调用**不转发**给插件：
          // 它们不是执行层的步骤，转过去会污染插件看到的事件流。
          onEvent: () => {},
        },
        onFallback: () => {
          // 这个模型不支持工具调用：明说，别让用户对着英文报错发呆。
          say('这个模型不支持工具调用，先按普通对话来。', { speak: false, interrupt: true });
        },
      });
    } catch (err) {
```

- [ ] **Step 5: 中枢去掉 `foreground`，取消的任务不通知**

`src/main/assistant/agent/tasks.js`：

1. `submit({...})` 的参数里删掉 `foreground = false,`；
2. `done.then(...)` 的两个处理器里删掉 `if (foreground) return;`；
3. 文件头那句「前台任务的回复气泡已经说过了」的注释改掉：

```js
      // 后台任务做完了要告诉用户。
      //
      // **两边的处理器都挂上**：不然没人接的失败会变成「未处理的拒绝」。
```

4. **被取消的任务不通知**（规格 §11.2 的「停掉刚才那个」）：

   取消是用户自己要的结果——交互层这时已经说了「好，停掉了」。
   再补一句「这件事没做成：任务已取消」，用户只会以为程序出了故障。

   `done` 那条链上把「取消」标出来：

```js
      // `done` 兑现的是**后端的返回**（与 backend.chat 一样）：
      // 前台路径要把它当成一次对话的结果直接用。
      const done = job.done.then((outcome) => {
        if (outcome.ok) return outcome.result;
        const error = outcome.error || new Error('这件事没做成');
        // **取消不是失败**：单独标出来，通知时别当成「没做成」。
        error.cancelled = outcome.status === TASK_STATUS.CANCELLED;
        throw error;
      });
```

   然后失败的那个处理器里先判一次：

```js
        (err) => {
          // 取消是用户自己要求的：他知道结果，不用再补一句「没做成」。
          if (err?.cancelled) return;
          notify({
            title: job.title,
            text: `这件事没做成：${err?.message || err}`,
            ok: false,
          });
        }
```

`src/main/assistant/index.js` 里 `agentFacade` 那段 `agentTasks.submit({ prompt, title: opts?.title || '', foreground: false })` 去掉 `foreground: false`。

- [ ] **Step 6: 改掉那条不再成立的测试**

`test/unit/agent-tasks.test.js`：

1. 删掉整条 `test('中枢：前台任务不通知——回复气泡就是它', ...)`（`foreground` 没了，这条测的东西不存在了）；
2. 「后台任务做完了要通知用户」那条里的 `messages: [], foreground: false` 去掉 `foreground: false`（这个参数已经没有了）。

- [ ] **Step 7: 跑单元测试，确认全绿**

Run: `node --test test/unit/agent-two-layers.test.js test/unit/agent-tasks.test.js test/unit/agent-backend.test.js`
Expected: PASS。

- [ ] **Step 8: 写 e2e**

新建 `test/e2e/two-layer-agent.spec.js`：

```js
// 双层 agent 的端到端验证。
//
// 盯的是三件事（规格 §11.2）：
//   1. **派单 → 完成通知**：用户发一句要动手的话，桌宠先应一句，
//      做完再冒出一条结果；
//   2. **中途搭话不丢结果**：任务跑着的时候用户又说话，
//      两句答复都要在（这是旧版最硬的那条 bug）；
//   3. **说「停掉刚才那个」**：任务真的停了。
//
// 桩接口靠**请求里的工具表**分辨是哪一层：
// 交互层带着 task.submit，执行层不带。
//
// **两层的延时是分开的**：交互层要秒级回应（几十毫秒），
// 执行层可以慢慢跑（几秒）——这样才能造出「任务还在跑」的窗口。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-two-layer');

/**
 * 桩接口。
 *
 * @param {object} handlers
 * @param {Function} handlers.interaction 交互层怎么回（拿到请求体）
 * @param {Function} handlers.execution  执行层怎么回
 * @param {number} [handlers.delayMs] 交互层的延时
 * @param {number} [handlers.executionDelayMs] 执行层的延时
 */
async function startStubLlm({
  interaction,
  execution,
  delayMs = 50,
  executionDelayMs = 50,
}) {
  // 挂起的定时器：关服时一并清掉，否则进程要等它们跑完才退。
  const timers = new Set();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const names = (body.tools || []).map((t) => t?.function?.name || '');
      const isExecution = !names.includes('task.submit');
      const reply = isExecution ? execution(body) : interaction(body);
      const wait = isExecution ? executionDelayMs : delayMs;
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }, wait);
      timers.add(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve) => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** 造一句「调工具」的响应。 */
function toolCall(name, args = {}) {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  };
}

/** 造一句「说点什么」的响应。 */
function say(text) {
  return { choices: [{ message: { content: text } }] };
}

/** 摆一份助理状态：对话开着、语音关着、能派单。 */
async function writeAssistantState(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
        llm: { enabled: true, model: 'stub-model', temperature: 0.7, maxTokens: 800 },
        // **这个字段 Task 6 才读得到**：状态的清洗会把 `agent` 整块换掉，
        // Task 6 之前这个键存不住（读出来是 undefined）。
        // 现在派单本来就是开着的（`dispatchEnabled()` 恒为 true），
        // 所以照样跑得通——Task 6 之后这里才真的起作用。
        agent: { dispatch: 'auto' },
      },
      null,
      2
    )
  );
}

/** 启动桌宠。 */
async function launch(userData, baseUrl) {
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: userData,
      DESK_PET_E2E: '1',
      DESK_PET_LLM_BASE_URL: baseUrl,
      LLM_API_KEY: 'stub-key',
    },
  });
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** 打开面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  return panel;
}

/** 记下气泡里**依次**出现过哪些字。 */
async function recordBubble(bubble) {
  await bubble.evaluate(() => {
    window.__seen = [];
    const record = () => {
      // **每次重新找元素**：气泡窗口刚打开时里面可能还没那个节点，
      // 抓住一次就再也不动了，记出来的会是空的。
      const el = document.getElementById('text');
      const t = (el?.textContent || '').trim();
      if (t && window.__seen.at(-1) !== t) window.__seen.push(t);
    };
    record();
    window.__recorder = setInterval(record, 30);
  });
}

/** 读助理状态文件。 */
async function readState() {
  try {
    return JSON.parse(await readFile(join(USER_DATA, 'assistant.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 等状态文件里出现某条记录。
 *
 * 落盘是防抖的（300ms），所以只能等，不能直接读一次。
 */
async function waitForState(pick, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState();
    const hit = state ? pick(state) : null;
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test.describe('双层 agent', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('派单 → 完成通知：两句都在', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        // 交互层：第一轮派单，第二轮给答复。
        const already = (body.messages || []).some((m) => m.role === 'tool');
        return already ? say('我去看看。') : toolCall('task.submit', { title: '查视频', brief: '看看 video 下有什么' });
      },
      execution: () => say('video 下有 3 个视频。'),
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', 'video 下有什么');
      await panel.press('#query', 'Control+Enter');

      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 10000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');
      await recordBubble(bubble);

      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('3 个视频')),
        null,
        { timeout: 20000 }
      );
      const seen = await bubble.evaluate(() => window.__seen);

      // 派单时先应一句。
      expect(seen.some((t) => t.includes('我去看看')), `没看到派单时的答复：${JSON.stringify(seen)}`).toBe(true);
      // 做完之后是结果句。
      expect(seen.at(-1)).toContain('3 个视频');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('任务跑着的时候用户又说话：两句答复都在', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const already = (body.messages || []).some((m) => m.role === 'tool');
        return already ? say('我去看看。') : toolCall('task.submit', { title: '查视频', brief: '看看' });
      },
      // 执行层慢一点：留出用户插话的时间。
      execution: () => say('查完了。'),
      executionDelayMs: 1500,
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', 'video 下有什么');
      await panel.press('#query', 'Control+Enter');

      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 10000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');
      await recordBubble(bubble);

      // 任务还在跑：用户又说话了。
      await panel.fill('#query', '顺便问一句');
      await panel.press('#query', 'Control+Enter');

      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('查完了')),
        null,
        { timeout: 20000 }
      );
      const seen = await bubble.evaluate(() => window.__seen);

      // **两句都在**：派单的答复与任务的结果。
      expect(seen.some((t) => t.includes('我去看看')), `派单的答复丢了：${JSON.stringify(seen)}`).toBe(true);
      expect(seen.some((t) => t.includes('查完了')), `任务的结果丢了：${JSON.stringify(seen)}`).toBe(true);
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('说「停掉刚才那个」：任务真的停了', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const msgs = body.messages || [];
        const last = msgs.at(-1) || {};
        // 轮内的后续调用（工具结果刚回来）：给个答复。
        if (last.role === 'tool') {
          const toolText = String(last.content || '');
          return say(toolText.includes('已停掉') ? '好，停掉了。' : '我去看看。');
        }
        const asked = String(last.content || '');
        if (asked.includes('停掉')) {
          // **从对话里找任务号**：真实的模型就是这么知道该停哪个的——
          // 交互层看得见自己派过的单（dispatch 记录，规格 §6）。
          // 找不到就说明那条记录没进上下文，这条 e2e 正是要抓这个。
          const all = msgs.map((m) => String(m.content || '')).join('\n');
          const at = all.match(/（任务 ([^）]+)）/);
          if (!at) return say('我不知道要停哪个任务。');
          return toolCall('task.cancel', { taskId: at[1] });
        }
        return toolCall('task.submit', { title: '查视频', brief: '看看 video 下有什么' });
      },
      execution: () => say('video 下有 3 个视频。'),
      // 执行层拖着：留出用户喊停的窗口。
      executionDelayMs: 8000,
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', 'video 下有什么');
      await panel.press('#query', 'Control+Enter');

      // 等派单落地：任务号写进状态里了。
      const dispatched = await waitForState((s) =>
        (s?.chat?.messages || []).find((m) => m.kind === 'dispatch' && m.meta?.taskId)
      );
      expect(dispatched, '没有派单记录').toBeTruthy();

      // **先把气泡记录器装上再喊停**：不然「好，停掉了」可能一闪而过。
      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 10000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');
      await recordBubble(bubble);

      await panel.fill('#query', '停掉刚才那个');
      await panel.press('#query', 'Control+Enter');

      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('好，停掉了')),
        null,
        { timeout: 20000 }
      );

      // **任务真的停了**：状态文件里这个任务的状态是「已取消」。
      const cancelled = await waitForState((s) =>
        (s?.chat?.messages || []).find(
          (m) =>
            m.kind === 'task' &&
            m.meta?.taskId === dispatched.meta.taskId &&
            m.meta?.status === 'cancelled'
        )
      );
      expect(cancelled, `任务没有被取消：${dispatched.meta.taskId}`).toBeTruthy();

      // 取消的任务**不该**再冒出一条「这件事没做成」。
      const seen = await bubble.evaluate(() => window.__seen);
      expect(
        seen.some((t) => t.includes('没做成')),
        `取消的任务不该说「没做成」：${JSON.stringify(seen)}`
      ).toBe(false);
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
```

- [ ] **Step 9: 跑 e2e**

Run: `npx playwright test test/e2e/two-layer-agent.spec.js`
Expected: PASS（三条都过）。

> **本机可能失败的 e2e**：多显示器环境下 `screen-recorder` 的几条 e2e 在本机必挂（与本改动无关）；若 `two-layer-agent` 也因为窗口/显示器环境而挂，先在干净树上单跑确认是不是本改动引起的。

- [ ] **Step 10: 提交**

```bash
git add src/main/assistant/index.js src/main/assistant/agent/tasks.js src/main/assistant/layer/foreground.js test/unit/agent-two-layers.test.js test/unit/agent-tasks.test.js test/e2e/two-layer-agent.spec.js
git commit -m "feat(助手): 两层接线——前台交互层、后台执行层"
```

---

## Task 5: steer 注入（追加的要求在下一个步骤边界生效）

**Files:**
- Modify: `src/main/assistant/agent/loop.js`（加 `steer` 钩子，在步骤边界注入）
- Modify: `src/main/assistant/chat/agent.js`（把 `ctx.steer` 传给循环）
- Modify: `src/main/assistant/agent/tasks.js`（把 `scope.steer` 传给后端）
- Test: `test/unit/agent-steer.test.js`

**Interfaces:**
- Consumes: T3 的 `runtime.steer(taskId, note)`、`scope.steer()`
- Produces: `createAgentLoop` 新增 `steer` 选项（`() => string[]`）；`chat/agent.js` 的 `ctx.steer`；`agent/tasks.js` 的 `backend.chat({steer})`

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/agent-steer.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentLoop } from '../../src/main/assistant/agent/loop.js';
import { createAgentTasks } from '../../src/main/assistant/agent/tasks.js';

/**
 * steer：给跑着的任务追加一句（规格 §5.2）。
 *
 * 三条最容易做错的：
 * 1. **注入点是步骤边界**：正在执行的工具调用不被打断，
 *    追加的要求在**下一步**开头才进上下文；
 * 2. **取走即清空**：一条指令只读一次——留在队列里的会被再读一遍，
 *    模型会当成新要求重复执行；
 * 3. **取消后队列作废**：取消是明确的用户意图，
 *    留着它们只会在任务万一复活时冒出来。
 */

/** 造一个假工具：每调一次就记一笔。 */
function fakeTool(log) {
  return {
    name: 'fs.list',
    label: '列目录',
    description: '列目录',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => {
      log.push('tool');
      return { text: 'a.txt' };
    },
  };
}

/** 造一句「调工具」的模型回答。 */
function toolCall(name = 'fs.list') {
  return {
    text: '',
    toolCalls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: '{}' } }],
  };
}

test('steer：追加的要求在下一个步骤边界进上下文', async () => {
  const log = [];
  const seen = [];
  const pending = [];

  const loop = createAgentLoop({
    callModel: async ({ messages }) => {
      // 每一步看到的上下文都记下来。
      seen.push(messages.map((m) => String(m.content || '')).join('\n'));
      // **在假模型里追加**：整个循环都在微任务队列里跑完，
      // 用 setTimeout 追加的话，定时器要等循环结束才触发——
      // 那句要求永远进不了上下文，测试就成了假绿。
      // 第一步调工具，之后给答复。
      if (seen.length === 1) {
        pending.push('顺便看看 D 盘');
        return toolCall();
      }
      return { text: '好了' };
    },
    resolveTool: () => fakeTool(log),
    // 队列取走即清空。
    steer: () => pending.splice(0),
  });

  const result = await loop.run({
    system: 's',
    messages: [{ role: 'user', content: '查视频' }],
  });

  assert.equal(result.text, '好了');
  // 第一步的上下文里没有那句追加（它还没到）。
  assert.ok(!seen[0].includes('顺便看看 D 盘'), '追加的要求不该出现在第一步');
  // 第二步看得到。
  assert.ok(
    seen[1]?.includes('顺便看看 D 盘'),
    `追加的要求没有进上下文：\n${seen[1]}`
  );
});

test('steer：一条指令只注入一次', async () => {
  const seen = [];
  const pending = ['顺便看看 D 盘'];
  const loop = createAgentLoop({
    callModel: async ({ messages }) => {
      seen.push(messages.map((m) => String(m.content || '')).join('\n'));
      if (seen.length < 3) return toolCall();
      return { text: '好了' };
    },
    resolveTool: () => fakeTool([]),
    steer: () => pending.splice(0),
  });
  await loop.run({ system: 's', messages: [{ role: 'user', content: '查视频' }] });
  // **只看最后一步的上下文**：每一步看到的都是整段对话，
  // 注入过一次的句子在后面的每一步里都会出现——
  // 数「出现过几步」数出来的不是注入次数。
  const last = seen[seen.length - 1];
  const count = last.split('顺便看看 D 盘').length - 1;
  assert.equal(count, 1, `追加的要求被注入了 ${count} 次`);
});

test('steer：任务被取消后队列作废', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let notes = null;
  const tasks = createAgentTasks({
    backend: {
      id: 'fake',
      async chat(ctx) {
        // 等闸门：这段时间里任务还在跑。
        await gate;
        notes = ctx.steer ? ctx.steer() : [];
        return { text: '好了' };
      },
    },
  });

  const task = tasks.submit({ prompt: '查视频', messages: [] });
  await new Promise((r) => setTimeout(r, 0));

  const res = tasks.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, true);

  tasks.cancel(task.taskId);
  release();

  await task.done.catch(() => {});
  // 取消之后队列空了：那条追加的要求作废了。
  assert.deepEqual(notes, [], '取消后队列里还留着要求');
});

test('steer：任务已经结束的，追加的要求丢弃且不报错', async () => {
  const tasks = createAgentTasks({
    backend: { id: 'fake', async chat() { return { text: '好了' }; } },
  });
  const task = tasks.submit({ prompt: '查视频', messages: [] });
  await task.done;
  const res = tasks.steer(task.taskId, '顺便看看 D 盘');
  assert.equal(res.ok, true);
  assert.equal(res.dropped, true);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/agent-steer.test.js`
Expected: FAIL —— `steer is not a function`（循环还不认这个钩子）。

- [ ] **Step 3: 循环里加注入点**

`src/main/assistant/agent/loop.js`：

1. 在 `createAgentLoop({...})` 的参数里加一项：

```js
  /**
   * 取追加的指令（steer）。
   *
   * 规格 §5.2：追加的要求在**步骤边界**注入——
   * 正在执行的工具调用不被打断，下一步开头才进上下文。
   *
   * 返回值是一个**数组**（一次可能追加好几条）。
   * **约定：取走即清空**——留在队列里的会被再读一遍，
   * 模型会当成新要求重复执行。
   */
  steer = null,
```

2. 在 `while (steps < maxSteps)` 里，`steps += 1;` **之前**插入：

```js
      // 追加的要求：**在步骤边界注入**（规格 §5.2）。
      // 放在调模型之前——正在执行的那一步已经跑完了，
      // 正在执行的工具调用不会被它打断。
      if (typeof steer === 'function') {
        const notes = steer();
        if (Array.isArray(notes) && notes.length > 0) {
          convo.push({
            role: 'user',
            content: `（用户追加的要求）\n${notes.map((n) => `- ${n}`).join('\n')}`,
          });
        }
      }
```

3. `run()` **不用改**：`steer` 是**循环级**的选项（不是每次 `run` 的参数）——
   它绑着某个任务的指令队列，而一个循环实例只服务一个任务。

- [ ] **Step 4: 执行层把 steer 传下去**

`src/main/assistant/chat/agent.js`：

1. `chat(ctx)` 的解构里加 `steer`：

```js
      const { messages = [], config = {}, onDelta, onEvent, signal, steer } = ctx;
```

2. `createAgentLoop({...})` 里加一行：

```js
        // 追加的要求：绑着这个任务的指令队列。
        steer: typeof steer === 'function' ? steer : null,
```

`src/main/assistant/agent/tasks.js`：

1. `backend.chat({...})` 里加一行：

```js
            // 追加的要求：执行层在步骤边界取走。
            // scope.steer 取走即清空（见 runtime.js）。
            steer: scope.steer,
```

- [ ] **Step 5: 跑测试，确认全绿**

Run: `node --test test/unit/agent-steer.test.js test/unit/agent-loop.test.js test/unit/agent-runtime-tasks.test.js`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/assistant/agent/loop.js src/main/assistant/chat/agent.js src/main/assistant/agent/tasks.js test/unit/agent-steer.test.js
git commit -m "feat(助手): steer 在步骤边界注入"
```

---

## Task 6: 设置与迁移（`agent.dispatch`，退役 `llm.backend`）

**Files:**
- Modify: `src/shared/assistant.js`（加 `DISPATCH_MODES` / `DISPATCH_MODE_INFO` / `dispatchModeInfo` / `DEFAULT_AGENT.dispatch`；删 `LLM_BACKENDS` / `LLM_BACKEND_INFO` / `llmBackendInfo` / `DEFAULT_LLM.backend`）
- Modify: `src/main/assistant/state.js`（删 `llm.backend`；加 `agent.dispatch` 与迁移）
- Modify: `src/settings/index.html`（「对话后端」→「桌宠能做什么」）
- Modify: `src/settings/main.js`（下拉框、说明、摘要、补丁）
- Modify: `src/main/assistant/chat/agent.js`（文件头那句「用户在设置里把 `llm.backend` 换成 'agent'」要改）
- Modify: `src/main/assistant/index.js`（`dispatchEnabled()` 从「恒为 true」改成读 `state.agent.dispatch`）
- Test: `test/unit/dispatch-modes.test.js`（新）、`test/unit/agent-backend.test.js`（改）、`test/e2e/dispatch-mode.spec.js`（新，替换 `test/e2e/backend-select.spec.js`）
- Modify: `docs/superpowers/specs/2026-11-07-agent-runtime-design.md`（清掉 `llm.backend` 的旧说法）

**Interfaces:**
- Consumes: T4 的 `dispatchEnabled()`（T4 里它恒为 true；这一步把它换成读设置）
- Produces: `DISPATCH_MODES`（`['auto','off']`）、`DISPATCH_MODE_INFO`、`dispatchModeInfo(id)`、`DEFAULT_AGENT.dispatch`

- [ ] **Step 1: 写失败的测试**

新建 `test/unit/dispatch-modes.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISPATCH_MODES,
  DISPATCH_MODE_INFO,
  dispatchModeInfo,
  DEFAULT_AGENT,
} from '../../src/shared/assistant.js';
import { sanitizeAssistant } from '../../src/main/assistant/state.js';

/**
 * 派单模式（规格 §10.3）。
 *
 * `llm.backend` 退役了，换成 `agent.dispatch`。
 * **迁移规则要精确**：给老用户平白发一个新能力（能派单、能动手），
 * 比不给要糟得多——用户会突然发现桌宠开始动他的文件。
 */

/** 每个派单模式都有名字与说明。 */
test('每个派单模式都有名字与说明', () => {
  for (const id of DISPATCH_MODES) {
    const info = DISPATCH_MODE_INFO[id];
    assert.ok(info, `派单模式 ${id} 没有说明`);
    assert.ok(info.label.length > 0, `派单模式 ${id} 没有名字`);
    assert.ok(info.hint.length > 0, `派单模式 ${id} 没有说明文字`);
  }
});

/** 说明要说清后果。 */
test('说明要说清后果', () => {
  // 「自动」意味着它会动手：用户得知道它可能动他的文件。
  assert.match(DISPATCH_MODE_INFO.auto.hint, /派/);
  assert.match(DISPATCH_MODE_INFO.auto.hint, /文件|动手|工具/);
  // 「关」意味着它只聊天。
  assert.match(DISPATCH_MODE_INFO.off.hint, /只|不|聊/);
});

/** 认不出来的模式：不抛错，原样回显。 */
test('认不出来的模式：不抛错，原样回显', () => {
  const info = dispatchModeInfo('bogus');
  assert.equal(info.label, 'bogus');
  assert.equal(info.hint, '');
});

/** 默认是「自动」。 */
test('默认能派单', () => {
  assert.equal(DEFAULT_AGENT.dispatch, 'auto');
  assert.equal(sanitizeAssistant({}).agent.dispatch, 'auto');
});

/** 迁移：以前选过 agent 的，现在能派单。 */
test('迁移：老配置 backend=agent → 能派单', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'agent' } }).agent.dispatch, 'auto');
});

/** 迁移：以前选普通对话的，保守起见不派单。 */
test('迁移：老配置 backend=chat → 不派单', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'chat' } }).agent.dispatch, 'off');
});

/** 迁移：整个文件里没有 llm 段（新装的）→ 默认值。 */
test('迁移：新装（没有 llm 段）→ 默认能派单', () => {
  assert.equal(sanitizeAssistant({}).agent.dispatch, 'auto');
});

/** 迁移：磁盘上的值认不出来 → 保守（不派单）。 */
test('迁移：认不出来的后端 → 不派单', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'bogus' } }).agent.dispatch, 'off');
});

/** 已经写过 dispatch 的：认它。 */
test('迁移：已有 dispatch 的就认它', () => {
  assert.equal(sanitizeAssistant({ agent: { dispatch: 'off' } }).agent.dispatch, 'off');
  assert.equal(sanitizeAssistant({ agent: { dispatch: 'auto' } }).agent.dispatch, 'auto');
});

/** 认不出来的 dispatch 值 → 默认。 */
test('迁移：认不出来的 dispatch → 默认', () => {
  assert.equal(sanitizeAssistant({ agent: { dispatch: 'bogus' } }).agent.dispatch, 'auto');
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test test/unit/dispatch-modes.test.js`
Expected: FAIL —— `DISPATCH_MODES is not exported`。

- [ ] **Step 3: 共享契约里加派单模式，退役后端清单**

`src/shared/assistant.js`：

1. 把这一整段删掉：

```js
/**
 * 可选的大模型对话后端。
 * ...
 */
export const LLM_BACKENDS = Object.freeze(['chat', 'agent']);

/**
 * 每个后端的中文名与说明。
 * ...
 */
export const LLM_BACKEND_INFO = Object.freeze({
  chat: Object.freeze({
    label: '普通对话',
    hint: '问一句答一句：只聊天，不动手。',
  }),
  agent: Object.freeze({
    label: 'agent 模式',
    hint:
      '会动手：能读文件、列目录、搜索（需要模型支持工具调用）。' +
      '写文件与执行命令要你点头，目前还不能自动做。',
  }),
});

/** 取某个后端的名字与说明；认不出来就原样回显 id（磁盘上的值可能被手改过）。 */
export function llmBackendInfo(id) {
  const key = String(id || '');
  return LLM_BACKEND_INFO[key] || Object.freeze({ label: key, hint: '' });
}
```

换成：

```js
/**
 * 桌宠能做什么（规格 §10.3）。
 *
 * 前台恒定是交互层（会调工具），没有「换后端」这个选择——
 * 取而代之的是**能不能派后台任务**。
 *
 * **定义只有一份**：状态清洗、设置界面都从这儿取。
 */
export const DISPATCH_MODES = Object.freeze(['auto', 'off']);

/**
 * 每个派单模式的中文名与说明。
 *
 * 说明写的是**用户看得懂的后果**，不写字段名：
 * 用户要判断的是「它会不会动我的文件」，不是「dispatch 是哪一档」。
 */
export const DISPATCH_MODE_INFO = Object.freeze({
  auto: Object.freeze({
    label: '能派活',
    hint:
      '桌宠能派后台任务：查本机、翻文件、跑一会儿的活都交给它。' +
      '动你文件的事要你点头。',
  }),
  off: Object.freeze({
    label: '只聊天',
    hint: '桌宠只跟你聊天：读时间、读剪贴板、读单个文件，其他事一概不派。',
  }),
});

/** 取某个派单模式的名字与说明；认不出来就原样回显 id（磁盘上的值可能被手改过）。 */
export function dispatchModeInfo(id) {
  const key = String(id || '');
  return DISPATCH_MODE_INFO[key] || Object.freeze({ label: key, hint: '' });
}
```

2. `DEFAULT_LLM` 里删掉这一行：

```js
  // 用哪个后端（见 src/main/assistant/chat/backend.js 的注册表）。
  // 将来加 agent 后端时，这里换一个 id 就行。
  backend: 'chat',
```

3. `DEFAULT_AGENT` 里加一行：

```js
  /**
   * 能不能派后台任务（规格 §10.3）。
   *
   * 'auto' 能派；'off' 只聊天。
   * 默认 'auto'：新装的用户什么也没配过，不该先给他们一个残废的桌宠。
   */
  dispatch: 'auto',
```

- [ ] **Step 4: 状态清洗加迁移**

`src/main/assistant/state.js`：

1. import 里把 `LLM_BACKENDS` 换成 `DISPATCH_MODES`：

```js
  DISPATCH_MODES,
```

2. `llm` 那一段里删掉这一行：

```js
      // 后端只认 LLM_BACKENDS 里的值：磁盘上的值可能是旧版本留下的，
      // 也可能被手改过——认不出来的当普通对话（最保险的那个）。
      backend: LLM_BACKENDS.includes(raw.llm.backend) ? raw.llm.backend : DEFAULT_LLM.backend,
```

3. `agent` 那一段**之后**加迁移（`if (isPlainObject(raw.agent)) {...}` 块外面）：

```js
  // 派单模式：**放在 agent 那段之外**——
  // 那一段会整体替换 out.agent，放进去就被覆盖了。
  // 而且老用户可能压根没有 agent 段（那是 L3 才加的），
  // 这时候派单模式要从 llm.backend 迁过来。
  //
  // **只传 raw**：不传第二参数。
  // agent 那段刚把 out.agent 整体换掉了，里面并没有 dispatch 这个键，
  // 所以 out.agent.dispatch 此刻是 undefined——
  // 拿它当兜底，认不出来时就会写成 undefined（而不是 'auto'）。
  // migrateDispatch 自己的默认参数就是 DEFAULT_AGENT.dispatch。
  out.agent.dispatch = migrateDispatch(raw);
```

4. 文件末尾加迁移函数：

```js
/**
 * 把老配置里的 `llm.backend` 迁成 `agent.dispatch`（规格 §10.3）。
 *
 * - `llm.backend === 'agent'` → 'auto'（以前能动手，现在能派单）；
 * - `llm.backend === 'chat'`  → 'off'（保守：不给老用户平白发一个新能力）；
 * - 整个文件里没有 llm 段（新装）→ 用默认值 'auto'。
 *
 * **已经写过 dispatch 的就认它**——那是用户自己（或新版）写下的。
 *
 * @param {object} raw 磁盘上的原始状态
 * @param {string} fallback 默认值（认不出来时用它）
 */
export function migrateDispatch(raw, fallback = DEFAULT_AGENT.dispatch) {
  if (isPlainObject(raw?.agent) && DISPATCH_MODES.includes(raw.agent.dispatch)) {
    return raw.agent.dispatch;
  }
  if (!isPlainObject(raw?.llm)) return fallback;
  // 老配置里只有 agent / chat 两种，认不出来的当 chat（保守）。
  return raw.llm.backend === 'agent' ? 'auto' : 'off';
}
```

- [ ] **Step 5: 设置页换下拉框**

`src/settings/index.html`：把这一段

```html
          <div class="field">
            <label for="llmBackend">对话后端</label>
            <div class="control">
              <!-- 选项由脚本按 shared/assistant.js 的 LLM_BACKENDS 填：
                   后端清单只有一份定义（加了新后端，设置页自动出现）。 -->
              <select id="llmBackend"></select>
            </div>
          </div>
          <p class="hint" id="llmBackendHint"></p>
```

换成：

```html
          <div class="field">
            <label for="llmDispatch">桌宠能做什么</label>
            <div class="control">
              <!-- 选项由脚本按 shared/assistant.js 的 DISPATCH_MODES 填：
                   清单只有一份定义（加了新模式，设置页自动出现）。 -->
              <select id="llmDispatch"></select>
            </div>
          </div>
          <p class="hint" id="llmDispatchHint"></p>
```

`src/settings/main.js`：

1. import 换成：

```js
import {
  DISPATCH_MODES,
  dispatchModeInfo,
  THINK_LEVELS,
  ACK_DELAY_PRESETS,
  ACK_DELAY_OFF,
  ackPrefsFromValue,
  ackValueFromPrefs,
} from '../shared/assistant.js';
```

2. 两个元素改成：

```js
const llmDispatchSelect = document.getElementById('llmDispatch');
const llmDispatchHint = document.getElementById('llmDispatchHint');
```

3. 摘要里那三行改成：

```js
  // 摘要里带上派单模式：用户最常问的「它现在会自己干活吗」，
  // 不该靠切进分区去看下拉框。
  const dispatchName = dispatchModeInfo(llmDispatchSelect.value).label;
  setSummary(
    'chat',
    llmEnabledBox.checked ? (llmKey ? `已开 · ${dispatchName}` : '缺 Key') : '已关'
  );
```

4. `fillBackendOptions()` 改名并改内容：

```js
/**
 * 填「桌宠能做什么」的下拉框。
 *
 * 选项按 shared/assistant.js 的 DISPATCH_MODES 填，不在这里写死：
 * 写死一份的话，加了第三个模式，设置页上还是那两个。
 *
 * 模块加载时就填好：init() 要拉一堆数据，万一哪步失败，
 * 设置页至少还能看见下拉框。
 */
function fillDispatchOptions() {
  llmDispatchSelect.textContent = '';
  for (const id of DISPATCH_MODES) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = dispatchModeInfo(id).label;
    llmDispatchSelect.appendChild(opt);
  }
}
fillDispatchOptions();
```

5. `updateBackendHint()` 改名并改内容：

```js
/** 把当前派单模式的说明写在下面——用户切过去时得当场看见差别。 */
function updateDispatchHint() {
  const info = dispatchModeInfo(llmDispatchSelect.value);
  llmDispatchHint.textContent = info.hint || `桌宠能做什么：${info.label}`;
}
```

6. `applyAssistantState` 里那两行改成：

```js
  // 派单模式：磁盘上的值可能是旧版本留下的，也可能是手改的——
  // 认不出来就退回默认（主进程已经迁移过了，这里读到的是迁移后的值）。
  llmDispatchSelect.value = DISPATCH_MODES.includes(state.agent?.dispatch)
    ? state.agent.dispatch
    : 'auto';
  updateDispatchHint();
```

7. `assistantPatchFromControls()` 里：`llm` 段删掉 `backend: llmBackendSelect.value,`，并**加一个新的顶层键**：

```js
    agent: {
      // 派单模式。
      //
      // **只带这一个字段**：合并是浅一层的（见 state.js 的 mergePatch），
      // 带整个 agent 段会把用户改过的并发数、工作区抹掉。
      dispatch: llmDispatchSelect.value,
    },
```

8. 监听器改名：

```js
llmDispatchSelect.addEventListener('change', () => {
  updateDispatchHint();
  persistAssistantPrefs();
});
```

- [ ] **Step 6: 改掉不再成立的地方**

`src/main/assistant/index.js`：T4 里 `dispatchEnabled()` 是恒为 true 的占位，
现在换成真读设置：

```js
  /**
   * 能不能派单（设置里的「桌宠能做什么」）。
   *
   * 读不到就当能派单：新装的用户什么也没配过，
   * 不该先给他一个残废的桌宠。
   */
  function dispatchEnabled() {
    return (state?.agent?.dispatch || 'auto') === 'auto';
  }
```

`src/main/assistant/chat/agent.js`：文件头那句

```js
 * 用户在设置里把 `llm.backend` 换成 'agent'，就走上多步循环。
```

改成

```js
 * 它是**执行层**的后端：由交互层派单触发，走多步循环。
```

`test/unit/agent-backend.test.js`：把这段

```js
test('后端取值：只认 chat 与 agent，别的当普通对话', () => {
  assert.equal(sanitizeAssistant({ llm: { backend: 'agent' } }).llm.backend, 'agent');
  assert.equal(sanitizeAssistant({ llm: { backend: 'chat' } }).llm.backend, 'chat');
  // 磁盘上的值可能是旧版本留下的，也可能是手改过：认不出来的就不能用。
  assert.equal(sanitizeAssistant({ llm: { backend: 'bogus' } }).llm.backend, 'chat');
  assert.equal(sanitizeAssistant({ llm: { backend: 123 } }).llm.backend, 'chat');
  assert.equal(sanitizeAssistant({ llm: {} }).llm.backend, 'chat');
});
```

删掉（迁移的断言在 `dispatch-modes.test.js` 里），并把该文件里 `sanitizeAssistant` 的 import 一起去掉（若不再用到）。

`docs/superpowers/specs/2026-11-07-agent-runtime-design.md`：把第 21 行、第 78 行、第 472 行、第 548 行里 `llm.backend` 的旧说法改掉：

- 第 21 行那一行改成：

```md
| `DEFAULT_LLM.backend` | `src/shared/assistant.js` | ~~后端 id 可切换~~ → **已退役**，见 [双层 agent 设计](2026-11-08-two-layer-agent-design.md) §10.3 |
```

- 第 78 行那句「用户可以在设置里切换（`llm.backend`）」改成：

```md
普通对话与 agent 是**同一个契约下的两个实现**。设置里不再切换它们——
前台恒定是交互层，能否派后台任务由 `agent.dispatch` 决定
（见 [双层 agent 设计](2026-11-08-two-layer-agent-design.md) §10.3）。
```

- 第 472 行那一行改成：

```md
llm.backend: 'chat' | 'agent'      // ~~已有字段~~ → 已退役，改用 agent.dispatch
```

- 第 548 行那一行改成：

```md
| T7 | agent 后端 | `assistant/chat/agent.js`、`assistant/index.js`（后端注册）、`shared/assistant.js`（`llm.backend` 取值） | T2、T4 | `llm.backend='agent'` 时走多步循环（**注**：该开关后来退役，见双层 agent 设计 §10.3） |
```

- [ ] **Step 7: 写 e2e**

新建 `test/e2e/dispatch-mode.spec.js`（删掉 `test/e2e/backend-select.spec.js`）：

```js
// 「桌宠能做什么」下拉框的端到端验证。
//
// 这个下拉框是两层 agent 的**能力开关**：
// 用户在这里选「只聊天」，桌宠就不派后台任务了。
//
// 所以这里钉住两件事：
//   1. 下拉框里的选项来自 shared/assistant.js 的 DISPATCH_MODES（只有一份定义）；
//   2. 选了就落盘，且**说明文字跟着换**（用户是在盲切时最需要这句提示）。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DISPATCH_MODES } from '../../src/shared/assistant.js';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-dispatch-mode');

/** 摆一份助理状态。 */
async function writeAssistantState(dir, agent = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
        llm: { enabled: true, model: 'stub-model', temperature: 0.7, maxTokens: 800 },
        agent: { dispatch: 'auto', ...agent },
      },
      null,
      2
    )
  );
}

/** 启动桌宠。 */
async function launch(userData = USER_DATA) {
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: userData, DESK_PET_E2E: '1' },
  });
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 等某个条件成立。 */
async function waitUntil(fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** 打开设置窗口，停在「对话」分区。 */
async function openChatPanel(app) {
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  await settings.click('#tab-chat');
  await settings.waitForSelector('#panel-chat:not([hidden])', { timeout: 10000 });
  return settings;
}

/** 从磁盘上读回存着的派单模式。 */
async function readStoredDispatch(dir) {
  const raw = JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}'));
  return raw.agent?.dispatch;
}

test.describe('桌宠能做什么下拉框', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('下拉框里的选项就是共享契约里的那一份', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-list');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { dispatch: 'auto' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      const options = await settings.evaluate(() =>
        Array.from(document.getElementById('llmDispatch').options).map((o) => o.value)
      );
      expect(options, '下拉框里的模式和共享契约对不上').toEqual([...DISPATCH_MODES]);
      // 存着哪个就选中哪个。
      expect(await settings.inputValue('#llmDispatch')).toBe('auto');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('切到「只聊天」：落盘，且说明跟着换', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-pick');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { dispatch: 'auto' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      const before = await settings.textContent('#llmDispatchHint');
      await settings.selectOption('#llmDispatch', 'off');

      const stored = await waitUntil(async () => {
        const d = await readStoredDispatch(dir);
        return d === 'off' ? d : null;
      });
      expect(stored, '选中的模式没有落盘').toBeTruthy();

      // 说明文字得跟着换：用户是在盲切，说明是他唯一的提示。
      const after = await settings.textContent('#llmDispatchHint');
      expect(after, '说明没有跟着换').not.toBe(before);
      expect(after, '「只聊天」的说明里没有说清它不派活').toMatch(/只|不/);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('老配置（llm.backend=agent）读起来是「能派活」', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-migrate');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'assistant.json'),
      JSON.stringify(
        {
          greeting: { enabled: false },
          tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
          tapTalk: { enabled: false, modelSound: false, lines: [] },
          llm: { enabled: true, backend: 'agent', model: 'stub-model' },
        },
        null,
        2
      )
    );
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);
      // 主进程的状态清洗会迁移它：设置页显示的必须是迁移后的值。
      expect(await settings.inputValue('#llmDispatch')).toBe('auto');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('老配置（llm.backend=chat）读起来是「只聊天」', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-migrate-chat');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'assistant.json'),
      JSON.stringify(
        {
          greeting: { enabled: false },
          tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
          tapTalk: { enabled: false, modelSound: false, lines: [] },
          llm: { enabled: true, backend: 'chat', model: 'stub-model' },
        },
        null,
        2
      )
    );
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);
      expect(await settings.inputValue('#llmDispatch')).toBe('off');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 8: 跑测试，确认全绿**

Run: `node --test test/unit/dispatch-modes.test.js test/unit/agent-backend.test.js test/unit/agent-tasks.test.js`
Expected: PASS。

Run: `npx playwright test test/e2e/dispatch-mode.spec.js`
Expected: PASS（四条都过）。

- [ ] **Step 9: 删掉旧文件，提交**

```bash
git rm test/unit/llm-backends.test.js test/e2e/backend-select.spec.js
git add src/shared/assistant.js src/main/assistant/state.js src/main/assistant/chat/agent.js src/main/assistant/index.js src/settings/index.html src/settings/main.js test/unit/dispatch-modes.test.js test/unit/agent-backend.test.js test/e2e/dispatch-mode.spec.js docs/superpowers/specs/2026-11-07-agent-runtime-design.md
git commit -m "feat(助手): 设置里换成「桌宠能做什么」，退役 llm.backend"
```

---

## 收尾：整套测试跑一遍

- [ ] **Step 1: 单元测试全绿**

Run: `node --test test/unit/`
Expected: PASS。

- [ ] **Step 2: e2e 全跑**

Run: `npx playwright test`
Expected: PASS。

> **本机已知会挂的 e2e**（与本计划无关，是环境问题）：
> - `screen-recorder` 的几条（多显示器环境导致，干净树上单跑也挂）；
> - `clipboard` 相关的（这台机器的剪贴板在 Electron 里不可用）。
>
> 若 `two-layer-agent` / `dispatch-mode` 也挂，先在干净树上单跑确认是不是本改动引起的。

- [ ] **Step 3: 提交收尾**

```bash
git add -A
git commit -m "chore(助手): 双层 agent 收尾"
```



