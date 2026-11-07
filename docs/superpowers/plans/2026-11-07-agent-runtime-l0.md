# 桌宠内置 Agent 运行时 · L0 地基 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 L0 的三块地基做完——先实测 MiniMax 的 tool calling 能不能用（不稳就回头改方案），再把聊天记录升级成**分类记录**，最后让 LLM 客户端能带工具。

**Architecture:** 三件事互相独立，可以按顺序做但没有耦合：
1. **T0 探针**是一次性脚本（不进仓库），用用户自己的 key 真跑 MiniMax，验证 `tool_calls` 在非流式与流式下都合法。
2. **T1 消息分类**改的是「记录」的形状：每条记录带上 `kind`（user/reply/task/step/approval），磁盘上**按 kind 分路截断**，喂给模型时**只取 user/reply**。
3. **T2 客户端**改的是 `src/main/assistant/llm/openai.js`：请求体带 `tools`、能发 `role:'tool'` 消息、能读**分片到达**的 `tool_calls`。

**Tech Stack:** Electron + Node（`node --test` 跑单元测试，无测试框架依赖）、OpenAI 兼容 HTTP 协议、MiniMax（`https://api.minimaxi.com/v1`）。

**Spec:** `docs/superpowers/specs/2026-11-07-agent-runtime-design.md`（本计划只实现它的 §14 里的 **L0 · 地基** 三项：T0 / T1 / T2）

## Global Constraints

- **注释与文档用中文。** 每个文件开头一段块注释，说明「这是什么」和「为什么这么写」；反直觉的设计尤其要写清楚不这么写会怎样。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `fix(助手): …` / `test(助手): …` / `docs(助手): …`。
- **能被测到的改动，先写测试。** 每个任务都按 RED→GREEN 走。
- **Edit 的 `file_path` 必须是绝对路径。**
- **契约只有一份**：主进程与渲染层共用的定义放 `src/shared/assistant.js`，两边都从那里取，不许各写一份。
- **不动 L1 及以后**：本计划不碰 `src/main/assistant/agent/`（还不存在）、不碰插件系统、不碰气泡。
- **不碰用户的真实配置**：探针脚本只**读** `userData/credentials.json` 与 `userData/assistant.json`，不写；且**绝不打印 key**（只打印「有没有配」）。
- 单元测试命令：`npm run test:unit`（等价于 `node --test "test/unit/**/*.test.js"`）。

## 评审后的修订（2026-11-07，整枝复审后）

本计划按 TDD 跑完后做了一次整枝复审，发现 1 个必须修的缺陷与 5 个「L1 一开写记录就会踩」的问题。
**下面这些改动已经落在代码里**，本计划里对应的代码片段也已同步改成正确版本。
照着本计划执行的人请直接用改后的版本，不要用改前的。

| # | 问题 | 改法 | 在本计划的哪一步 |
|---|---|---|---|
| 1 | **非流式路径用流式累积器装 tool_calls** —— 非流式的调用没有 `index`，两条并行调用挤进同一堆，名字拼成 `a.getb.list`、参数拼成两段 JSON | 新增 `normalizeToolCalls(list)`：按**数组顺序**映射，一一对应。非流式与「服务端回整段 JSON」的兜底分支都用它 | Task 3 Step 6 / Step 7 |
| 2 | **工具名的碎片拼接规则两头都会错** —— `'fo'+'o'` 丢字符，`'weather'+'weather.get'` 拼两遍 | 改成「新的是旧的前缀 → 替换；否则按碎片续」 | Task 3 Step 3 |
| 3 | **`emitted` 的 tool_calls 分支是死代码** —— 写在 `await` 之后、`catch` 之外，永远影响不到决策 | 给 `chatCompletionStream` 加 `onToolCall` 回调，在**流的过程中**计数 | Task 3 Step 7 / Step 8 |
| 4 | **`role` 与 `kind` 是两个互不校验的真值来源** —— `{kind:'user'}` 会被归一化成 `role:'assistant'`，用户的话以助手身份进上下文 | `role` 改为**由 kind 推导**（旧数据按 role 兜底得到 kind，兼容行为不变） | Task 2 Step 4 |
| 5 | **写盘关口仍按旧形状过滤** —— 只写 kind 的新记录、没有 role 的新记录会被**静默丢掉** | 关口的过滤条件改成「认 kind（也认旧 role）」+「正文空但 meta 有内容也留下」 | Task 2 Step 6 |
| 6 | **`meta` 没有体积上限** —— 工具结果可以很大，而 assistant.json 每次改动整份重写 | `capMeta()`：砍长字符串、限数组与层级，**保留结构**（taskId、tool 名不能丢） | Task 2 Step 4 |

复审还发现计划自己的测试代码块漏了这几条，于是它们当时全都没被锁住：
非流式并行 tool_calls、碎片工具名、`role:'tool'` 的 `tool_call_id`。
**对应的测试已经补进 `test/unit/agent-tools-stream.test.js` 与 `test/unit/agent-record.test.js`**（16 + 15 例）。

复审还有 4 条 Minor 是纯清理（死导出 `extractDelta`、说假话的注释、名不副实的常量名、`0 = 不限` 的语义），
与上面的修复落在同一批文件上，一并改掉了；剩下 2 条真的要改行为，留到 L1 动记录层时一起做：
- `messagesBlock` 丢掉 `kind`/`id`/`meta`，L1 一写 step 记录，内置「聊天记录」页会把步骤当成桌宠发言显示
  （规格 §10.1 说聊天记录最终要插件化，属过渡期状态）。
- 旧记录每次被加载都会换一批新的 `id`（`randomUUID`），只在第一次保存前漂移；将来有「按 id 定位/删除」的功能时再改成确定性 id。

## Review Focus

以下是规格暗示、但**没有任何一个任务的测试会覆盖**的输入类与失败模式。按「最可能先咬到人的」排序：

1. **磁盘上的旧聊天记录没有 `kind` 字段**（用户升级前的数据）——必须按 `role` 兜底推断成 user/reply，且不能被当成未知类别丢掉或截断错。
2. **一条新写入的步骤记录把最老的用户输入挤掉**——分路截断必须只砍自己那一路，模型最需要的那几条用户输入不能因为别路增长而消失。
3. **同一轮里模型并行发起两个工具调用**——流式分片会**交错**到达（第二个调用的第一片可能先于第一个调用的第二片到达），按到达顺序拼接必然把两个调用的参数粘在一起。
4. **模型只发起工具调用、正文为空**——非流式与流式都要认，不能因为「没有正文」就报「接口没有返回内容」。
5. **消息里出现 `role:'tool'` 的条目**——客户端要把 `tool_call_id` 原样带上；漏了会让 OpenAI 兼容服务端直接 400。

---

### Task 1: T0 前置探针——实测 MiniMax 的 tool calling

**Files:**
- Create（临时，**不进仓库**）：`C:\Users\Felix\.claude\jobs\908a7ee8\tmp\probe-tool-calling.mjs`
- 不改任何仓库文件

**Interfaces:**
- Consumes: 无（这是最早的任务）
- Produces: 一份探测报告（终端输出），结论只有三种：
  - `stable`：非流式与流式都能拿到合法 `tool_calls`，且参数能 `JSON.parse` → 方案照旧，T2 直接写。
  - `unstable`：能拿到 `tool_calls` 但格式不稳（参数分片切错、并行调用错位、偶发 400）→ 需要在 T2 里加解析容错，**但方案不改**。
  - `unsupported`：服务端根本不接受 `tools`（400 明确说不支持）→ **停下来找用户**，规格 §15 已经写明「本期『只用 OpenAI 兼容接口』这个前提要重新谈（改走 Anthropic 原生协议）」，这是需要人拍板的事，不能自己悄悄换协议。

- [x] **Step 1: 写探针脚本**

写 `C:\Users\Felix\.claude\jobs\908a7ee8\tmp\probe-tool-calling.mjs`：

```js
/**
 * MiniMax tool calling 稳定性探针（一次性，不进仓库）。
 *
 * 跑三组真实请求：非流式带工具、流式带工具（并行两个调用）、工具结果回灌。
 * 只打印结论与形状，**绝不打印 key**。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const USER_DATA = process.env.APPDATA ? join(process.env.APPDATA, 'desk-pet') : '';
const MODEL = process.env.PROBE_MODEL || 'MiniMax-M3.1-Flash';
const BASE_URL = (process.env.PROBE_BASE_URL || 'https://api.minimaxi.com/v1').replace(/\/+$/, '');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const creds = (await readJson(join(USER_DATA, 'credentials.json'))) || {};
const settings = (await readJson(join(USER_DATA, 'assistant.json'))) || {};
const apiKey = String(
  creds.llmApiKey || creds.minimaxApiKey || process.env.LLM_API_KEY || process.env.MINIMAX_API_KEY || ''
).trim();
const baseUrl = String(settings.llm?.lastWorkingBaseUrl || settings.llm?.baseUrl || BASE_URL).replace(/\/+$/, '');
const model = String(settings.llm?.model || MODEL);

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'weather.get',
      description: '按城市名查当前天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市名' } },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs.list',
      description: '列出目录',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '目录路径' } },
        required: ['path'],
      },
    },
  },
];

const report = { keyConfigured: Boolean(apiKey), model, baseUrl, nonStream: null, stream: null, roundTrip: null };

if (!apiKey) {
  report.error = '没有可用的 API Key';
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}

/** 一次非流式请求，返回 {status, body}。 */
async function post(body) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 留 null */
  }
  return { status: res.status, json, text: text.slice(0, 400) };
}

// --- A. 非流式带工具 -------------------------------------------------
{
  const { status, json, text } = await post({
    model,
    messages: [{ role: 'user', content: '用 weather.get 查一下北京的天气' }],
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 800,
    stream: false,
  });
  const calls = json?.choices?.[0]?.message?.tool_calls;
  const first = Array.isArray(calls) ? calls[0] : null;
  let argsOk = false;
  let argsError = '';
  try {
    JSON.parse(first?.function?.arguments ?? '');
    argsOk = true;
  } catch (err) {
    argsError = String(err?.message || err);
  }
  report.nonStream = {
    status,
    hasToolCalls: Array.isArray(calls),
    count: Array.isArray(calls) ? calls.length : 0,
    name: first?.function?.name || '',
    argumentsPreview: String(first?.function?.arguments || '').slice(0, 200),
    argsParseOk: argsOk,
    argsError,
    contentPreview: String(json?.choices?.[0]?.message?.content || '').slice(0, 120),
    errorPreview: json?.error ? JSON.stringify(json.error).slice(0, 300) : text.slice(0, 300),
  };
}

// --- B. 流式带工具（并行两个调用，故意让分片交错） ---------------------
{
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '同时查北京的天气，并列出 src 目录，两个都做' }],
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 800,
      stream: true,
    }),
  });
  const raw = await res.text();
  const frames = raw
    .split(/\r?\n\r?\n/)
    .map((part) => part.split(/\r?\n/).find((line) => line.trim().startsWith('data:')) || '')
    .map((line) => line.trim().slice(5).trim())
    .filter(Boolean);
  const byIndex = new Map();
  let fragmented = 0;
  for (const frame of frames) {
    if (frame === '[DONE]') break;
    let data;
    try {
      data = JSON.parse(frame);
    } catch {
      continue;
    }
    const calls = data?.choices?.[0]?.delta?.tool_calls;
    for (const call of Array.isArray(calls) ? calls : []) {
      const index = Number.isFinite(call?.index) ? call.index : 0;
      const cur = byIndex.get(index) || { id: '', name: '', arguments: '' };
      if (call?.id) cur.id = call.id;
      if (call?.function?.name && !cur.name) cur.name = call.function.name;
      const args = call?.function?.arguments;
      if (typeof args === 'string') {
        if (args) fragmented += 1;
        cur.arguments += args;
      }
      byIndex.set(index, cur);
    }
  }
  const list = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const parsed = list.map((c) => {
    try {
      JSON.parse(c.arguments);
      return { name: c.name, argsOk: true };
    } catch (err) {
      return { name: c.name, argsOk: false, args: c.arguments.slice(0, 200), error: String(err?.message || err) };
    }
  });
  report.stream = {
    status: res.status,
    frameCount: frames.length,
    callCount: list.length,
    argumentChunks: fragmented,
    calls: parsed,
    errorPreview: res.ok ? '' : raw.slice(0, 300),
  };
}

// --- C. 工具结果回灌（role:'tool' 消息能不能被接受） -------------------
{
  const first = report.nonStream?.hasToolCalls
    ? report.nonStream
    : null;
  const toolCallId = 'call_probe_1';
  const { status, json, text } = await post({
    model,
    messages: [
      { role: 'user', content: '用 weather.get 查一下北京的天气' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: { name: 'weather.get', arguments: JSON.stringify({ city: '北京' }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: toolCallId, content: '北京 晴 26℃' },
    ],
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 800,
    stream: false,
  });
  report.roundTrip = {
    status,
    ok: Boolean(json?.choices?.[0]?.message?.content),
    contentPreview: String(json?.choices?.[0]?.message?.content || '').slice(0, 200),
    errorPreview: json?.error ? JSON.stringify(json.error).slice(0, 300) : text.slice(0, 300),
    hasToolCallId: Boolean(first),
  };
}

console.log(JSON.stringify(report, null, 2));
```

- [x] **Step 2: 跑探针**

Run: `node "C:\Users\Felix\.claude\jobs\908a7ee8\tmp\probe-tool-calling.mjs"`

Expected: 打印一份 JSON 报告，含 `keyConfigured: true`、`nonStream`、`stream`、`roundTrip` 三组结果。

- [x] **Step 3: 读报告，定性**

按下面这张表对照，把结论**一字不改**写进最终报告：

| 报告里的现象 | 结论 |
|---|---|
| `nonStream.hasToolCalls: true` 且 `argsParseOk: true`，`stream.callCount ≥ 1` 且每个 `argsOk: true`，`roundTrip.status: 200` | **stable**——方案照旧，Task 3 直接写 |
| 能拿到 `tool_calls`，但 `argsParseOk: false` / `argsOk: false` / `callCount` 少于实际调用数 / 偶发 400 | **unstable**——在 Task 3 里补解析容错（累积器按 index 拼、参数拼接失败时回退到原文），方案不改 |
| `nonStream.status: 400` 且错误信息明确说不支持 tools | **unsupported**——**停下来找用户**，把结论与影响讲清楚（§15 说这要重新谈「只用 OpenAI 兼容接口」这个前提），不要自己换协议 |
| `keyConfigured: false` | **停下来找用户**——没有 key 就没法探针 |

- [x] **Step 4: 记录结论（不提交）**

在最终报告里写清楚：结论（stable / unstable / unsupported）、探针实际跑出来的关键数字（非流式与流式各拿到几个 tool call、参数能否 parse、流式分片数）、以及它对 Task 3 的影响。

**本任务不产生提交**（脚本不进仓库）。

---

### Task 2: T1 消息分类扩展

**Files:**
- Modify: `src/shared/assistant.js`（新增 `CHAT_KIND` / `CHAT_KIND_LIMITS` / `CHAT_KIND_FOR_MODEL` / `chatKindOf`）
- Modify: `src/main/assistant/chat/memory.js`（新增 `normalizeChatEntry` / `truncateByKind`；改 `appendMessage`）
- Modify: `src/main/assistant/chat/prompt.js`（改 `buildChatMessages` 的过滤规则）
- Modify: `src/main/assistant/state.js`（`sanitizeAssistant` 的消息规整与截断）
- Modify: `src/main/assistant/index.js`（`chatHistoryView` 带上 `kind` / `id` / `meta`）
- Test: `test/unit/agent-record.test.js`

**Interfaces:**
- Consumes: 无（Task 1 只做探测，不产出代码接口）
- Produces:
  - `src/shared/assistant.js`：
    - `CHAT_KIND = { USER:'user', REPLY:'reply', TASK:'task', STEP:'step', APPROVAL:'approval' }`
    - `CHAT_KIND_LIMITS = { user:40, reply:40, step:200, task:100, approval:100 }`
    - `CHAT_KIND_FOR_MODEL = ['user', 'reply']`
    - `chatKindOf(entry) → 'user'|'reply'|'task'|'step'|'approval'`（未知/缺失 `kind` 时按 `role` 兜底）
  - `src/main/assistant/chat/memory.js`：
    - `normalizeChatEntry(raw) → { id, at, kind, role, text, proactive, meta? }`
    - `truncateByKind(messages, limits?) → messages[]`（每路各砍自己的尾巴，保留原有时间顺序）
    - `appendMessage(messages, message, limits?) → messages[]`（先规整新条目，再分路截断）
  - `src/main/assistant/chat/prompt.js`：
    - `buildChatMessages({ history, userText, trigger })` —— 行为变了：**只取 kind 为 user/reply 的最近 12 条**；签名不变。
  - `src/main/assistant/state.js`：
    - `sanitizeAssistant(raw)` —— 行为变了：消息带上 `id`/`kind`/`meta`，并按 kind 分路截断；签名不变。

**Interfaces 与后续任务的冲突（pre-flight）:**
本任务产出的 `CHAT_KIND` / `CHAT_KIND_LIMITS` 是 L3 的 `agent/record.js`（写任务、步骤、审批记录）与 L5 的聊天记录插件的依赖点。命名必须与规格 §4.2 一致：`kind` 取值 `user` / `reply` / `task` / `step` / `approval`。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-record.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_KIND,
  CHAT_KIND_LIMITS,
  chatKindOf,
} from '../../src/shared/assistant.js';
import {
  appendMessage,
  normalizeChatEntry,
  truncateByKind,
} from '../../src/main/assistant/chat/memory.js';
import { buildChatMessages } from '../../src/main/assistant/chat/prompt.js';
import { sanitizeAssistant } from '../../src/main/assistant/state.js';

/**
 * 聊天记录的分类（spec §4）。
 *
 * 三件事最容易做错：
 * 1. 喂模型时**只取 user/reply**——步骤/任务/审批绝不能进上下文；
 * 2. 磁盘上的截断**按 kind 分路**——砍数组尾巴会把最老的用户输入挤掉；
 * 3. 旧记录没有 `kind`，按 `role` 兜底。
 */

/** 造一条记录（绕过 appendMessage，方便直接构造边界情况）。 */
function entry(kind, text, extra = {}) {
  return { id: `${kind}-${text}`, at: 1, kind, role: kind === 'user' ? 'user' : 'assistant', text, ...extra };
}

test('分类：kind 的取值与规格一致', () => {
  assert.equal(CHAT_KIND.USER, 'user');
  assert.equal(CHAT_KIND.REPLY, 'reply');
  assert.equal(CHAT_KIND.TASK, 'task');
  assert.equal(CHAT_KIND.STEP, 'step');
  assert.equal(CHAT_KIND.APPROVAL, 'approval');
});

test('分类：旧记录没有 kind 时按 role 兜底', () => {
  assert.equal(chatKindOf({ role: 'user', text: '在呢' }), 'user');
  assert.equal(chatKindOf({ role: 'assistant', text: '在呢' }), 'reply');
  assert.equal(chatKindOf({ kind: 'step', role: 'assistant', text: 'x' }), 'step');
  assert.equal(chatKindOf({ kind: '瞎写的', role: 'user', text: 'x' }), 'user');
});

test('分类：每类记录有自己的上限', () => {
  assert.equal(CHAT_KIND_LIMITS.user, 40);
  assert.equal(CHAT_KIND_LIMITS.reply, 40);
  assert.equal(CHAT_KIND_LIMITS.step, 200);
  assert.equal(CHAT_KIND_LIMITS.task, 100);
  assert.equal(CHAT_KIND_LIMITS.approval, 100);
});

test('记录：写入时补齐 id / kind / at', () => {
  const list = appendMessage([], { role: 'user', text: '你好' });
  assert.equal(list.length, 1);
  assert.ok(list[0].id, '要有 id');
  assert.equal(list[0].kind, 'user');
  assert.equal(list[0].role, 'user');
  assert.equal(list[0].text, '你好');
  assert.ok(Number.isFinite(list[0].at));
});

test('记录：截断按 kind 分路——新步骤不会挤掉最老的用户输入', () => {
  let list = [];
  list = appendMessage(list, { role: 'user', text: '第一条用户输入' });
  list = appendMessage(list, { role: 'assistant', text: '第一条回复' });
  // 塞 300 条步骤——超过 step 的上限 200。
  for (let i = 0; i < 300; i += 1) {
    list = appendMessage(list, { kind: 'step', role: 'assistant', text: `步骤 ${i}` });
  }
  const users = list.filter((m) => m.kind === 'user');
  const replies = list.filter((m) => m.kind === 'reply');
  const steps = list.filter((m) => m.kind === 'step');
  assert.equal(users.length, 1, '用户输入不能被步骤挤掉');
  assert.equal(users[0].text, '第一条用户输入');
  assert.equal(replies.length, 1, '回复也不能被步骤挤掉');
  assert.equal(steps.length, CHAT_KIND_LIMITS.step, '步骤自己砍自己的尾巴');
  assert.equal(steps[steps.length - 1].text, '步骤 299', '砍的是最老的');
});

test('记录：截断后时间顺序不乱', () => {
  const list = truncateByKind([
    entry('user', 'u1'),
    entry('step', 's1'),
    entry('reply', 'r1'),
    entry('step', 's2'),
  ]);
  assert.deepEqual(list.map((m) => m.text), ['u1', 's1', 'r1', 's2']);
});

test('记录：规整旧数据——补 id、补 kind、认 role', () => {
  const one = normalizeChatEntry({ role: 'assistant', text: '老回复', at: 123 });
  assert.ok(one.id);
  assert.equal(one.kind, 'reply');
  assert.equal(one.at, 123);
  assert.equal(one.role, 'assistant');
});

test('喂模型：只有 user 与 reply 进上下文', () => {
  const history = [
    entry('user', '用户说的话'),
    entry('reply', '桌宠的回复'),
    entry('task', '任务：排队'),
    entry('step', '步骤：fs.list src/'),
    entry('approval', '审批：shell.exec'),
  ];
  const messages = buildChatMessages({ history, userText: '现在这句' });
  assert.deepEqual(messages, [
    { role: 'user', content: '用户说的话' },
    { role: 'assistant', content: '桌宠的回复' },
    { role: 'user', content: '现在这句' },
  ]);
});

test('喂模型：旧记录（没有 kind）也能进上下文', () => {
  const messages = buildChatMessages({
    history: [
      { role: 'user', text: '老用户输入' },
      { role: 'assistant', text: '老回复' },
    ],
    userText: '现在这句',
  });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, '老用户输入');
  assert.equal(messages[1].role, 'assistant');
});

test('喂模型：历史再多也只发最近 12 条', () => {
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push(entry(i % 2 === 0 ? 'user' : 'reply', `第 ${i} 条`));
  }
  const messages = buildChatMessages({ history, userText: '现在这句' });
  assert.equal(messages.length, 13, '12 条历史 + 当前这句');
  assert.equal(messages[0].content, '第 18 条');
});

test('磁盘：旧记录读进来时被补齐 kind，并按 kind 分路截断', () => {
  const raw = {
    chat: {
      messages: [
        { role: 'user', text: '老用户输入', at: 1 },
        { role: 'assistant', text: '老回复', at: 2 },
        ...Array.from({ length: 250 }, (_, i) => ({
          id: `s${i}`,
          kind: 'step',
          role: 'assistant',
          text: `步骤 ${i}`,
          at: 100 + i,
          meta: { taskId: 't1', index: i },
        })),
      ],
      facts: [],
    },
  };
  const clean = sanitizeAssistant(raw);
  const users = clean.chat.messages.filter((m) => m.kind === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text, '老用户输入');
  assert.ok(users[0].id, '旧记录也要有 id');
  const steps = clean.chat.messages.filter((m) => m.kind === 'step');
  assert.equal(steps.length, CHAT_KIND_LIMITS.step);
  assert.equal(steps[0].text, '步骤 50', '砍掉最老的步骤，用户输入与回复留着');
  const step = steps[0];
  assert.equal(step.meta.taskId, 't1');
  assert.equal(step.meta.index, 50);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-record.test.js"`

Expected: FAIL —— `CHAT_KIND` / `CHAT_KIND_LIMITS` / `chatKindOf` 未导出（`SyntaxError: The requested module ... does not provide an export named 'CHAT_KIND'`）。

- [x] **Step 3: 在 `src/shared/assistant.js` 里定义分类**

在文件末尾（`MAX_CHAT_MESSAGES` 等常量之后）追加：

```js
/**
 * 聊天记录的分类。
 *
 * agent 之后，记录里会混进工具调用日志、审批请求、任务状态——
 * 它们是**给人看的**，绝不能进模型的上下文。
 * 所以每条记录都要带一个 `kind`，把「给人看的」与「给模型看的」分开。
 *
 * 规格见 docs/superpowers/specs/2026-11-07-agent-runtime-design.md §4.2。
 */
export const CHAT_KIND = Object.freeze({
  /** 用户说的话。 */
  USER: 'user',
  /** 桌宠的回复（普通对话的结论，或 agent 的最终答复）。 */
  REPLY: 'reply',
  /** 任务状态变化：排队 / 开始 / 完成 / 失败 / 取消。 */
  TASK: 'task',
  /** 任务中的一次步骤：模型决定、工具调用、工具结果。 */
  STEP: 'step',
  /** 审批请求与用户的选择。 */
  APPROVAL: 'approval',
});

/**
 * 每类记录在磁盘上最多留多少条。
 *
 * **按类分路，不是一个总上限**：user/reply 要留得久（模型要看），
 * step 增长极快（几步就几条）——一个总上限会让一条新步骤把最老的用户输入挤掉，
 * 而模型恰恰最需要那几条用户输入。
 */
export const CHAT_KIND_LIMITS = Object.freeze({
  user: MAX_CHAT_MESSAGES,
  reply: MAX_CHAT_MESSAGES,
  step: 200,
  task: 100,
  approval: 100,
});

/** 哪些分类会进模型的上下文（其它一律不进）。 */
export const CHAT_KIND_FOR_MODEL = Object.freeze([CHAT_KIND.USER, CHAT_KIND.REPLY]);

/**
 * 取一条记录的分类。
 *
 * **旧记录没有 `kind`**（用户升级前的数据），按 `role` 兜底：
 * `user` → user，其余 → reply。判断不了的一律当 reply（宁可多给模型一点，
 * 也不要凭空丢掉用户说过的话）。
 */
export function chatKindOf(entry) {
  const kind = String(entry?.kind || '').trim();
  if (Object.values(CHAT_KIND).includes(kind)) return kind;
  return entry?.role === 'user' ? CHAT_KIND.USER : CHAT_KIND.REPLY;
}

/**
 * 一条记录有没有**明确的**分类。
 *
 * 与 `chatKindOf` 的区别：后者永远给出一个合法 kind（按 role 兜底），
 * 这个回答的是「这条数据自己说了自己是哪一类吗」——
 * 写盘关口用它区分「形状不对」与「合法但没写 role」。
 */
export function hasChatKind(entry) {
  const kind = String(entry?.kind || '').trim();
  return Object.values(CHAT_KIND).includes(kind);
}
```

- [x] **Step 4: 改 `src/main/assistant/chat/memory.js`**

把文件头部的导入改成：

```js
import { randomUUID } from 'node:crypto';
import {
  MAX_CHAT_FACTS,
  CHAT_KIND,
  CHAT_KIND_LIMITS,
  chatKindOf,
} from '../../../shared/assistant.js';
```

并先加上 meta 的体积上限（工具结果可以很大，而 assistant.json 每次改动整份重写）：

```js
/** meta 里单个字符串最多留多少字。 */
const MAX_META_STRING = 1000;

/** meta 里一个数组最多留多少项。 */
const MAX_META_ITEMS = 20;

/** meta 里最多留多少个键。 */
const MAX_META_KEYS = 30;

/** 一条记录的 meta 最多多少字符（超了就再砍字符串）。 */
const MAX_META_CHARS = 4000;

/**
 * 把 meta 里的长字符串、数组、层级收一收。
 *
 * 递归深度也有限：meta 是给界面看的结构化数据，不是数据湖。
 */
function clampMeta(value, limit, depth = 0) {
  if (depth > 4) return '[略]';
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_META_ITEMS).map((item) => clampMeta(item, limit, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_META_KEYS)) {
      out[key] = clampMeta(item, limit, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 给 meta 定一个体积上限。
 *
 * **为什么要有**：规格 §4.4 估的是「每条约 200 字」，
 * 但工具结果（读一个 500 行的文件、跑一条 `ls -la` 的输出）天然可以很大；
 * 而 assistant.json 是**每次改动整份重写**的——
 * 一条撑爆的记录会让每次保存都变贵。
 *
 * 砍体积时**保留结构**：taskId、tool 名这些字段没了就没法把步骤归并回任务了。
 * 所以是「把长字符串砍短」，而不是「只留一段预览」。
 */
export function capMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  let limit = MAX_META_STRING;
  let clamped = clampMeta(meta, limit);
  let text = '';
  try {
    text = JSON.stringify(clamped);
  } catch {
    return null; // 循环引用之类的坏数据：直接不要 meta
  }
  let guard = 0;
  while (text.length > MAX_META_CHARS && guard < 10) {
    limit = Math.max(8, Math.floor(limit / 2));
    clamped = clampMeta(meta, limit);
    try {
      text = JSON.stringify(clamped);
    } catch {
      return null;
    }
    guard += 1;
  }
  return clamped;
}
```

再把「追加一条聊天消息，并截断到上限」那段替换成：

```js
/**
 * 把任意一条消息规整成新形状。
 *
 * 旧记录（用户升级前的数据）只有 `{role, text, at, proactive}`：
 * 这里补上 `id` 与 `kind`（按 role 兜底），并把正文限长。
 *
 * **`role` 由 `kind` 推导**，不是反过来：
 * kind 是新契约，role 只是为兼容旧数据保留的字段。
 * 两个都是真值来源就会自相矛盾——
 * 比如 `{kind:'user'}`（按新契约写、不写 role）会被归一化成 role:'assistant'，
 * 用户自己说的话就以助手的身份进了模型上下文（模型开始自问自答，且不报错）。
 *
 * `id` 用 randomUUID 而不是时间戳：同一毫秒里可能写好几条。
 */
export function normalizeChatEntry(raw) {
  const kind = chatKindOf(raw);
  const role = kind === CHAT_KIND.USER ? 'user' : 'assistant';
  const meta = capMeta(raw?.meta);
  return {
    id: typeof raw?.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    at: Number.isFinite(raw?.at) ? raw.at : Date.now(),
    kind,
    role,
    text: String(raw?.text ?? ''),
    proactive: Boolean(raw?.proactive),
    ...(meta ? { meta } : {}),
  };
}

/**
 * 按分类分路截断：**每路各自砍自己的尾巴**，不动别的路。
 *
 * 砍数组尾巴的做法在有步骤记录之后是错的：
 * 一条新步骤会把最老的用户输入挤掉，而模型恰恰最需要那几条用户输入。
 *
 * 保留的条目维持原有时间顺序。
 */
export function truncateByKind(messages, limits = CHAT_KIND_LIMITS) {
  const list = Array.isArray(messages) ? messages : [];
  const kept = [];
  const counts = new Map();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    const kind = chatKindOf(item);
    const max = Number.isFinite(limits?.[kind]) ? limits[kind] : CHAT_KIND_LIMITS[kind] ?? 0;
    const seen = (counts.get(kind) || 0) + 1;
    if (max > 0 && seen > max) continue;
    counts.set(kind, seen);
    kept.push(item);
  }
  return kept.reverse();
}

/**
 * 追加一条聊天记录，并按分类分路截断。
 *
 * 第三个参数从「总条数上限」变成了「分路上限表」——
 * 旧的调用方（不传第三个参数）行为不变，只是上限表换成了按类的。
 */
export function appendMessage(messages, message, limits = CHAT_KIND_LIMITS) {
  const list = Array.isArray(messages) ? messages : [];
  const next = [...list, normalizeChatEntry(message)];
  return truncateByKind(next, limits);
}
```

- [x] **Step 5: 改 `src/main/assistant/chat/prompt.js` 的过滤规则**

把文件顶部的导入改成：

```js
import {
  EMOTIONS,
  PROMPT_HISTORY_MESSAGES,
  CHAT_KIND_FOR_MODEL,
  chatKindOf,
} from '../../../shared/assistant.js';
```

把 `buildChatMessages` 替换成：

```js
/**
 * 组装要发给接口的消息数组。
 *
 * **只带最近若干条**：磁盘上留的条数按分类分路（见 memory.js），
 * 提示词里只带 12 条——「记多少」与「发多少」是两回事，全发既花钱又稀释重点。
 *
 * **只取 user 与 reply**：步骤、任务状态、审批记录是**给人看的**，
 * 它们进了上下文会把对话冲垮——而且症状是「模型突然变笨」而不是报错，
 * 极难排查。所以过滤放在这里做，且只认 kind 为 user/reply 的条目。
 */
export function buildChatMessages({ history = [], userText = '', trigger = 'user' } = {}) {
  const messages = [];
  const list = Array.isArray(history) ? history : [];
  const conversational = list
    .filter((item) => item && item.text && CHAT_KIND_FOR_MODEL.includes(chatKindOf(item)))
    .slice(-PROMPT_HISTORY_MESSAGES);
  for (const item of conversational) {
    messages.push({
      role: item.role === 'user' ? 'user' : 'assistant',
      content: item.text,
    });
  }
  messages.push({
    role: 'user',
    content: trigger === 'proactive' ? PROACTIVE_TRIGGER : String(userText ?? ''),
  });
  return messages;
}
```

- [x] **Step 6: 改 `src/main/assistant/state.js` 的规整与截断**

把导入改成：

```js
import {
  DEFAULT_TTS,
  DEFAULT_LLM,
  DEFAULT_TAP_LINES,
  POMODORO_PRESETS,
  MAX_CHAT_FACTS,
  hasChatKind,
} from '../../shared/assistant.js';
import { normalizeChatEntry, truncateByKind } from './chat/memory.js';
```

（`MAX_CHAT_MESSAGES` 不再用于截断——截断已经交给 `truncateByKind`，它内部用 `CHAT_KIND_LIMITS`。）

把消息那一段替换成：

```js
  if (isPlainObject(raw.chat)) {
    // 聊天记录：磁盘上的文件是用户与旧版本写出来的，形状可能对不上——
    // 这里保证内存里的状态永远是合法的、也是有限的。
    // **按分类分路截断**（user/reply 留久、step 砍自己的尾巴），
    // 砍数组尾巴会把最老的用户输入挤掉，而那正是模型最需要的。
    const messages = (Array.isArray(raw.chat.messages) ? raw.chat.messages : [])
      .filter(
        (m) =>
          isPlainObject(m) &&
          // 关口认 kind（也认旧 role）：只写 kind 的新记录不能被静默丢掉。
          (hasChatKind(m) || m.role === 'user' || m.role === 'assistant') &&
          // 正文空但 meta 有内容的记录要留下：
          // 「工具调了但没有可展示的正文」是步骤记录的正常形态。
          (str(m.text) !== '' || (isPlainObject(m.meta) && Object.keys(m.meta).length > 0))
      )
      .map((m) => normalizeChatEntry({ ...m, text: str(m.text).slice(0, 2000) }));
    out.chat.messages = truncateByKind(messages);
```

- [x] **Step 7: 改 `src/main/assistant/index.js` 的 `chatHistoryView`**

把 `chatHistoryView` 替换成：

```js
  /**
   * 聊天记录（插件界面用）。
   *
   * **带上 kind**：以后记录里会混进任务、步骤、审批，
   * 界面要按分类分区显示；不带 kind 的话界面只能靠 role 猜。
   */
  function chatHistoryView() {
    const messages = (state.chat.messages || []).map((m) => ({
      id: m.id,
      kind: chatKindOf(m),
      role: m.role,
      text: m.text,
      at: m.at,
      proactive: Boolean(m.proactive),
      ...(m.meta ? { meta: m.meta } : {}),
    }));
    return { messages, total: messages.length, facts: [...(state.chat.facts || [])] };
  }
```

并在 `src/main/assistant/index.js` 顶部的 shared 导入里加上 `chatKindOf`（`chatKindOf` 从 `../../shared/assistant.js` 导入——先确认该文件现有的 shared 导入语句，按它的写法加一项）。

- [x] **Step 8: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-record.test.js"`

Expected: PASS —— 15 个测试全过（复审补了 4 例：role 由 kind 推导 / 旧数据兼容 / 只写 kind 的记录不被丢掉 / meta 体积上限）。

- [x] **Step 9: 跑全量单元测试，确认没有回归**

Run: `npm run test:unit`

Expected: PASS —— 193 个原有测试 + 11 个新测试全过（原数 193）。

- [x] **Step 10: 提交**

```bash
git add src/shared/assistant.js src/main/assistant/chat/memory.js src/main/assistant/chat/prompt.js src/main/assistant/state.js src/main/assistant/index.js test/unit/agent-record.test.js
git commit -m "feat(助手): 聊天记录升级成分类记录——按 kind 分路截断，只把 user/reply 喂给模型"
```

---

### Task 3: T2 LLM 客户端支持 tools

**Files:**
- Modify: `src/main/assistant/llm/openai.js`
- Test: `test/unit/agent-tools-stream.test.js`

**Interfaces:**
- Consumes: Task 1 的探测结论（若结论是 `unsupported`，**本任务不要开始**——先找用户）
- Produces:
  - `toRequestTools(tools) → [{ type:'function', function:{ name, description, parameters } }]`
  - `createToolCallAccumulator() → { push(deltaCalls), calls(), size }`
    - `push` 接受 `choices[].delta.tool_calls[]` 的原始分片；**按 `index` 累积**。
    - `calls()` 返回按 index 升序的 `[{ id, type:'function', function:{ name, arguments } }]`。
  - `parseFrame(frame) → { content: string, toolCalls: object[] }`（一帧 SSE 的解析结果）
  - `buildRequestBody({ ..., tools })` —— 新增 `tools` 参数；**空数组时不发 `tools` 字段**
  - `chatCompletion(params, fetchImpl)` —— 返回值新增 `toolCalls`
  - `chatCompletionStream(params, { ... })` —— 返回值新增 `toolCalls`；参数新增 `tools`
  - `chatCompletionWithProbe` / `chatCompletionStreamWithProbe` —— 返回值透传 `toolCalls`

**与后续任务的接口约定（pre-flight）:** L2 的 agent 循环（T7）会这样用——
`tools` 传工具描述符数组（`{name, description, parameters}`），
从 `chatCompletionStream` 的返回值里拿 `toolCalls`，再把每个调用变成一条
`{ role:'tool', tool_call_id: call.id, content: '结果文本' }` 消息追加进 messages。
所以 `toolCalls[].id` 必须**原样带回**给接口。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-tools-stream.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRequestBody,
  createToolCallAccumulator,
  parseFrame,
  toRequestTools,
  chatCompletion,
  chatCompletionStream,
} from '../../src/main/assistant/llm/openai.js';

/**
 * LLM 客户端的工具支持。
 *
 * **最大的坑：流式下的 `tool_calls` 是分片的。**
 * `choices[].delta.tool_calls[]` 里的 `function.arguments` 是一段被网络切碎的 JSON 字符串，
 * 按 `index` 到达——每帧单独 parse 必然失败；按到达顺序拼接而不看 index 也必然错位。
 */

/** 造一个假的 SSE 响应。 */
function sseResponse(frames) {
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : '') },
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          releaseLock() {},
        };
      },
    },
    text: async () => body,
  };
}

/** 一个假的服务端响应（非流式）。 */
function jsonResponse(obj) {
  const body = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => body,
  };
}

const TOOL = {
  name: 'weather.get',
  label: '查天气',
  description: '按城市名查当前天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
};

test('请求体：tools 转成 OpenAI 兼容格式', () => {
  assert.deepEqual(toRequestTools([TOOL]), [
    {
      type: 'function',
      function: {
        name: 'weather.get',
        description: '按城市名查当前天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      },
    },
  ]);
});

test('请求体：没有工具时**不发** tools 字段', () => {
  const body = buildRequestBody({ model: 'm', messages: [] });
  assert.equal('tools' in body, false, '有的服务端见到空数组直接 400');
  const body2 = buildRequestBody({ model: 'm', messages: [], tools: [TOOL] });
  assert.equal(body2.tools.length, 1);
});

test('消息：role:"tool" 的消息原样带上去', () => {
  const messages = [
    { role: 'user', content: '查天气' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather.get', arguments: '{"city":"北京"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '北京 晴 26℃' },
  ];
  const body = buildRequestBody({ model: 'm', messages });
  assert.deepEqual(body.messages, messages);
  assert.equal(body.messages[2].tool_call_id, 'call_1');
});

test('累积：分片的 arguments 要按 index 拼成一整段', () => {
  const acc = createToolCallAccumulator();
  acc.push([{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{"ci' } }]);
  acc.push([{ index: 0, function: { arguments: 'ty":"北' } }]);
  acc.push([{ index: 0, function: { arguments: '京"}' } }]);
  const calls = acc.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_1');
  assert.equal(calls[0].function.name, 'weather.get');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: '北京' });
});

test('累积：并行调用交错到达时不能错位', () => {
  const acc = createToolCallAccumulator();
  // 第二个调用的第一片**先**到——按到达顺序拼接必然粘在一起。
  acc.push([{ index: 1, id: 'call_2', function: { name: 'fs.list', arguments: '{"pa' } }]);
  acc.push([{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{"ci' } }]);
  acc.push([{ index: 1, function: { arguments: 'th":"src"}' } }]);
  acc.push([{ index: 0, function: { arguments: 'ty":"北京"}' } }]);
  const calls = acc.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, 'call_1', '按 index 排序');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: '北京' });
  assert.equal(calls[1].id, 'call_2');
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { path: 'src' });
});

test('解析：一帧里的 tool_calls 与正文都认', () => {
  const parsed = parseFrame(
    JSON.stringify({
      choices: [{ delta: { content: '好的', tool_calls: [{ index: 0, id: 'c1', function: { name: 'x' } }] } }],
    })
  );
  assert.equal(parsed.content, '好的');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].id, 'c1');
});

test('流式：tool_calls 被正确累积出来', async () => {
  const frames = [
    JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] } }] }),
  ];
  const result = await chatCompletionStream(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    { fetchImpl: async () => sseResponse(frames) },
  );
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { city: '北京' });
});

test('流式：只调工具、没有正文时**不算**「接口没有返回内容」', async () => {
  const frames = [
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather.get', arguments: '{"city":"北京"}' } }] } }] }),
  ];
  const result = await chatCompletionStream(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    { fetchImpl: async () => sseResponse(frames) },
  );
  assert.equal(result.text, '');
  assert.equal(result.toolCalls.length, 1);
});

test('非流式：正文为空但有 tool_calls 时不报错', async () => {
  const body = {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather.get', arguments: '{"city":"北京"}' } }],
        },
      },
    ],
  };
  const result = await chatCompletion(
    { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', messages: [], tools: [TOOL] },
    async () => jsonResponse(body),
  );
  assert.equal(result.text, '');
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { city: '北京' });
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-tools-stream.test.js"`

Expected: FAIL —— `toRequestTools` / `createToolCallAccumulator` / `parseFrame` 未导出（`SyntaxError: does not provide an export named 'toRequestTools'`）。

- [x] **Step 3: 给 `openai.js` 加工具相关的纯函数**

在 `LLM_ERRORS` 定义之后、`export class LlmError` 之前插入：

```js
/**
 * 把工具描述符转成 OpenAI 兼容的 `tools` 字段。
 *
 * 我们自己的工具描述符是 `{name, label, description, parameters, risk, run}`，
 * 接口只认 `{name, description, parameters}`——`label`（给人看的）与
 * `risk`（审批用）**不能**发出去，有些服务端见到不认识的字段直接 400。
 */
export function toRequestTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list
    .filter((t) => t && typeof t.name === 'string' && t.name !== '')
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: String(t.description || ''),
        parameters:
          t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: {} },
      },
    }));
}

/**
 * 流式 `tool_calls` 的累积器。
 *
 * **这是整个 tools 支持里最容易做错的地方。**
 * `choices[].delta.tool_calls[]` 里的 `function.arguments` 是一段被网络切碎的
 * JSON 字符串，按 `index` 到达：
 *
 * - 每帧单独 parse 必然失败（JSON 是碎的）；
 * - 按**到达顺序**拼接而不看 index 也必然错位（并行调用会交错到达）。
 *
 * 所以：按 `index` 归堆，参数按到达顺序拼进同一堆，最后按 index 升序输出。
 */
export function createToolCallAccumulator() {
  const byIndex = new Map();
  return {
    /** 收一帧的 `delta.tool_calls`。 */
    push(deltaCalls) {
      for (const call of Array.isArray(deltaCalls) ? deltaCalls : []) {
        const index = Number.isFinite(call?.index) ? call.index : 0;
        const current = byIndex.get(index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (typeof call?.id === 'string' && call.id) current.id = call.id;
        if (typeof call?.type === 'string' && call.type) current.type = call.type;
        const name = call?.function?.name;
        if (typeof name === 'string' && name) {
          if (!current.function.name) {
            current.function.name = name;
          } else if (name !== current.function.name) {
            // 服务端重发完整名 → 替换；真的是碎片 → 续上。
            if (name.startsWith(current.function.name)) current.function.name = name;
            else current.function.name += name;
          }
        }
        const args = call?.function?.arguments;
        if (typeof args === 'string') current.function.arguments += args;
        byIndex.set(index, current);
      }
    },
    /** 按 index 升序返回完整的调用。 */
    calls() {
      return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => ({ ...call, function: { ...call.function } }));
    },
    get size() {
      return byIndex.size;
    },
  };
}
```

- [x] **Step 4: 加 `parseFrame`，删掉 `extractDelta`**

把 `extractDelta` 替换成：

```js
/**
 * 解析一帧 SSE，返回正文与 tool_calls 分片。
 *
 * 兼容三种形态：`delta.content`（流式）、`message.content`（非流式）、
 * `text`（老接口）。
 *
 * **不读 `reasoning_content`**：那是推理模型的心里的想法，
 * 而且可能夹着我们约定的元数据——显示出来既奇怪又可能泄底。
 */
export function parseFrame(frame) {
  const text = String(frame ?? '').trim();
  if (!text || text === '[DONE]') return { content: '', toolCalls: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError('接口返回的不是合法的 JSON', { code: LLM_ERRORS.MALFORMED });
  }
  if (data?.error) {
    const message = data.error?.message || '接口返回错误';
    throw new LlmError(message, { code: classifyErrorCode(data.error?.code ?? data.error?.type) });
  }
  const choice = data?.choices?.[0];
  if (!choice) return { content: '', toolCalls: [] };
  const content = choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
  const toolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls ?? [];
  return {
    content: typeof content === 'string' ? content : '',
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
  };
}
```

（`extractDelta` 一起删掉：流式重构后它已经没有调用方，
留着会让下一个人以为它是流式解析的入口。）

- [x] **Step 5: `buildRequestBody` 支持 `tools`**

把 `buildRequestBody` 替换成：

```js
/** 组装请求体。 */
export function buildRequestBody({
  model,
  messages,
  temperature,
  maxTokens,
  maxTokensField = 'max_tokens',
  stream = false,
  tools = [],
} = {}) {
  // 只发一个 token 字段：两个都发的话有的服务端会直接 400。
  const field = maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
  const body = {
    model: String(model || ''),
    messages: Array.isArray(messages) ? messages : [],
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    [field]: Number.isFinite(maxTokens) ? Math.round(maxTokens) : 800,
    stream: Boolean(stream),
  };
  // **空数组不发**：有的服务端见到 `tools: []` 直接 400。
  const requestTools = toRequestTools(tools);
  if (requestTools.length) body.tools = requestTools;
  return body;
}
```

- [x] **Step 6: `chatCompletion`（非流式）支持工具**

把 `chatCompletion` 里的「解析响应」那一段替换成：

```js
  const text = await res.text();
  const parsed = parseCompletionBody(text);
  if (!parsed) {
    throw new LlmError('接口没有返回内容', {
      code: LLM_ERRORS.MALFORMED,
      body: String(text).slice(0, 500),
    });
  }
  // **正文为空不一定是错**：模型可能只调工具、不说话。
  // **非流式的 tool_calls 是完整的**：按数组顺序映射，
  // **不要**塞进按 index 累积的堆——非流式的调用没有 index，
  // 两条并行调用会挤进同一堆（名字拼成 "a.getb.list"、参数拼成两段 JSON）。
  const toolCalls = normalizeToolCalls(parsed.toolCalls);
  if (!parsed.content && !toolCalls.length) {
    throw new LlmError('接口没有返回内容', {
      code: LLM_ERRORS.MALFORMED,
      body: String(text).slice(0, 500),
    });
  }
  return { text: parsed.content, raw: parsed.raw, toolCalls };
```

并补一个按数组顺序映射的辅助函数（放在 `parseCompletionBody` 旁边）：

```js
/**
 * 非流式响应里的 tool_calls 本来就是完整的（没有 index，也没有碎片）。
 *
 * 所以不能用流式那套「按 index 累积」的堆：
 * 非流式的每个调用都没有 index，全部落进 index 0 →
 * 两条并行调用被合成一条，agent 循环当场断掉。
 * 这里按**数组顺序**映射，一一对应。
 */
function normalizeToolCalls(list) {
  return (Array.isArray(list) ? list : []).map((call, i) => ({
    id: typeof call?.id === 'string' && call.id ? call.id : `call_${i}`,
    type: typeof call?.type === 'string' && call.type ? call.type : 'function',
    function: {
      name: String(call?.function?.name ?? ''),
      arguments: String(call?.function?.arguments ?? ''),
    },
  }));
}
```

并把 `chatCompletion` 的参数解构改成（多一个 `tools`，并传进请求体）：

```js
export async function chatCompletion(params, fetchImpl = fetch) {
  const { apiKey, baseUrl, model, messages, temperature, maxTokens, maxTokensField, tools } = params;
```

请求体那行改成：

```js
      body: JSON.stringify(
        buildRequestBody({ model, messages, temperature, maxTokens, maxTokensField, stream: false, tools })
      ),
```

另外新增一个解析函数（放在 `extractWholeText` 旁边）：

```js
/**
 * 从一整段 JSON 里取正文与 tool_calls（非流式响应）。
 *
 * 返回 null 表示这根本不是合法 JSON。
 */
function parseCompletionBody(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? '';
  const toolCalls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls ?? [];
  return {
    content: typeof content === 'string' ? content : '',
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    raw: data,
  };
}
```

- [x] **Step 7: `chatCompletionStream`（流式）支持工具**

把 `chatCompletionStream` 里的相关部分改掉：

参数解构加上 `tools`：

```js
export async function chatCompletionStream(params, { fetchImpl = fetch, onDelta, signal } = {}) {
  const { apiKey, baseUrl, model, messages, temperature, maxTokens, maxTokensField, tools } = params;
```

请求体那行改成：

```js
      body: JSON.stringify(
        buildRequestBody({ model, messages, temperature, maxTokens, maxTokensField, stream: true, tools })
      ),
```

「非 SSE 就整块读」那段改成（顺便认 tool_calls）：

```js
  const contentType = headerValue(res, 'content-type');
  if (!contentType.includes('text/event-stream')) {
    const text = await res.text();
    const whole = parseCompletionBody(text);
    if (whole && (whole.content || whole.toolCalls.length)) {
      if (whole.content) onDelta?.(whole.content);
      // 整段 JSON 里的 tool_calls 同样是完整的：按数组顺序映射，不塞进按 index 的堆。
      const toolCalls = normalizeToolCalls(whole.toolCalls);
      if (toolCalls.length) onToolCall?.(toolCalls);
      return { text: whole.content, toolCalls };
    }
    throw new LlmError('接口返回的不是 SSE 也不是 JSON', {
      code: LLM_ERRORS.MALFORMED,
      body: String(text).slice(0, 500),
    });
  }
```

流式主循环：

```js
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let done = false;
  const toolAccumulator = createToolCallAccumulator();

  try {
    for await (const bytes of readChunks(res)) {
      buffer += decoder.decode(bytes, { stream: true });
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame === '[DONE]') {
          done = true;
          break;
        }
        const { content, toolCalls } = parseFrame(frame);
        if (toolCalls.length) {
          toolAccumulator.push(toolCalls);
          onToolCall?.(toolCalls);
        }
        if (content) {
          full += content;
          onDelta?.(content);
        }
      }
      if (done) break;
    }
  } catch (err) {
    // 流到一半断了：也要归类，不然地址探测会以为「还没吐过字」而重试——
    // 用户会看到重复的半句。
    if (err instanceof LlmError) throw err;
    throw new LlmError(`连接中断：${err?.message || err}`, { code: LLM_ERRORS.NETWORK });
  }

  if (!done) {
    // 冲掉解码器里的残留字节，并处理「最后一帧后面没有空行」的情况。
    buffer += decoder.decode();
    const { frames } = splitSseFrames(`${buffer}\n\n`);
    for (const frame of frames) {
      if (frame === '[DONE]') break;
      const { content, toolCalls } = parseFrame(frame);
      if (toolCalls.length) {
        toolAccumulator.push(toolCalls);
        onToolCall?.(toolCalls);
      }
      if (content) {
        full += content;
        onDelta?.(content);
      }
    }
  }

  return { text: full, toolCalls: toolAccumulator.calls() };
```

- [x] **Step 8: 探测版函数透传 `toolCalls`，且中断后不换地址重发**

`chatCompletionStreamWithProbe` 里，`emitted` 的计数要把「有 tool_calls 的帧」也算作「已经开始吐东西」——
否则一次中断会被当成「还没吐过字」而换个地址重试，用户会看到重复的动作。

**关键**：这个计数必须在**流的过程中**就能观察到，
不能等 `chatCompletionStream` 返回之后再补——那时要么成功了（用不上），要么抛错了（补不上了）。
所以给 `chatCompletionStream` 加一个 `onToolCall` 回调：

```js
export async function chatCompletionStream(params, { fetchImpl = fetch, onDelta, onToolCall, signal } = {}) {
  // …
        if (toolCalls.length) {
          toolAccumulator.push(toolCalls);
          onToolCall?.(toolCalls);
        }
```

探测版里挂上它：

```js
      const result = await chatCompletionStream({ ...params, baseUrl }, {
        fetchImpl,
        onDelta: (delta) => {
          emitted += 1;
          onDelta?.(delta);
        },
        // 工具调用也算「已经开始吐东西」：只调工具的轮次正文是空的，
        // 模型已经决定了要调什么工具——换个地址重发会让用户看到重复的动作。
        onToolCall: () => {
          emitted += 1;
        },
      });
      return { ...result, baseUrl };
```

`chatCompletionWithProbe` 的返回值本来就是 `{ ...result, baseUrl }`，`result` 里已经多了 `toolCalls`——不用改。

- [x] **Step 9: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-tools-stream.test.js"`

Expected: PASS —— 16 个测试全过（复审补了 7 例：非流式并行 / 整段 JSON 并行 / 碎片工具名 / 重发完整名 / 中断不换地址）。

- [x] **Step 10: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 193 + 15 + 16 = 224 个测试全过。

- [x] **Step 11: 提交**

```bash
git add src/main/assistant/llm/openai.js test/unit/agent-tools-stream.test.js
git commit -m "feat(助手): LLM 客户端支持 tools——请求带工具、能发 tool 消息、能累积分片的 tool_calls"
```

---

## 自查（写完计划后对着规格过一遍）

- **规格覆盖**：本计划只实现 §14 的 L0 三项——T0（Task 1）、T1（Task 2）、T2（Task 3）。L1 及以后不在本计划范围内。
- **占位符扫描**：无 TBD / TODO / 「类似 Task N」；每段实现代码都写全了。
- **类型一致性**：`CHAT_KIND` / `chatKindOf` / `normalizeChatEntry` / `truncateByKind` 的名字在 Task 2 的接口段、测试、步骤里一致；`toRequestTools` / `createToolCallAccumulator` / `parseFrame` 在 Task 3 里一致。Task 2 产出的 `kind` 取值与规格 §4.2 逐字一致。
- **Review Focus 覆盖**：五条焦点分别被 `agent-record.test.js` 的「旧记录按 role 兜底」「分路截断不挤掉用户输入」「磁盘旧数据规整」与 `agent-tools-stream.test.js` 的「并行交错」「正文为空不算错」「role:'tool' 原样带上」覆盖。
