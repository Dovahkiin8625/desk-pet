# 桌宠内置 Agent 运行时 · L2 agent 循环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 L2 的两件事做完——**agent 循环**（T7：多步、能调工具、错误喂回模型）与**系统提示词与上下文管理**（T8：工具表 / 工作区 / 审批策略进提示词，上下文不超限）。

**Architecture:** 三块，按依赖排队：

```
T8  agent/prompt.js    agent 的系统提示词（人设 + 工具表 + 工作区 + 审批策略）
                       + 上下文压缩（轮数上限、字数上限、工具结果截断）
   │
   ▼
T7a agent/loop.js      循环本体：调模型 → 有 tool_calls 就执行工具 → 结果喂回去 → 再来一轮
   │
   ▼
T7b chat/agent.js      后端适配（id: 'agent'）+ 接线到 index.js / shared 的 backend 取值
```

- **为什么先做提示词**：循环每一轮都要带系统提示词，先写提示词，循环才有东西可带。
  （规格 §14 的依赖表把 T8 排在 T7 之后，那是**执行顺序**不是依赖方向；
  两块都在 L2 里，先后由实现需要决定。）
- **这一层不做后台任务**：运行时（队列、并发、取消）是 L3 的 T9。
  L2 的循环是**前台一次跑完**的，被取消/排队是 L3 的事。
- **这一层不做审批气泡**：审批闸门（策略、永久放行、气泡）是 L3 的 T10。
  L2 留好接缝：`gate` 没接上时，**写与执行类工具一律不执行**，只读工具照常。

**Tech Stack:** Electron + Node（`node --test` 跑单元测试，无测试框架依赖）。
循环与提示词**都不 import electron**——它们是 agent 的脑子，必须能在普通 node 里测。

**Spec:** `docs/superpowers/specs/2026-11-07-agent-runtime-design.md`（本计划实现 §14 里的 **L2 · agent 循环** 两项：T7 / T8，以及 §6.1 的循环骨架、§5.1 的工具描述符、§12 的错误处理）

## Global Constraints

- **注释与文档用中文。** 每个文件开头一段块注释，说明「这是什么」和「为什么这么写」；反直觉的设计尤其要写清楚不这么写会怎样。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `fix(助手): …` / `test(助手): …` / `docs(助手): …`。
- **能被测到的改动，先写测试。** 每个任务都按 RED→GREEN 走。
- **Edit 的 `file_path` 必须是绝对路径。**
- **契约只有一份**：对话后端的取值放在 `src/shared/assistant.js`（`LLM_BACKENDS`），状态清洗与后端注册都从那里取。
- **不碰 L3 及以后**：不写 `agent/runtime.js`、不写 `agent/approval.js`、不碰审批气泡、不碰后台任务与记录落盘。
- **不碰用户的真实配置**：单元测试用注入的假模型、假工具、临时目录；不读真实 `assistant.json`。
- 单元测试命令：`npm run test:unit`（等价于 `node --test "test/unit/**/*.test.js"`）。

## 这几件事最容易做错（写代码时反复看）

1. **assistant 的 `tool_calls` 消息与 `tool` 消息必须一一对应。**
   OpenAI 兼容接口收到「有 tool_calls 却没有对应的 tool 结果」直接 400；
   反过来「有 tool 结果却没有 tool_calls」也一样。
   所以：**每个 tool_call 都要有一条 `role:'tool'` 的消息**（哪怕内容是错误说明）。
2. **压缩上下文不能只丢 `tool` 消息。**
   丢 tool 消息却留着那条带 `tool_calls` 的 assistant 消息 → 接口报错。
   **一轮 = assistant(tool_calls) + 后面连续的若干条 tool 消息**，要整轮一起丢。
3. **工具结果要截断再进上下文。**
   `fs.read` 能读 2MB，一个 `shell.exec` 的输出能有几千行。
   不截断的话，几步就把上下文撑爆——症状是「模型突然变笨」，不是报错。
4. **工具出错不终止任务**：错误要**写成一条 `role:'tool'` 的消息喂回模型**，
   模型才能换个参数再试。直接终止的话，用户得到的是「agent 报错」而不是结果。
5. **未知工具、参数不是合法 JSON**，同样喂回模型，不终止。
6. **没有审批闸门时，写/执行类工具一律不执行。**
   L2 没有审批气泡（那是 L3），用户根本没机会点头——那就不许动他的机器。
   只读工具照常（只读被工作区关着，见 L1 的路径边界）。
7. **最终答复要过 `parseReply`**：情绪、心情、记忆都靠 `<<META>>` 那一段，
   气泡与心情联动才和普通对话一致。
8. **步数用尽不是崩溃**：给用户一句「我没能在 N 步内做完」，不能给一个空气泡。
9. **`baseUrl` 要透传**：探测出来的可用地址要记下来（和 `chat` 后端一样）。

## Review Focus

以下是规格暗示、但**没有一个任务的测试会覆盖**的输入类与失败模式。按「最可能先咬到人的」排序：

1. **模型调了一个不存在的工具名** → 循环不能死，要让模型自己纠正（规格 §12 第一行）。
2. **工具的参数不是合法 JSON**（模型手抖切断了 JSON）→ 同上，喂回模型。
3. **同一个工具连续失败 3 次** → 停下来并说明原因，不能无限重试烧 token（规格 §12）。
4. **步数用尽** → 要有兜底答复，气泡不能是空的（规格 §12「步骤用尽」）。
5. **模型不支持 tools（HTTP 400）** → 要提示「这个模型不支持工具调用，建议切回普通对话」，
   而不是把 400 的原文甩给用户（规格 §12 最后一行）。
6. **上下文被工具结果撑爆** → 要能被压缩掉，且压缩后接口不报错（不能留下孤零零的 tool 消息）。
7. **用户拒绝了这次调用** → 是**给模型一个否定的信号**，不是终止任务（规格 §8.2）。
8. **模型在同一轮里调了多个工具** → 每个都要有自己的 tool 结果消息。

---

### Task 1: T8 系统提示词与上下文压缩

**Files:**
- Create: `src/main/assistant/agent/prompt.js`
- Modify: `src/main/assistant/chat/prompt.js`（把输出契约抽成共用的 `metaContractLines()`）
- Test: `test/unit/agent-prompt.test.js`

**Interfaces:**
- Consumes:
  - `src/main/assistant/chat/prompt.js` 的 `META_MARKER`（导出）
  - `src/shared/assistant.js` 的 `EMOTIONS`、`TOOL_RISK`
- Produces:
  - `src/main/assistant/chat/prompt.js`：`metaContractLines() → string[]`
  - `src/main/assistant/agent/prompt.js`：
    - `MAX_AGENT_CONTEXT_STEPS = 8`
    - `MAX_AGENT_CONTEXT_CHARS = 24000`
    - `MAX_AGENT_TOOL_RESULT_CHARS = 1500`
    - `buildAgentSystemPrompt({ persona, facts, tools, workspace, approval, now }) → string`
    - `truncateToolResult(text) → string`
    - `compactAgentMessages(messages, { maxSteps, maxChars }) → { messages, dropped }`
    - `compactionNote(dropped) → string`

**描述符的形状**（规格 §5.1，agent 这边只用到给模型看的那几个字段）：
`{ name, label, description, parameters, risk, run }`。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-prompt.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AGENT_CONTEXT_CHARS,
  MAX_AGENT_CONTEXT_STEPS,
  MAX_AGENT_TOOL_RESULT_CHARS,
  buildAgentSystemPrompt,
  compactAgentMessages,
  compactionNote,
  truncateToolResult,
} from '../../src/main/assistant/agent/prompt.js';

/** 两只工具：一读一执行。 */
const TOOLS = [
  {
    name: 'fs.read',
    label: '读文件',
    description: '读一个文本文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
    risk: 'read',
  },
  {
    name: 'shell.exec',
    label: '执行命令',
    description: '执行一条命令。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' } },
      required: ['command'],
    },
    risk: 'exec',
  },
];

/** 造一轮工具调用：assistant(tool_calls) + 一条 tool 结果。 */
function round(index, size = 10) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: `c${index}`, type: 'function', function: { name: 'fs.read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `c${index}`, content: 'x'.repeat(size) },
  ];
}

/** 上下文里所有 assistant 的 tool_calls 都要有对应的 tool 结果。 */
function assertToolMessagesMatch(messages) {
  const ids = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) {
      assert.ok(ids.includes(c.id), `缺 tool 结果：${c.id}`);
    }
  }
}

test('提示词：工具表、工作区、审批策略、人设、记忆都在里面', () => {
  const prompt = buildAgentSystemPrompt({
    persona: { name: '小桌', style: '活泼、亲切', backstory: '' },
    facts: ['用户喜欢喝美式'],
    tools: TOOLS,
    workspace: 'E:/project/desk-pet',
    approval: { policy: 'graded', allowAlways: ['fs.read'] },
    now: new Date('2026-11-07T10:00:00'),
  });
  assert.match(prompt, /小桌/);
  assert.match(prompt, /活泼、亲切/);
  assert.match(prompt, /fs\.read/);
  assert.match(prompt, /shell\.exec/);
  assert.match(prompt, /E:\/project\/desk-pet/);
  assert.match(prompt, /graded/);
  assert.match(prompt, /用户喜欢喝美式/);
  assert.match(prompt, /<<META>>/);
});

test('提示词：工作区为空时说清楚是用户主目录', () => {
  const prompt = buildAgentSystemPrompt({ tools: TOOLS, workspace: '' });
  assert.match(prompt, /用户主目录/);
});

test('提示词：一个工具都没有时，不列工具表', () => {
  const prompt = buildAgentSystemPrompt({ tools: [] });
  assert.doesNotMatch(prompt, /shell\.exec/);
});

test('工具结果超长要截断，而且要留痕', () => {
  const out = truncateToolResult('x'.repeat(MAX_AGENT_TOOL_RESULT_CHARS + 200));
  assert.ok(out.length < MAX_AGENT_TOOL_RESULT_CHARS + 200);
  assert.match(out, /已截断/);
});

test('工具结果不长就原样返回', () => {
  assert.equal(truncateToolResult('短短一句话'), '短短一句话');
});

test('上下文压缩：轮数超上限就丢最老的轮', () => {
  const messages = [{ role: 'user', content: '帮我看看' }, ...round(1), ...round(2), ...round(3)];
  const { messages: out, dropped } = compactAgentMessages(messages, { maxSteps: 2 });
  assert.equal(dropped, 1);
  assert.equal(out[0].role, 'user');
  assert.equal(out.filter((m) => m.role === 'tool').length, 2);
  assertToolMessagesMatch(out);
});

test('上下文压缩：不能留下孤零零的 tool 消息', () => {
  const messages = [{ role: 'user', content: '帮我看看' }, ...round(1), ...round(2), ...round(3)];
  const { messages: out } = compactAgentMessages(messages, { maxSteps: 1 });
  assert.equal(out.filter((m) => m.role === 'tool').length, 1);
  assertToolMessagesMatch(out);
  // 第一条绝不能是 tool：接口看到开头的 tool 消息会直接报错。
  assert.notEqual(out[0].role, 'tool');
});

test('上下文压缩：字数超上限也要压下去', () => {
  const messages = [{ role: 'user', content: 'x' }, ...round(1, 5000), ...round(2, 5000)];
  const { messages: out } = compactAgentMessages(messages, { maxSteps: 8, maxChars: 6000 });
  const chars = out.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(chars <= 6000, `还有 ${chars} 字没压下去`);
  assertToolMessagesMatch(out);
});

test('上下文压缩：本来就不超就什么都不动', () => {
  const messages = [{ role: 'user', content: 'x' }, ...round(1)];
  const { messages: out, dropped } = compactAgentMessages(messages, {});
  assert.equal(dropped, 0);
  assert.equal(out.length, messages.length);
});

test('压缩说明：丢了几轮就说几轮', () => {
  assert.equal(compactionNote(0), '');
  assert.match(compactionNote(3), /3/);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-prompt.test.js"`

Expected: FAIL —— `src/main/assistant/agent/prompt.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 写 `src/main/assistant/agent/prompt.js`**

```js
import { EMOTIONS, TOOL_RISK } from '../../../shared/assistant.js';
import { META_MARKER, metaContractLines } from '../chat/prompt.js';

/**
 * agent 的系统提示词与上下文管理。
 *
 * ## 为什么 agent 要另有一份提示词
 *
 * 普通对话的提示词（chat/prompt.js）是「陪用户聊天」：
 * 1~3 句、80 字以内、别提工具。
 *
 * agent 的提示词要多三样东西：
 * - **工具表**：模型看不见没列出来的工具，就不会去调它；
 * - **工作区**：相对路径都相对它；
 * - **审批策略**：模型得知道「写文件可能要用户点头」，才不会以为调了就是成了。
 *
 * ## 上下文压缩为什么在这儿
 *
 * 一次任务可能有十几步，每步的工具结果都进上下文——
 * `fs.read` 能读 2MB，不压的话几步就把上下文撑爆，
 * 而症状是「模型突然变笨」而不是报错，极难排查。
 *
 * **压缩的单位是「轮」**：一轮 = assistant(带 tool_calls) + 后面连续的若干条 tool 消息。
 * 只丢 tool 消息而留着 assistant 那条，接口会因为「tool_calls 没有对应的结果」直接报错。
 */

/** 上下文里最多留几轮工具调用。 */
export const MAX_AGENT_CONTEXT_STEPS = 8;

/** 上下文里最多留多少字（工具结果 + 助手的话 + 工具参数）。 */
export const MAX_AGENT_CONTEXT_CHARS = 24000;

/** 一条工具结果最多进上下文多少字。 */
export const MAX_AGENT_TOOL_RESULT_CHARS = 1500;

/** 心情增量的上下限（与普通对话一致）。 */
const MAX_MOOD = 10;

/**
 * 审批策略的说明。
 *
 * 给模型看的措辞要**说清楚后果**：模型知道「可能被拒绝」，
 * 才会准备好「被拒绝了怎么办」的下一条路，而不是反复重试同一个调用。
 */
const POLICY_TEXT = {
  auto: 'auto（全部放行，不需要用户确认）',
  graded: 'graded（只读操作直接放行；写入与执行需要用户确认，用户可能拒绝）',
  manual: 'manual（每一步都需要用户确认，用户可能拒绝）',
};

/**
 * 组装 agent 的系统提示词。
 *
 * @param {object} options
 * @param {object} [options.persona] 人设 {name, style, backstory}
 * @param {string[]} [options.facts] 长期记忆
 * @param {object[]} [options.tools] 工具描述符
 * @param {string} [options.workspace] 工作目录（空 = 用户主目录）
 * @param {object} [options.approval] {policy, allowAlways}
 * @param {Date} [options.now]
 */
export function buildAgentSystemPrompt({
  persona = {},
  facts = [],
  tools = [],
  workspace = '',
  approval = {},
  now = new Date(),
} = {}) {
  const name = String(persona?.name || '小桌').trim() || '小桌';
  const style = String(persona?.style || '').trim();
  const backstory = String(persona?.backstory || '').trim();
  const list = Array.isArray(facts) ? facts.filter(Boolean) : [];
  const when = now instanceof Date ? now : new Date(now);
  const toolList = Array.isArray(tools) ? tools.filter((t) => t && t.name) : [];
  const policy = String(approval?.policy || 'graded');
  const allowAlways = Array.isArray(approval?.allowAlways) ? approval.allowAlways : [];
  const workDir = String(workspace || '').trim();

  const lines = [
    `你是「${name}」，一只住在用户桌面上的 Live2D 桌宠。`,
    style ? `你的性格：${style}` : '',
    backstory ? `关于你：${backstory}` : '',
    '',
    '这次你可以动手做事：你有一批工具，需要的话就去用它们查、改、执行，',
    '而不是凭想象编造结果。没把握的宁可不答。',
    '',
    `工作目录：${workDir || '（用户主目录）'}`,
    '相对路径都相对这个目录；上面没写具体路径时就是用户主目录。',
    '',
  ];

  if (toolList.length) {
    lines.push('你有的工具：');
    for (const tool of toolList) {
      const desc = String(tool.description || '').trim();
      const params = describeParameters(tool.parameters);
      lines.push(`- ${tool.name}：${desc}${params ? `（参数：${params}）` : ''}`);
    }
    lines.push('');
  } else {
    lines.push('你现在没有可用的工具，只能用聊天回答。', '');
  }

  lines.push(
    `审批策略：${POLICY_TEXT[policy] || POLICY_TEXT.graded}`,
    allowAlways.length ? `永久放行的工具：${allowAlways.join('、')}` : '',
    '被拒绝不是错误：换个参数或换条路再试，别死磕同一个调用。',
    '',
    '做事的规矩：',
    '- 需要工具才能回答的，就去调工具；不要编造工具的结果。',
    '- 一轮里可以调多个工具，它们各自会给你结果。',
    '- 工具报错时读懂错误，换个参数或换条路再试；同一个错连着出三次就别试了。',
    '- 工具的结果里可能有噪声，自己挑出有用的部分。',
    '',
    '回答规则：',
    '- 用中文口语回答，1~3 句，不超过 120 字：做了什么事、结果如何，一句带过。',
    '- 不要复述用户的问题，不要 Markdown，不要表情符号。',
    ...metaContractLines(),
    list.length ? `\n你记住的事：\n${list.map((f) => `- ${f}`).join('\n')}` : '',
    `现在是 ${when.getFullYear()} 年 ${when.getMonth() + 1} 月 ${when.getDate()} 日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}。`,
  );

  return lines.filter((line) => line !== '').join('\n');
}

/**
 * 把参数的 JSON Schema 说成一句话。
 *
 * 只说「有哪些参数、分别是什么类型、哪些必填」——
 * 把整个 schema 塞进提示词既占地方，模型也用不上那么多细节。
 */
function describeParameters(parameters) {
  const props = parameters?.properties;
  if (!props || typeof props !== 'object') return '';
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  const parts = Object.entries(props).map(([key, value]) => {
    const type = value?.type || 'string';
    return required.includes(key) ? `${key}(${type},必填)` : `${key}(${type})`;
  });
  return parts.join('、');
}

/**
 * 工具结果进上下文前的截断。
 *
 * **截断必须留痕**：模型看到半句话会以为文件就这么多，
 * 于是做出错误判断（比如以为文件读完了）。
 */
export function truncateToolResult(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_AGENT_TOOL_RESULT_CHARS) return s;
  return `${s.slice(0, MAX_AGENT_TOOL_RESULT_CHARS)}…（已截断）`;
}

/**
 * 压缩上下文。
 *
 * 规则（按顺序）：
 * 1. 轮数超上限 → 丢最老的轮；
 * 2. 字数还超 → 继续丢轮（至少留一轮：最后一轮通常正是推进中的那轮）；
 * 3. 还是超 → 把剩下的工具结果再截短（单轮就特别大时才轮得到这一步）。
 *
 * @returns {{messages: object[], dropped: number}} dropped 是丢掉的轮数
 */
export function compactAgentMessages(
  messages,
  { maxSteps = MAX_AGENT_CONTEXT_STEPS, maxChars = MAX_AGENT_CONTEXT_CHARS } = {}
) {
  let list = Array.isArray(messages) ? messages.slice() : [];
  let dropped = 0;

  while (countRounds(list) > maxSteps) {
    list = dropOldestRound(list);
    dropped += 1;
  }
  while (charsOf(list) > maxChars && countRounds(list) > 1) {
    list = dropOldestRound(list);
    dropped += 1;
  }
  if (charsOf(list) > maxChars) {
    list = list.map((m) =>
      m.role === 'tool' ? { ...m, content: truncateText(m.content, 400) } : m
    );
  }
  return { messages: list, dropped };
}

/**
 * 压缩之后要在系统提示词里补的一句说明。
 *
 * 没有它，模型会以为自己没做过那些事，于是把同样的活儿再做一遍。
 */
export function compactionNote(dropped) {
  const n = Number(dropped) || 0;
  if (n <= 0) return '';
  return `（前面 ${n} 轮工具调用已从上下文里省略，它们的结果你看不到；别重复做已经做过的事）`;
}

/** 一轮 = assistant(带 tool_calls) + 后面连续的若干条 tool 消息。 */
function countRounds(messages) {
  return messages.filter(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  ).length;
}

/** 丢掉最老的一轮（assistant 与它的 tool 结果必须一起丢）。 */
function dropOldestRound(messages) {
  const at = messages.findIndex(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
  );
  if (at < 0) return messages;
  let end = at + 1;
  while (end < messages.length && messages[end].role === 'tool') end += 1;
  return [...messages.slice(0, at), ...messages.slice(end)];
}

/** 上下文的字数：正文 + 工具参数。 */
function charsOf(messages) {
  let n = 0;
  for (const m of messages) {
    n += String(m?.content || '').length;
    for (const c of m?.tool_calls || []) {
      n += String(c?.function?.arguments || '').length;
    }
  }
  return n;
}

/** 截到上限（不带留痕——这里已经知道发生过截断了）。 */
function truncateText(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}
```

- [x] **Step 4: 在 `src/main/assistant/chat/prompt.js` 里抽出共用的输出契约**

把 `buildSystemPrompt` 里那五行输出契约改成调用 `metaContractLines()`，并导出它：

```js
/**
 * 输出契约的说明。
 *
 * **普通对话与 agent 共用一份**：两边说不一样的话，
 * 就会出现「普通对话读得出情绪、agent 读不出」这种鬼故事。
 */
export function metaContractLines() {
  return [
    '- 回答写完后，另起一行输出 ' + META_MARKER + '，紧跟一个 JSON 对象（不要代码块围栏）：',
    `  {"emotion":"<情绪>","mood":<整数>,"memories":["<事实>"]}`,
    `- emotion 只能是 ${EMOTIONS.join(' / ')} 之一。`,
    `- mood 是 -${MAX_MOOD} 到 ${MAX_MOOD} 的整数：正数表示这轮让你更开心，负数表示更闷。`,
    '- memories 只写「以后还用得上的、用户身上的事实」，最多 2 条；没有就写 []。',
  ];
}
```

`buildSystemPrompt` 里原来的五行替换成 `...metaContractLines(),`。

- [x] **Step 5: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-prompt.test.js"`

Expected: PASS —— 9 个测试全过。

- [x] **Step 6: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 全部通过（数量 = 之前的总数 + 9）。

- [x] **Step 7: 提交**

```bash
git add src/main/assistant/agent/prompt.js src/main/assistant/chat/prompt.js test/unit/agent-prompt.test.js
git commit -m "feat(助手): agent 的系统提示词与上下文压缩——工具表进提示词，上下文不超限"
```

---

### Task 2: T7a agent 循环

**Files:**
- Create: `src/main/assistant/agent/loop.js`
- Test: `test/unit/agent-loop.test.js`

**Interfaces:**
- Consumes:
  - `src/main/assistant/agent/prompt.js`（Task 1）的 `truncateToolResult`、`compactAgentMessages`、`compactionNote`
  - `src/shared/assistant.js` 的 `TOOL_RISK`
- Produces:
  - `src/main/assistant/agent/loop.js`：
    - `AGENT_OUTCOME = { DONE:'done', MAX_STEPS:'max_steps', REPEATED_ERRORS:'repeated_errors', ABORTED:'aborted' }`
    - `MAX_SAME_ERRORS = 3`
    - `createAgentLoop({ callModel, resolveTool, gate, maxSteps, maxSameErrors, onEvent, logger }) → { run }`
    - `run({ system, messages, tools, signal, onDelta }) → Promise<{ text, steps, outcome, toolCalls, error, baseUrl }>`

**`callModel` 的契约**（循环与模型之间的唯一约定）：

```js
callModel({ system, messages, tools, onDelta, signal }) → Promise<{ text, toolCalls, baseUrl? }>
```

`toolCalls` 是 OpenAI 兼容格式：`[{ id, type, function: { name, arguments } }]`，`arguments` 是**字符串**。

**`gate` 的契约**（审批闸门，L3 才接上）：

```js
gate.request({ tool, args, risk, signal }) → Promise<{ decision: 'allow' | 'deny' }>
```

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-loop.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_OUTCOME, createAgentLoop } from '../../src/main/assistant/agent/loop.js';

/** 造一个只读的假工具。 */
function readTool(onRun = () => {}) {
  return {
    name: 'fs.read',
    label: '读文件',
    description: '读文件',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    async run(args) {
      onRun(args);
      return { text: '文件内容', data: { args } };
    },
  };
}

/** 造一个必失败的工具。 */
function brokenTool(message = '文件不存在') {
  return {
    name: 'fs.read',
    label: '读文件',
    description: '读文件',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    async run() {
      throw new Error(message);
    },
  };
}

/** 一轮工具调用的剧本。 */
function call(name, args = {}, id = 'call_1') {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 假模型：按剧本一轮轮返回。 */
function fakeModel(script) {
  const seen = [];
  let i = 0;
  return {
    seen,
    async callModel({ messages, onDelta }) {
      seen.push(messages);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (step.text) onDelta?.(step.text);
      return { text: step.text || '', toolCalls: step.toolCalls || [] };
    },
  };
}

/** 把一次调用接成循环。 */
function loop(model, { tools = [], gate = null, maxSteps = 20 } = {}) {
  return createAgentLoop({
    callModel: model.callModel,
    resolveTool: (name) => tools.find((t) => t.name === name) || null,
    gate,
    maxSteps,
  });
}

test('多步循环：调工具 → 拿结果 → 再调 → 出结论', async () => {
  const runs = [];
  const tool = readTool((args) => runs.push(args));
  const model = fakeModel([
    { toolCalls: [call('fs.read', { path: 'a.txt' })] },
    { toolCalls: [call('fs.read', { path: 'b.txt' })] },
    { text: '两个文件都读完了' },
  ]);
  const result = await loop(model, { tools: [tool] }).run({
    system: '你是小桌',
    messages: [{ role: 'user', content: '读一下' }],
  });

  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  assert.equal(result.text, '两个文件都读完了');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], { path: 'a.txt' });
  assert.equal(result.steps, 3);
});

test('工具的结果要作为 role:tool 的消息喂回模型', async () => {
  const model = fakeModel([{ toolCalls: [call('fs.read', {})] }, { text: '好了' }]);
  await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  const second = model.seen[1];
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '模型没收到 tool 消息');
  assert.equal(toolMsg.content, '文件内容');
});

test('模型调了不存在的工具：不终止，把错误喂回模型', async () => {
  const model = fakeModel([
    { toolCalls: [call('weather.get', { city: '北京' })] },
    { text: '那个工具我确实没有' },
  ]);
  const result = await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /没有这个工具/);
});

test('工具的参数不是合法 JSON：不终止，把错误喂回模型', async () => {
  const model = fakeModel([
    {
      toolCalls: [
        { id: 'c1', type: 'function', function: { name: 'fs.read', arguments: '{"path":' } },
      ],
    },
    { text: '我换个写法' },
  ]);
  const result = await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /JSON/);
});

test('工具报错：错误喂回模型，模型换条路就成功', async () => {
  let attempt = 0;
  const tool = {
    name: 'fs.read',
    risk: 'read',
    async run() {
      attempt += 1;
      if (attempt === 1) throw new Error('文件不存在');
      return { text: '找到了' };
    },
  };
  const model = fakeModel([
    { toolCalls: [call('fs.read', { path: 'x' })] },
    { toolCalls: [call('fs.read', { path: 'y' })] },
    { text: '好了' },
  ]);
  const result = await loop(model, { tools: [tool] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  assert.equal(result.text, '好了');
  const firstErr = model.seen[1].find((m) => m.role === 'tool');
  assert.match(firstErr.content, /出错/);
});

test('同一个错连着出三次：停下来并说明原因', async () => {
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'x' })] }]);
  const result = await loop(model, { tools: [brokenTool('文件不存在')] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.REPEATED_ERRORS);
  assert.match(result.error, /文件不存在/);
});

test('步数用尽：停下来，且没有结论', async () => {
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'x' })] }]);
  const result = await loop(model, { tools: [readTool()], maxSteps: 3 }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(result.outcome, AGENT_OUTCOME.MAX_STEPS);
  assert.equal(result.text, '');
  assert.equal(result.steps, 3);
});

test('没有审批闸门时：只读工具照常执行', async () => {
  let ran = 0;
  const model = fakeModel([{ toolCalls: [call('fs.read', {})] }, { text: '好了' }]);
  await loop(model, { tools: [readTool(() => { ran += 1; })] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 1);
});

test('没有审批闸门时：执行类工具不执行，理由喂回模型', async () => {
  let ran = 0;
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      ran += 1;
      return { text: '不该出现' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }, { text: '好' }]);
  const result = await loop(model, { tools: [execTool] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 0);
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /审批|确认/);
});

test('闸门拒绝：工具不执行，拒绝是给模型的信号而不是终止', async () => {
  let ran = 0;
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      ran += 1;
      return { text: '不该出现' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }, { text: '那算了' }]);
  const result = await loop(model, {
    tools: [execTool],
    gate: { request: async () => ({ decision: 'deny' }) },
  }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 0);
  assert.equal(result.outcome, AGENT_OUTCOME.DONE);
  assert.equal(result.text, '那算了');
  const toolMsg = model.seen[1].find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /拒绝/);
});

test('闸门放行：工具照常执行', async () => {
  let ran = 0;
  const execTool = {
    name: 'shell.exec',
    risk: 'exec',
    async run() {
      ran += 1;
      return { text: '列出来了' };
    },
  };
  const model = fakeModel([{ toolCalls: [call('shell.exec', { command: 'ls' })] }, { text: '好' }]);
  await loop(model, {
    tools: [execTool],
    gate: { request: async () => ({ decision: 'allow' }) },
  }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  assert.equal(ran, 1);
});

test('一轮里调多个工具：每个都要有自己的 tool 结果', async () => {
  const model = fakeModel([
    {
      toolCalls: [call('fs.read', { path: 'a' }, 'c1'), call('fs.read', { path: 'b' }, 'c2')],
    },
    { text: '都读完了' },
  ]);
  await loop(model, { tools: [readTool()] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
  });
  const toolMsgs = model.seen[1].filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 2);
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2']);
});

test('被取消：停下来，outcome 是 aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const model = fakeModel([{ text: '不该走到这' }]);
  const result = await loop(model, { tools: [] }).run({
    system: 's',
    messages: [{ role: 'user', content: 'u' }],
    signal: controller.signal,
  });
  assert.equal(result.outcome, AGENT_OUTCOME.ABORTED);
});

test('步骤事件：工具调用会发事件', async () => {
  const events = [];
  const model = fakeModel([{ toolCalls: [call('fs.read', { path: 'a' })] }, { text: '好了' }]);
  const l = createAgentLoop({
    callModel: model.callModel,
    resolveTool: (name) => (name === 'fs.read' ? readTool() : null),
    onEvent: (e) => events.push(e),
  });
  await l.run({ system: 's', messages: [{ role: 'user', content: 'u' }] });
  const step = events.find((e) => e.type === 'step');
  assert.ok(step, '没发步骤事件');
  assert.equal(step.tool, 'fs.read');
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-loop.test.js"`

Expected: FAIL —— `src/main/assistant/agent/loop.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 写 `src/main/assistant/agent/loop.js`**

```js
import { TOOL_RISK } from '../../../shared/assistant.js';
import { compactAgentMessages, compactionNote, truncateToolResult } from './prompt.js';

/**
 * agent 循环。
 *
 * 规格 §6.1 的骨架：
 *
 * ```
 * 组 system prompt
 * messages = 历史（只取 user/reply）+ 用户这一句
 * 循环（最多 maxSteps 步）：
 *   1. 调模型
 *   2. 没有 tool_calls → 这就是最终回复 → 结束
 *   3. 有 tool_calls → 逐个处理：找工具 → 审批 → 执行 → 结果作为 role:'tool' 喂回去
 * ```
 *
 * ## 三条最容易做错的
 *
 * 1. **每个 tool_call 都要有一条 `role:'tool'` 的消息。**
 *    哪怕内容是「没有这个工具」「用户拒绝了」——
 *    少一条，接口就 400（tool_calls 没有对应的结果）。
 * 2. **工具出错不终止任务**：错误要**喂回模型**，模型才能换条路。
 *    直接终止的话，用户拿到的是「agent 崩了」而不是结果。
 * 3. **上下文压缩的单位是「轮」**：assistant(带 tool_calls) + 后面连续的 tool 消息，
 *    要整轮一起丢——只丢 tool 消息会让接口报错。
 */

/** 一次任务的结局。 */
export const AGENT_OUTCOME = Object.freeze({
  /** 模型给出了最终答复。 */
  DONE: 'done',
  /** 步数用尽。 */
  MAX_STEPS: 'max_steps',
  /** 同一个错误连着出太多次，停下来。 */
  REPEATED_ERRORS: 'repeated_errors',
  /** 被取消。 */
  ABORTED: 'aborted',
});

/** 同一个错误连着出几次就停。 */
export const MAX_SAME_ERRORS = 3;

/**
 * 造一个 agent 循环。
 *
 * @param {object} options
 * @param {Function} options.callModel
 *   ({system, messages, tools, onDelta, signal}) → Promise<{text, toolCalls, baseUrl?}>
 * @param {Function} [options.resolveTool] (name) → 工具描述符 | null
 * @param {object} [options.gate] 审批闸门 {request({tool, args, risk, signal}) → {decision}}
 * @param {number} [options.maxSteps]
 * @param {number} [options.maxSameErrors]
 * @param {Function} [options.onEvent] 步骤事件
 */
export function createAgentLoop({
  callModel,
  resolveTool = () => null,
  gate = null,
  maxSteps = 20,
  maxSameErrors = MAX_SAME_ERRORS,
  onEvent = null,
} = {}) {
  /**
   * 跑一次任务。
   *
   * @returns {Promise<{text: string, steps: number, outcome: string, toolCalls: number, error: string, baseUrl: string}>}
   */
  async function run({ system = '', messages = [], tools = [], signal = null, onDelta = null } = {}) {
    let convo = Array.isArray(messages) ? messages.slice() : [];
    const toolList = Array.isArray(tools) ? tools : [];
    let steps = 0;
    // 默认按「步数用尽」算：循环跑完还没给出答复，就是没做完。
    let outcome = AGENT_OUTCOME.MAX_STEPS;
    let finalText = '';
    let lastError = '';
    let baseUrl = '';
    let toolCallCount = 0;
    let droppedTotal = 0;
    // 同一个错误连着出几次的计数。
    let errorKey = '';
    let errorCount = 0;

    while (steps < maxSteps) {
      if (signal?.aborted) {
        outcome = AGENT_OUTCOME.ABORTED;
        break;
      }
      steps += 1;

      let call;
      try {
        call = await callModel({
          system: droppedTotal > 0 ? `${system}\n${compactionNote(droppedTotal)}` : system,
          messages: convo,
          tools: toolList,
          onDelta,
          signal,
        });
      } catch (err) {
        // 取消导致的失败不算错误——它是用户的意思。
        if (signal?.aborted) {
          outcome = AGENT_OUTCOME.ABORTED;
          break;
        }
        throw err;
      }

      const text = String(call?.text || '');
      if (call?.baseUrl) baseUrl = call.baseUrl;
      const calls = Array.isArray(call?.toolCalls) ? call.toolCalls : [];

      // 没有工具调用 → 这就是最终答复。
      if (!calls.length) {
        finalText = text;
        outcome = AGENT_OUTCOME.DONE;
        break;
      }

      // assistant 那条必须带 tool_calls：接口靠它把后面的 tool 消息对上号。
      convo.push({
        role: 'assistant',
        content: text || '',
        tool_calls: calls.map((c, i) => ({
          id: String(c?.id || `call_${steps}_${i}`),
          type: 'function',
          function: {
            name: String(c?.function?.name || ''),
            arguments: String(c?.function?.arguments || ''),
          },
        })),
      });

      for (const c of calls) {
        toolCallCount += 1;
        const one = await runOne(c, { signal });

        // 错误计数：**同一个**错误连着出三次就停——
        // 换个错重试是模型在换路，那该继续；同一个错反复就是死循环。
        if (one.ok) {
          errorKey = '';
          errorCount = 0;
        } else {
          const key = `${one.tool || ''}:${one.error || ''}`;
          if (key === errorKey) errorCount += 1;
          else {
            errorKey = key;
            errorCount = 1;
          }
          lastError = one.error || lastError;
        }

        // **每个 tool_call 都要有一条 tool 消息**（哪怕内容是错误说明）。
        convo.push({
          role: 'tool',
          tool_call_id: String(c?.id || ''),
          content: truncateToolResult(one.text),
        });

        onEvent?.({
          type: 'step',
          index: toolCallCount,
          tool: one.tool || '',
          args: one.args || null,
          result: one.ok ? one.text : '',
          error: one.ok ? '' : one.error || '',
        });

        if (!one.ok && errorCount >= maxSameErrors) {
          outcome = AGENT_OUTCOME.REPEATED_ERRORS;
          break;
        }
      }
      if (outcome === AGENT_OUTCOME.REPEATED_ERRORS) break;

      // 上下文压缩：工具结果越滚越大，不压迟早撑爆。
      const compacted = compactAgentMessages(convo, {});
      convo = compacted.messages;
      droppedTotal += compacted.dropped;
    }

    return {
      text: finalText,
      steps,
      outcome,
      toolCalls: toolCallCount,
      error: outcome === AGENT_OUTCOME.REPEATED_ERRORS ? lastError : '',
      baseUrl,
    };
  }

  /**
   * 执行一次工具调用。
   *
   * **任何失败都变成一条能喂回模型的文字**，不抛异常：
   * 抛出去就等于终止整个任务，模型连换条路的机会都没有。
   */
  async function runOne(call, { signal }) {
    const name = String(call?.function?.name || '');
    const tool = resolveTool(name);
    if (!tool) {
      const msg = `没有这个工具：${name}`;
      return { ok: false, tool: name, args: null, text: msg, error: msg };
    }

    const rawArgs = String(call?.function?.arguments || '').trim();
    let args = {};
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        const msg = `工具「${name}」的参数不是合法的 JSON`;
        return { ok: false, tool: name, args: null, text: msg, error: msg };
      }
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      const msg = `工具「${name}」的参数必须是一个 JSON 对象`;
      return { ok: false, tool: name, args: null, text: msg, error: msg };
    }

    const verdict = await askApproval({ tool, args, signal });
    if (!verdict.allowed) {
      const msg = verdict.reason || `用户拒绝了「${name}」这次调用`;
      return { ok: false, tool: name, args, text: msg, error: msg, denied: true };
    }

    try {
      const out = await tool.run(args, { signal });
      const text = typeof out?.text === 'string' ? out.text : String(out?.text ?? '');
      return { ok: true, tool: name, args, text, data: out?.data };
    } catch (err) {
      const msg = `工具「${name}」出错：${err?.message || err}`;
      return { ok: false, tool: name, args, text: msg, error: msg };
    }
  }

  /**
   * 问闸门：这个工具要不要用户点头。
   *
   * **没有闸门时，写与执行类工具一律不执行。**
   * L2 还没有审批气泡（那是 L3），用户根本没机会点头——
   * 那就不能替他点头。只读工具照常（只读被工作区关着）。
   */
  async function askApproval({ tool, args, signal }) {
    if (gate && typeof gate.request === 'function') {
      const decision = await gate.request({ tool, args, risk: tool.risk, signal });
      const d = String(decision?.decision || decision || '').toLowerCase();
      if (d === 'allow' || d === 'always') return { allowed: true };
      return { allowed: false, reason: `用户拒绝了「${tool.name}」这次调用` };
    }
    if (tool.risk === TOOL_RISK.READ) return { allowed: true };
    return {
      allowed: false,
      reason: `「${tool.name}」需要用户确认，但审批功能还没上线，这次不执行`,
    };
  }

  return { run };
}
```

- [x] **Step 4: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-loop.test.js"`

Expected: PASS —— 13 个测试全过。

- [x] **Step 5: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 全部通过（数量 = 之前的总数 + 13）。

- [x] **Step 6: 提交**

```bash
git add src/main/assistant/agent/loop.js test/unit/agent-loop.test.js
git commit -m "feat(助手): agent 循环——多步、工具调用、错误喂回模型"
```

---

### Task 3: T7b agent 后端与接线

**Files:**
- Create: `src/main/assistant/chat/agent.js`
- Modify: `src/main/assistant/llm/openai.js`（`chatCompletionStreamWithProbe` 支持 `signal`）
- Modify: `src/shared/assistant.js`（`LLM_BACKENDS`）
- Modify: `src/main/assistant/state.js`（`backend` 只认 `LLM_BACKENDS` 里的值）
- Modify: `src/main/assistant/index.js`（注册 agent 后端、把步骤事件转发给插件）
- Test: `test/unit/agent-backend.test.js`

**Interfaces:**
- Consumes:
  - `src/main/assistant/agent/loop.js`（Task 2）的 `createAgentLoop`、`AGENT_OUTCOME`
  - `src/main/assistant/agent/prompt.js`（Task 1）的 `buildAgentSystemPrompt`
  - `src/main/assistant/agent/tools/registry.js` 的 `createToolRegistry`（L1）
- Produces:
  - `src/main/assistant/chat/agent.js`：`createAgentBackend(options) → { id:'agent', label, chat(ctx) }`
  - `src/shared/assistant.js`：`LLM_BACKENDS = ['chat', 'agent']`

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-backend.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentBackend } from '../../src/main/assistant/chat/agent.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';

/** 造一个只记录请求、返回固定回复的假接口。 */
function fakeFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: reply } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  return { calls, fetchImpl };
}

/** 造一个工具表。 */
function registryWithTool() {
  const registry = createToolRegistry();
  registry.register({
    name: 'fs.read',
    label: '读文件',
    description: '读文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    risk: 'read',
    async run() {
      return { text: '文件内容' };
    },
  });
  return registry;
}

const CONFIG = {
  apiKey: 'k',
  model: 'm',
  baseUrls: ['https://example.test/v1'],
  temperature: 0.7,
  maxTokens: 800,
  maxTokensField: 'max_tokens',
};

test('agent 后端：请求里带了工具表', async () => {
  const { calls, fetchImpl } = fakeFetch('好的');
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
    onDelta: () => {},
  });
  assert.ok(calls[0].body.tools, '请求里没有 tools');
  assert.equal(calls[0].body.tools[0].function.name, 'fs.read');
  // label 与 risk 不能发出去：有的服务端见到不认识的字段直接 400。
  assert.equal(calls[0].body.tools[0].function.risk, undefined);
});

test('agent 后端：回复要过 parseReply，情绪与记忆都拿得到', async () => {
  const reply = '搞定了\n<<META>>{"emotion":"happy","mood":5,"memories":["用户喜欢喝美式"]}';
  const { fetchImpl } = fakeFetch(reply);
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '你好' }],
    config: CONFIG,
    onDelta: () => {},
  });
  assert.equal(result.text, '搞定了');
  assert.equal(result.emotion, 'happy');
  assert.equal(result.mood, 5);
  assert.deepEqual(result.memories, ['用户喜欢喝美式']);
});

test('agent 后端：模型不支持工具调用时，要说人话', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: { message: 'tools is not supported' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  const backend = createAgentBackend({
    fetchImpl,
    getTools: () => registryWithTool(),
    getGate: () => null,
  });
  await assert.rejects(
    () =>
      backend.chat({
        messages: [{ role: 'user', content: '你好' }],
        config: CONFIG,
        onDelta: () => {},
      }),
    (err) => {
      assert.match(err.message, /工具/);
      assert.match(err.message, /普通对话/);
      return true;
    }
  );
});

test('agent 后端：后端 id 是 agent', () => {
  const backend = createAgentBackend({});
  assert.equal(backend.id, 'agent');
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-backend.test.js"`

Expected: FAIL —— `src/main/assistant/chat/agent.js` 不存在（ERR_MODULE_NOT_FOUND）。

- [x] **Step 3: 写 `src/main/assistant/chat/agent.js`**

```js
import { chatCompletionStreamWithProbe, LlmError, LLM_ERRORS } from '../llm/openai.js';
import { createStreamSplitter, parseReply } from './prompt.js';
import { buildAgentSystemPrompt } from '../agent/prompt.js';
import { AGENT_OUTCOME, createAgentLoop } from '../agent/loop.js';
import { DEFAULT_AGENT } from '../../shared/assistant.js';

/**
 * 后端 #2：agent 模式。
 *
 * 与 `plain.js` 的关系：**同一个契约下的两个实现**。
 * 上层（气泡、历史、情绪、插件）分不出两者的区别——
 * 用户在设置里把 `llm.backend` 换成 'agent'，就走上多步循环。
 *
 * 差别只有一处实质：**plain 一步就结束，agent 会一直走到模型不再调工具为止。**
 *
 * ## 它不做什么
 *
 * - **不做后台任务**：排队、并发、取消是 L3 的运行时的事。
 * - **不做审批**：审批闸门与气泡是 L3 的事。这里留了 `getGate` 的接缝，
 *   没接上时**写与执行类工具一律不执行**（见 loop.js 的 askApproval）。
 */
export function createAgentBackend({
  fetchImpl = fetch,
  /** agent 的工具表（注册表）。 */
  getTools = () => null,
  /** 审批闸门（L3 才接上）。 */
  getGate = () => null,
  getWorkspace = () => '',
  getPolicy = () => DEFAULT_AGENT.approval.policy,
  getAllowAlways = () => [],
  getMaxSteps = () => DEFAULT_AGENT.maxSteps,
  getPersona = () => ({}),
  getFacts = () => [],
  getNow = () => new Date(),
} = {}) {
  return {
    id: 'agent',
    label: 'agent 模式',

    async chat(ctx) {
      const { messages = [], config = {}, onDelta, onEvent, signal } = ctx;
      const registry = getTools();
      const tools = registry && typeof registry.list === 'function' ? registry.list() : [];

      const system = buildAgentSystemPrompt({
        persona: getPersona(),
        facts: getFacts(),
        tools,
        workspace: getWorkspace(),
        approval: { policy: getPolicy(), allowAlways: getAllowAlways() },
        now: getNow(),
      });

      // **流式正文与元数据要分开**：模型会在正文后面接一段 <<META>> 的 JSON，
      // 那段不能显示在气泡里（plain.js 用的是同一个分离器）。
      const splitter = createStreamSplitter();

      const loop = createAgentLoop({
        callModel: async ({ system: sys, messages: convo, tools: toolList, onDelta: delta, signal: sig }) => {
          const result = await chatCompletionStreamWithProbe(
            {
              apiKey: config.apiKey,
              model: config.model,
              messages: [{ role: 'system', content: sys }, ...convo],
              temperature: config.temperature,
              maxTokens: config.maxTokens,
              maxTokensField: config.maxTokensField,
              tools: toolList,
            },
            {
              fetchImpl,
              baseUrls: config.baseUrls,
              signal: sig,
              onDelta: delta,
            }
          );
          return { text: result.text, toolCalls: result.toolCalls, baseUrl: result.baseUrl };
        },
        resolveTool: (name) => (registry && typeof registry.get === 'function' ? registry.get(name) : null),
        gate: getGate(),
        maxSteps: getMaxSteps(),
        onEvent,
      });

      let run;
      try {
        run = await loop.run({
          system,
          messages,
          tools,
          signal,
          onDelta: (delta) => {
            const out = splitter.push(delta);
            if (out) onDelta?.(out);
          },
        });
      } catch (err) {
        throw translateError(err, tools.length > 0);
      }

      // 流结束了：把尾巴也吐出来。
      const tail = splitter.finish();
      if (tail) onDelta?.(tail);

      const parsed = parseReply(run.text || '');
      const text = parsed.text || fallbackText(run);

      return {
        text,
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

/**
 * 没走完的循环也要给用户一句人话。
 *
 * **空气泡是最糟的失败形态**：用户发了话，桌宠什么都没说，
 * 他会以为程序坏了。
 */
function fallbackText(run) {
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

/**
 * 把接口的错误翻译成人听得懂的话。
 *
 * **「模型不支持工具调用」是最容易踩的一种**：agent 模式请求里带着 tools，
 * 有的模型直接 400，而原文是英文的 "tools is not supported"——
 * 用户看了不知道该怎么办，所以这里明说「换个模型或切回普通对话」。
 */
function translateError(err, hadTools) {
  if (err instanceof LlmError && err.code === LLM_ERRORS.BAD_REQUEST && hadTools) {
    return new LlmError(
      '这个模型可能不支持工具调用。换一个支持工具的模型，或者把对话后端切回「普通对话」。',
      { code: LLM_ERRORS.BAD_REQUEST, status: err.status, body: err.body }
    );
  }
  return err;
}
```

- [x] **Step 4: 给 `chatCompletionStreamWithProbe` 加上 `signal`**

`src/main/assistant/llm/openai.js` 里那个函数的选项加上 `signal`，并传下去：

```js
export async function chatCompletionStreamWithProbe(
  params,
  { fetchImpl = fetch, baseUrls = LLM_BASE_URLS, onDelta, signal } = {},
) {
  // …
  const result = await chatCompletionStream({ ...params, baseUrl }, {
    fetchImpl,
    signal,
    onDelta: (delta) => { /* … */ },
    onToolCall: () => { /* … */ },
  });
  // …
}
```

- [x] **Step 5: 在 `src/shared/assistant.js` 里加 `LLM_BACKENDS`**

```js
/**
 * 可选的大模型对话后端。
 *
 * 'chat' 是普通对话（一次调用、一段回复）；
 * 'agent' 是多步循环（会调工具，见 src/main/assistant/chat/agent.js）。
 *
 * **定义只有一份**：状态清洗、后端注册、设置界面都从这儿取。
 */
export const LLM_BACKENDS = Object.freeze(['chat', 'agent']);
```

`src/main/assistant/state.js` 的清洗里，把

```js
backend: str(raw.llm.backend, DEFAULT_LLM.backend).slice(0, 40),
```

换成

```js
// 后端只认 LLM_BACKENDS 里的值：磁盘上的值可能是旧版本或手改的。
backend: LLM_BACKENDS.includes(raw.llm.backend) ? raw.llm.backend : DEFAULT_LLM.backend,
```

（并在 state.js 顶部 import `LLM_BACKENDS`。）

- [x] **Step 6: 在 `src/main/assistant/index.js` 里注册 agent 后端**

import 加上：

```js
import { createAgentBackend } from './chat/agent.js';
```

在 `toolRegistry.registerAll(...)` 之后注册：

```js
  // agent 后端：多步循环，会调工具。
  //
  // **审批闸门还没上线**（L3 的 T10）：所以现在写/执行类工具一律不执行，
  // 只读工具照常——宁可什么都不做，也不能在用户没点头的情况下动他的机器。
  backends.register('agent', createAgentBackend({
    fetchImpl,
    getTools: () => toolRegistry,
    getGate: () => null,
    getWorkspace: () => state?.agent?.workspace || '',
    getPolicy: () => state?.agent?.approval?.policy || DEFAULT_AGENT.approval.policy,
    getAllowAlways: () => state?.agent?.approval?.allowAlways || [],
    getMaxSteps: () => state?.agent?.maxSteps || DEFAULT_AGENT.maxSteps,
    getPersona: () => state?.llm?.persona || {},
    getFacts: () => state?.chat?.facts || [],
  }));
```

并在 `runChat` 里调后端时，把步骤事件转发给插件（插件通过 `ctx.agent.onEvent` 订阅）：

```js
      result = await backend.chat({
        system,
        messages,
        trigger,
        config,
        onDelta: (delta) => {
          if (streamId) bubble.appendStream(streamId, delta);
        },
        // agent 的步骤事件转发给插件：插件只认 ctx.agent.onEvent 这一个入口。
        onEvent: (event) => agentFacade.emit(event),
      });
```

- [x] **Step 7: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-backend.test.js"`

Expected: PASS —— 4 个测试全过。

- [x] **Step 8: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 全部通过（数量 = 之前的总数 + 4）。

- [x] **Step 9: 提交**

```bash
git add src/main/assistant/chat/agent.js src/main/assistant/llm/openai.js src/shared/assistant.js src/main/assistant/state.js src/main/assistant/index.js test/unit/agent-backend.test.js
git commit -m "feat(助手): 接入 agent 后端——llm.backend='agent' 走多步循环"
```

---

## 自查（写完计划后对着规格过一遍）

- **规格覆盖**：本计划实现 §14 的 L2 两项——T8（Task 1）、T7（Task 2 + Task 3）。
  另外顺手做了两件规格点名但没归到任务里的事：
  - §12「模型不支持 tools 要提示并建议切回 chat」→ Task 3 的 `translateError`；
  - §5.1「工具结果统一是 `{text, data}`」→ Task 2 的 `runOne` 只把 `text` 喂回模型，
    `data` 走步骤事件（不进上下文）。
- **占位符扫描**：无 TBD / TODO；每个任务的接口、测试与实现要点都写全了。
- **类型一致性**：
  - `createAgentLoop({callModel, resolveTool, gate, maxSteps, maxSameErrors, onEvent})` 与
    `run({system, messages, tools, signal, onDelta})` 在 Task 2 的接口段、测试、步骤里一致；
  - `createAgentBackend` 的选项名（`getTools` / `getGate` / `getWorkspace` / `getPolicy` /
    `getAllowAlways` / `getMaxSteps` / `getPersona` / `getFacts` / `getNow`）在 Task 3 的
    接口段、测试、接线步骤里一致；
  - `buildAgentSystemPrompt` / `truncateToolResult` / `compactAgentMessages` / `compactionNote`
    在 Task 1 的接口段与 Task 2 的 import 里一致。
- **Review Focus 覆盖**：
  「未知工具」→ Task 2 的「模型调了不存在的工具」；
  「参数不是合法 JSON」→ Task 2 的同名用例；
  「连续 3 次同类错误」→ Task 2 的「同一个错连着出三次」；
  「步数用尽」→ Task 2 的「步数用尽」+ Task 3 的 `fallbackText`；
  「模型不支持 tools」→ Task 3 的「模型不支持工具调用时，要说人话」；
  「上下文撑爆 / 压缩后接口报错」→ Task 1 的三个压缩用例（含「不能留下孤零零的 tool 消息」）；
  「用户拒绝是信号不是终止」→ Task 2 的「闸门拒绝」；
  「一轮多个工具」→ Task 2 的「一轮里调多个工具」。
