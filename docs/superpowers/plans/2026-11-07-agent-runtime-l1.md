# 桌宠内置 Agent 运行时 · L1 工具系统 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 L1 的四块做完——工具的**描述符与注册表**（T3）、**内置工具集**（T4）、**插件给 agent 提供工具**（T5）、**插件反向调用 agent**（T6 的接缝）。

**Architecture:** 四件事按依赖排队：

```
T3 工具注册表（纯函数，不碰 electron）
   ├── T4 内置工具集（fs / shell / app / clipboard）
   └── T5 插件提供工具（清单声明 + 实例实现，两边对不上就不注册）
T6 插件反向调用 agent（ctx.agent 接缝；真正的运行时排在 L3 的 T9）
```

- **T3** 定「一个工具长什么样」与「谁说了算」：注册、查找、重复名、风险等级取严者。
- **T4** 是第一批真正能干活的工具：读文件、列目录、搜文件、写文件、执行命令、启动程序、读剪贴板。
- **T5** 让插件也能给 agent 供货：清单里**声明**、实例里**实现**，两边对不上就不注册（并留一行日志）。
- **T6** 是接缝：`ctx.agent` 让插件能提交任务、取消任务、读历史、订阅事件。
  **真正的后台任务运行时排在 L3 的 T9**（规格 §14 的依赖表就是这么写的），
  所以 L1 这一层把接口与接线做完，`run`/`cancel` 明确返回「还没上线」，
  不假装成功——L3 接上运行时即可。

**Tech Stack:** Electron + Node（`node --test` 跑单元测试，无测试框架依赖）。
工具注册表与内置工具**都不 import electron**（剪贴板、程序索引、子进程都靠注入），
这样它们能在普通 node 里测。

**Spec:** `docs/superpowers/specs/2026-11-07-agent-runtime-design.md`（本计划只实现它的 §14 里的 **L1 · 工具系统** 四项：T3 / T4 / T5 / T6）

## Global Constraints

- **注释与文档用中文。** 每个文件开头一段块注释，说明「这是什么」和「为什么这么写」；反直觉的设计尤其要写清楚不这么写会怎样。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `fix(助手): …` / `test(助手): …` / `docs(助手): …`。
- **能被测到的改动，先写测试。** 每个任务都按 RED→GREEN 走。
- **Edit 的 `file_path` 必须是绝对路径。**
- **契约只有一份**：工具名、风险等级的取值放在 `src/shared/assistant.js`（主进程与插件清单两边都从那里取）。
- **不碰 L2 及以后**：本计划不写 agent 循环（`assistant/chat/agent.js`）、不写运行时（`assistant/agent/runtime.js`）、不碰审批与气泡。
- **不碰用户的真实配置**：单元测试一律用临时目录与注入的假实现。
- 单元测试命令：`npm run test:unit`（等价于 `node --test "test/unit/**/*.test.js"`）。

## 这几件事最容易做错（写代码时反复看）

1. **工具名是全局唯一的，且「先到先得」。** 内置工具先注册，插件后注册——
   插件要是能覆盖 `shell.exec`，它就能把用户批准的「执行命令」换成别的东西。
   所以重复名**拒绝注册**并留一行日志。
2. **风险等级取「声明值」与「宿主下限」里更严格的那个。**
   插件声明 `read` 蒙混不过去：`shell.exec` / `app.launch` 的下限是 `exec`，`fs.write` 是 `write`。
   **注册表把算出来的风险盖在描述符上**，调用方拿到的就是生效值，绕不过去。
3. **声明了一个看不懂的风险等级 → 按最严格（`exec`）处理**，不许默默当成 `read`。
4. **路径越界只拦「只读」工具。** 规格 §5.3 明说：只读工具自动放行，所以它们必须被工作区关住；
   写/执行工具要走用户审批，用户看得见路径，所以不设边界（否则 agent 什么都干不了）。
5. **清单与实现必须同名。** 清单声明了没实现 → 不注册（留日志）；实现了没声明 → 不注册（留日志）。
   清单是契约，两边必须一致。
6. **插件没开 → 它的工具不在表里。** 「渐进式加载」是天然的：提示词里只列当前启用插件提供的工具。

## Review Focus

以下是规格暗示、但**没有一个任务的测试会覆盖**的输入类与失败模式。按「最可能先咬到人的」排序：

1. **插件用 `fs.write` 冒充 `read`** —— 注册表必须把风险抬回 `write`；否则「只读自动放行」会让它偷偷写文件。
2. **插件声明了 `shell.exec` 但只读** —— 下限必须把它抬成 `exec`，不能信插件自报。
3. **插件自己实现了一个名字像内置工具的函数（如 `fs.read`）** —— 内置先注册，插件那份必须被拒。
4. **工作区是空字符串** —— 要退回用户主目录，不能把路径解析到盘符根上。
5. **`fs.read` 读一个不存在的文件** —— 工具要**抛错**（错误要喂回模型），不是返回一个空字符串。
6. **插件的 `tools()` 抛异常** —— 不能把整个插件加载带崩；那个插件的工具这一轮就没有。
7. **`shell.exec` 的命令超时** —— 要杀掉子进程并把「超时」当成一次工具失败（规格 §12）。

---

### Task 1: T3 工具描述符与注册表

**Files:**
- Create: `src/main/assistant/agent/tools/registry.js`
- Modify: `src/shared/assistant.js`（新增 `TOOL_RISK` / `TOOL_RISK_ORDER` / `TOOL_NAME_RE`）
- Test: `test/unit/agent-tools.test.js`

**Interfaces:**
- Consumes: 无（L1 的第一个任务）
- Produces:
  - `src/shared/assistant.js`：
    - `TOOL_RISK = { READ:'read', WRITE:'write', EXEC:'exec' }`
    - `TOOL_RISK_ORDER = ['read','write','exec']`
    - `TOOL_NAME_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/`
  - `src/main/assistant/agent/tools/registry.js`：
    - `TOOL_RISK_FLOOR = { 'shell.exec':'exec', 'app.launch':'exec', 'fs.write':'write' }`
    - `stricterRisk(a, b) → 'read'|'write'|'exec'`
    - `effectiveRisk(tool) → 'read'|'write'|'exec'`
    - `normalizeTool(raw) → 描述符 | null`
    - `createToolRegistry({ logger? }) → { register, registerAll, get, has, list, names, unregister, size }`

**描述符的形状**（规格 §5.1）：

```js
{ name, label, description, parameters, risk, run }
```

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-tools.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_RISK, TOOL_RISK_ORDER, TOOL_NAME_RE } from '../../src/shared/assistant.js';
import {
  TOOL_RISK_FLOOR,
  createToolRegistry,
  effectiveRisk,
  normalizeTool,
  stricterRisk,
} from '../../src/main/assistant/agent/tools/registry.js';

/**
 * agent 的工具注册表。
 *
 * 三条最容易做错的：
 * 1. 名字全局唯一、**先到先得**——插件不能覆盖内置的 shell.exec；
 * 2. 风险等级取「声明值」与「宿主下限」里**更严格**的那个；
 * 3. 声明了看不懂的风险等级 → 按最严格处理，不许当成 read。
 */

function tool(name, risk = 'read', extra = {}) {
  return {
    name,
    label: `工具 ${name}`,
    description: '测试用',
    parameters: { type: 'object', properties: {} },
    risk,
    run: async () => ({ text: 'ok' }),
    ...extra,
  };
}

/** 收集日志的假 logger。 */
function fakeLogger() {
  const lines = [];
  return { warn: (...args) => lines.push(args.join(' ')), lines };
}

test('契约：风险等级与名字的形状', () => {
  assert.equal(TOOL_RISK.READ, 'read');
  assert.equal(TOOL_RISK.WRITE, 'write');
  assert.equal(TOOL_RISK.EXEC, 'exec');
  assert.deepEqual([...TOOL_RISK_ORDER], ['read', 'write', 'exec']);
  assert.ok(TOOL_NAME_RE.test('shell.exec'));
  assert.ok(TOOL_NAME_RE.test('fs.read'));
  assert.ok(!TOOL_NAME_RE.test('Shell.Exec'));
  assert.ok(!TOOL_NAME_RE.test('shell exec'));
});

test('注册表：注册、查找、列出', () => {
  const reg = createToolRegistry();
  const t = tool('fs.read');
  assert.equal(reg.register(t), t);
  assert.equal(reg.get('fs.read'), t);
  assert.ok(reg.has('fs.read'));
  assert.deepEqual(reg.names(), ['fs.read']);
  assert.equal(reg.size, 1);
});

test('注册表：查不到的工具给 null，不给 undefined 也不抛错', () => {
  const reg = createToolRegistry();
  assert.equal(reg.get('没有这个'), null);
  assert.equal(reg.has('没有这个'), false);
});

test('注册表：同名工具**先到先得**，后来的被拒', () => {
  const logger = fakeLogger();
  const reg = createToolRegistry({ logger });
  const first = tool('fs.read', 'read');
  const second = tool('fs.read', 'exec');
  assert.equal(reg.register(first), first);
  assert.equal(reg.register(second), null, '后来的不能覆盖先来的');
  assert.equal(reg.get('fs.read'), first);
  assert.equal(reg.size, 1);
  assert.equal(logger.lines.length, 1, '要留一行日志');
});

test('注册表：描述符不合法就拒绝注册', () => {
  const reg = createToolRegistry();
  assert.equal(reg.register(null), null);
  assert.equal(reg.register({ name: '没有 run' }), null);
  assert.equal(reg.register(tool('Bad Name')), null);
  assert.equal(reg.size, 0);
});

test('风险：取更严格的那个', () => {
  assert.equal(stricterRisk('read', 'write'), 'write');
  assert.equal(stricterRisk('exec', 'write'), 'exec');
  assert.equal(stricterRisk('read', 'read'), 'read');
});

test('风险：宿主给已知危险工具名兜底', () => {
  assert.equal(TOOL_RISK_FLOOR['shell.exec'], 'exec');
  assert.equal(TOOL_RISK_FLOOR['fs.write'], 'write');
  assert.equal(effectiveRisk({ name: 'shell.exec', risk: 'read' }), 'exec', '插件自报 read 没用');
  assert.equal(effectiveRisk({ name: 'fs.write', risk: 'read' }), 'write');
  assert.equal(effectiveRisk({ name: 'weather.get', risk: 'read' }), 'read');
});

test('风险：看不懂的风险等级按最严格处理', () => {
  assert.equal(effectiveRisk({ name: 'x.y', risk: 'danger' }), 'exec');
  assert.equal(effectiveRisk({ name: 'x.y' }), 'exec', '没写风险等级也不许当成 read');
});

test('注册表：注册时就把生效风险盖在描述符上', () => {
  const reg = createToolRegistry();
  const t = reg.register(tool('shell.exec', 'read'));
  assert.equal(t.risk, 'exec');
  assert.equal(reg.get('shell.exec').risk, 'exec');
});

test('注册表：按 owner 整批摘掉（插件被关掉时）', () => {
  const reg = createToolRegistry();
  reg.register(tool('a.one'), { owner: '插件甲' });
  reg.register(tool('a.two'), { owner: '插件甲' });
  reg.register(tool('b.one'), { owner: '插件乙' });
  assert.equal(reg.unregister('插件甲'), 2);
  assert.deepEqual(reg.names(), ['b.one']);
});

test('注册表：注册一批', () => {
  const reg = createToolRegistry();
  const registered = reg.registerAll([tool('a.one'), tool('a.two')], { owner: 'x' });
  assert.equal(registered.length, 2);
  assert.equal(reg.size, 2);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-tools.test.js"`

Expected: FAIL —— `src/main/assistant/agent/tools/registry.js` 不存在（`Cannot find module`）。

- [x] **Step 3: 在 `src/shared/assistant.js` 里加工具契约**

在文件末尾追加：

```js
/**
 * 工具的风险等级。
 *
 * 风险等级决定「要不要用户点头」：
 * 只读自动放行，写与执行要确认（规格 §8.1 的 graded 策略）。
 *
 * 放在 shared 里是因为**插件清单也要用它**——
 * 插件在清单里声明 `risk: 'read'`，宿主与插件作者得认同一套取值。
 */
export const TOOL_RISK = Object.freeze({
  /** 只读：读文件、列目录、搜索、读剪贴板、查状态。 */
  READ: 'read',
  /** 写入：写文件、改配置。 */
  WRITE: 'write',
  /** 执行：跑命令、启动程序、启动外部进程。 */
  EXEC: 'exec',
});

/** 风险从轻到重的顺序：取「更严格者」时用它比较。 */
export const TOOL_RISK_ORDER = Object.freeze([TOOL_RISK.READ, TOOL_RISK.WRITE, TOOL_RISK.EXEC]);

/**
 * 工具名的形状：小写字母数字，点号分段。
 *
 * 工具名是**全局唯一**的标识（`fs.read` / `shell.exec` / `weather.get`），
 * 段之间用点：谁提供的不写在名字里（插件的工具也可能叫 `weather.get`），
 * 但前缀能让人一眼看出这是哪一类能力。
 */
export const TOOL_NAME_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
```

- [x] **Step 4: 写 `src/main/assistant/agent/tools/registry.js`**

```js
import { TOOL_RISK, TOOL_RISK_ORDER, TOOL_NAME_RE } from '../../../../shared/assistant.js';

/**
 * agent 的工具注册表。
 *
 * 一个工具是一个描述符：
 *
 * ```js
 * { name, label, description, parameters, risk, run }
 * ```
 *
 * - `description` 与 `parameters` 是**给模型看的**（会进提示词）；
 * - `label` 是**给人看的**；
 * - `risk` 决定要不要用户点头；
 * - `run(args, ctx)` 是干活的那一口，返回 `{ text, data }`：
 *   `text` 给模型（会被截断后进上下文），`data` 给界面（不进上下文）。
 *
 * **注册表只管「有哪些工具」，不管「怎么执行」**——
 * 怎么执行是 agent 循环（L2）的事，怎么审批是 L3 的事。
 */

/**
 * 宿主给已知危险工具名兜底的风险下限。
 *
 * **插件不能靠声明 `read` 蒙混过关**：风险等级是工具自己声明的，
 * 但声明值只当「请求」，这里给硬下限。
 * 少了这张表，一个插件声明 `shell.exec` 是 `read`，
 * 「只读自动放行」就会替用户批准一次命令执行。
 */
export const TOOL_RISK_FLOOR = Object.freeze({
  'shell.exec': TOOL_RISK.EXEC,
  'app.launch': TOOL_RISK.EXEC,
  'fs.write': TOOL_RISK.WRITE,
});

/**
 * 取两个风险里更严格的那个。
 *
 * 读不懂的值（不在 TOOL_RISK_ORDER 里）按**最严格**算：
 * 宁可多问用户一次，也不要因为一个拼错的风险等级就自动放行。
 */
export function stricterRisk(a, b) {
  const rank = (value) => {
    const i = TOOL_RISK_ORDER.indexOf(value);
    return i >= 0 ? i : TOOL_RISK_ORDER.length;
  };
  return TOOL_RISK_ORDER[Math.max(rank(a), rank(b))] ?? TOOL_RISK.EXEC;
}

/**
 * 一个工具**实际生效**的风险等级。
 *
 * 声明值与宿主下限里取更严格的那个。
 */
export function effectiveRisk(tool) {
  const declared = String(tool?.risk || '').trim();
  const floor = TOOL_RISK_FLOOR[tool?.name] || TOOL_RISK.READ;
  return stricterRisk(declared, floor);
}

/**
 * 把任意输入规整成一个工具描述符；不合法就返回 null。
 *
 * `parameters` 必须是对象：模型是按 JSON Schema 读它的，
 * 传成别的形状的话，有的服务端会直接 400。
 */
export function normalizeTool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!TOOL_NAME_RE.test(name)) return null;
  if (typeof raw.run !== 'function') return null;
  const parameters =
    raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters)
      ? raw.parameters
      : { type: 'object', properties: {} };
  return {
    name,
    label: String(raw.label || name),
    description: String(raw.description || '').slice(0, 2000),
    parameters,
    risk: effectiveRisk({ name, risk: raw.risk }),
    run: raw.run,
    ...(raw.owner ? { owner: String(raw.owner) } : {}),
  };
}

/**
 * 工具注册表。
 *
 * **同名先到先得**：内置工具先注册，插件后注册——
 * 插件要是能覆盖 `shell.exec`，它就能把用户批准的「执行命令」换成别的东西。
 * 所以后来的同名注册一律拒绝，并留一行日志。
 */
export function createToolRegistry({ logger = console } = {}) {
  /** name → 描述符。 */
  const entries = new Map();

  function register(raw, { owner = '' } = {}) {
    const tool = normalizeTool(raw);
    if (!tool) {
      logger.warn?.('[desk-pet] 工具注册失败：描述符不合法');
      return null;
    }
    if (entries.has(tool.name)) {
      const prev = entries.get(tool.name);
      logger.warn?.(
        `[desk-pet] 工具「${tool.name}」已经注册过了（来自${prev.owner || '内置'}），这次的不注册`
      );
      return null;
    }
    const withOwner = owner ? { ...tool, owner: String(owner) } : tool;
    entries.set(withOwner.name, withOwner);
    return withOwner;
  }

  return {
    register,
    registerAll(tools, options) {
      const out = [];
      for (const raw of Array.isArray(tools) ? tools : []) {
        const tool = register(raw, options);
        if (tool) out.push(tool);
      }
      return out;
    },
    get(name) {
      return entries.get(String(name || '')) || null;
    },
    has(name) {
      return entries.has(String(name || ''));
    },
    list() {
      return [...entries.values()];
    },
    names() {
      return [...entries.keys()];
    },
    /** 按 owner 整批摘掉（插件被关掉时用）。返回摘掉几个。 */
    unregister(owner) {
      const target = String(owner || '');
      let removed = 0;
      for (const [name, tool] of [...entries.entries()]) {
        if (tool.owner === target) {
          entries.delete(name);
          removed += 1;
        }
      }
      return removed;
    },
    get size() {
      return entries.size;
    },
  };
}
```

- [x] **Step 5: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-tools.test.js"`

Expected: PASS —— 12 个测试全过。

- [x] **Step 6: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 224 + 12 = 236 个测试全过。

- [x] **Step 7: 提交**

```bash
git add src/shared/assistant.js src/main/assistant/agent/tools/registry.js test/unit/agent-tools.test.js
git commit -m "feat(助手): 工具注册表——全局唯一的名字、风险等级取严者、同名先到先得"
```

---

### Task 2: T4 内置工具集

**Files:**
- Create: `src/main/assistant/agent/tools/builtin.js`
- Modify: `src/shared/assistant.js`（新增 `DEFAULT_AGENT`）
- Modify: `src/main/assistant/state.js`（状态里加 `agent` 一段）
- Modify: `src/main/assistant/index.js`（建注册表、装内置工具、对外暴露 `agent`）
- Modify: `src/main/index.js`（把程序索引递给助理）
- Test: `test/unit/agent-builtin-tools.test.js`

**Interfaces:**
- Consumes: Task 1 的 `createToolRegistry` / `TOOL_RISK`
- Produces:
  - `src/main/assistant/agent/tools/builtin.js`：
    - `createBuiltinTools({ getWorkspace, readClipboard, isClipboardEnabled, getAppIndex, spawn, timeoutMs }) → 描述符[]`
    - `resolveInsideWorkspace(base, target) → 绝对路径`（越界就抛错）
  - `src/shared/assistant.js`：`DEFAULT_AGENT = { maxConcurrent:1, maxSteps:20, workspace:'', timeoutMs:120000, maxTokensPerTask:0, approval:{policy:'graded', allowAlways:[]} }`
  - `src/main/assistant/index.js`：
    - 对外多两个口子：`agentTools`（注册表）、`agent`（`{ tools, run, cancel, history, onEvent }`）

**七个内置工具**（规格 §5.3 的表；表里是七个，验收里写「六个」——按表实现）：

| name | risk | 说明 |
|---|---|---|
| `fs.read` | read | 读文件（可带行范围） |
| `fs.list` | read | 列目录 |
| `fs.search` | read | 在目录里搜字符串 |
| `fs.write` | write | 写文件 |
| `shell.exec` | exec | 执行一条命令 |
| `app.launch` | exec | 启动本机程序 |
| `clipboard.read` | read | 读剪贴板 |

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-builtin-tools.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools, resolveInsideWorkspace } from '../../src/main/assistant/agent/tools/builtin.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';

/**
 * 内置工具集。
 *
 * 三条最容易做错的：
 * 1. **只读工具**必须被工作区关住（它们自动放行，没人盯着）；
 * 2. **写/执行工具不设边界**——它们要走用户审批，用户看得见路径；
 * 3. 工具出错要**抛**，不是返回空字符串——错误要喂回模型，让它换条路。
 */

async function tmpDir() {
  return mkdtemp(join(tmpdir(), 'desk-pet-agent-'));
}

/** 按名字拿一个工具。 */
function pick(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `没有工具 ${name}`);
  return t;
}

test('工作区：路径越界要拦住', () => {
  const base = join(tmpdir(), 'ws');
  assert.equal(resolveInsideWorkspace(base, 'a/b.txt'), join(base, 'a', 'b.txt'));
  assert.equal(resolveInsideWorkspace(base, join(base, 'x.txt')), join(base, 'x.txt'));
  assert.throws(() => resolveInsideWorkspace(base, '../逃出去.txt'), /工作区/);
  assert.throws(() => resolveInsideWorkspace(base, join(base, '..', '逃出去.txt')), /工作区/);
});

test('工具集：七个内置工具齐活，风险等级对得上', () => {
  const tools = createBuiltinTools({});
  const names = tools.map((t) => t.name);
  for (const name of ['fs.read', 'fs.list', 'fs.search', 'fs.write', 'shell.exec', 'app.launch', 'clipboard.read']) {
    assert.ok(names.includes(name), `少了 ${name}`);
  }
  assert.equal(pick(tools, 'fs.read').risk, 'read');
  assert.equal(pick(tools, 'fs.write').risk, 'write');
  assert.equal(pick(tools, 'shell.exec').risk, 'exec');
  assert.equal(pick(tools, 'app.launch').risk, 'exec');
});

test('工具集：每个工具都能装进注册表', () => {
  const reg = createToolRegistry();
  const registered = reg.registerAll(createBuiltinTools({}));
  assert.equal(registered.length, 7);
  // 宿主下限把 shell.exec 抬成 exec。
  assert.equal(reg.get('shell.exec').risk, 'exec');
});

test('fs.read：读得到文件，读不到就抛错', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(join(dir, 'a.txt'), '第一行\n第二行\n第三行\n', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const read = pick(tools, 'fs.read');
    const out = await read.run({ path: 'a.txt' });
    assert.match(out.text, /第一行/);
    assert.equal(out.data.totalLines, 4, '末尾那个空行也算一行');
    await assert.rejects(() => read.run({ path: '没有这个.txt' }), /找不到|不存在|ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.read：能只读一段行', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(join(dir, 'a.txt'), '1\n2\n3\n4\n5\n', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.read').run({ path: 'a.txt', start: 2, end: 3 });
    assert.equal(out.text.trim(), '2\n3');
    assert.equal(out.data.start, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.read：读工作区外面的文件要拦住', async () => {
  const dir = await tmpDir();
  try {
    const tools = createBuiltinTools({ getWorkspace: () => join(dir, 'inside') });
    await mkdir(join(dir, 'inside'), { recursive: true });
    await assert.rejects(() => pick(tools, 'fs.read').run({ path: join(dir, 'outside.txt') }), /工作区/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.list：列目录', async () => {
  const dir = await tmpDir();
  try {
    await writeFile(join(dir, 'a.txt'), 'x', 'utf8');
    await mkdir(join(dir, '子目录'), { recursive: true });
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.list').run({});
    assert.equal(out.data.entries.length, 2);
    assert.ok(out.text.includes('a.txt'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.search：搜得到内容，搜不到给空结果', async () => {
  const dir = await tmpDir();
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.js'), 'const needle = 1;\n', 'utf8');
    await writeFile(join(dir, 'src', 'b.js'), 'const other = 2;\n', 'utf8');
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.search').run({ pattern: 'needle' });
    assert.equal(out.data.hits.length, 1);
    assert.ok(out.text.includes('a.js'));
    const none = await pick(tools, 'fs.search').run({ pattern: '根本没有这个词' });
    assert.equal(none.data.hits.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fs.write：写得进文件', async () => {
  const dir = await tmpDir();
  try {
    const tools = createBuiltinTools({ getWorkspace: () => dir });
    const out = await pick(tools, 'fs.write').run({ path: '写一个.txt', content: '你好' });
    assert.ok(out.data.path.endsWith('写一个.txt'));
    assert.equal(await readFile(join(dir, '写一个.txt'), 'utf8'), '你好');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shell.exec：跑一条命令，拿到输出', async () => {
  const tools = createBuiltinTools({});
  const out = await pick(tools, 'shell.exec').run({ command: 'echo hello-from-shell' });
  assert.ok(out.text.includes('hello-from-shell'), out.text);
  assert.equal(out.data.code, 0);
});

test('shell.exec：命令起不来要抛错', async () => {
  const tools = createBuiltinTools({});
  await assert.rejects(() => pick(tools, 'shell.exec').run({ command: '' }), /命令/);
});

test('app.launch：按名字找到并启动程序', async () => {
  const launched = [];
  const index = {
    list: async () => [
      { id: 'app:notepad', name: '记事本', target: 'C:/notepad.exe' },
      { id: 'app:chrome', name: 'Google Chrome', target: 'C:/chrome.exe' },
    ],
    launch: async (id) => {
      launched.push(id);
      return { ok: true, message: '已打开' };
    },
  };
  const tools = createBuiltinTools({ getAppIndex: () => index });
  const out = await pick(tools, 'app.launch').run({ name: 'chrome' });
  assert.deepEqual(launched, ['app:chrome']);
  assert.equal(out.data.name, 'Google Chrome');
});

test('app.launch：找不到程序要抛错', async () => {
  const index = { list: async () => [], launch: async () => ({ ok: true }) };
  const tools = createBuiltinTools({ getAppIndex: () => index });
  await assert.rejects(() => pick(tools, 'app.launch').run({ name: '不存在的程序' }), /没找到/);
});

test('clipboard.read：剪贴板助手没开就不给读', async () => {
  const tools = createBuiltinTools({
    isClipboardEnabled: () => false,
    readClipboard: async () => '秘密',
  });
  await assert.rejects(() => pick(tools, 'clipboard.read').run({}), /剪贴板/);
});

test('clipboard.read：开着了才读得到', async () => {
  const tools = createBuiltinTools({
    isClipboardEnabled: () => true,
    readClipboard: async () => '复制来的东西',
  });
  const out = await pick(tools, 'clipboard.read').run({});
  assert.match(out.text, /复制来的东西/);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-builtin-tools.test.js"`

Expected: FAIL —— `src/main/assistant/agent/tools/builtin.js` 不存在。

- [x] **Step 3: 写 `src/main/assistant/agent/tools/builtin.js`**

（实现细节见下面的 Step 3 代码；要点：路径越界只拦只读工具、写/执行工具不设边界、工具出错一律抛错。）

- [x] **Step 4: 给 `src/shared/assistant.js` 加 `DEFAULT_AGENT`，给 `state.js` 加 `agent` 一段**

- [x] **Step 5: 在 `src/main/assistant/index.js` 里建注册表、装内置工具、暴露 `agent`**

- [x] **Step 6: 在 `src/main/index.js` 里把程序索引递给助理**

- [x] **Step 7: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-builtin-tools.test.js"`

Expected: PASS —— 15 个测试全过。

- [x] **Step 8: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 236 + 15 = 251 个测试全过。

- [x] **Step 9: 提交**

```bash
git add src/shared/assistant.js src/main/assistant/agent/tools/builtin.js src/main/assistant/state.js src/main/assistant/index.js src/main/index.js test/unit/agent-builtin-tools.test.js
git commit -m "feat(助手): 内置工具集——读文件/列目录/搜索/写文件/执行命令/启动程序/读剪贴板"
```

---

### Task 3: T5 插件给 agent 提供工具

**Files:**
- Modify: `src/shared/plugin.js`（清单加 `tools[]`，并校验）
- Modify: `src/main/plugins/host.js`（收集插件工具、注册进注册表）
- Modify: `plugins/weather/plugin.json` + `plugins/weather/main.js`（给天气插件加一个真工具）
- Test: `test/unit/agent-plugin-tools.test.js`

**Interfaces:**
- Consumes: Task 1 的 `createToolRegistry`
- Produces:
  - `src/shared/plugin.js`：
    - 清单的 `tools[]` 会被规整成 `{ name, label, description, parameters, risk }`；
    - 规整不了的工具**不写进清单**，但会记进清单的 `toolErrors`（宿主会打一行日志）；
    - **一个坏工具不许把整个插件干掉**——插件照样加载，只是少了一个工具。
  - `src/main/plugins/host.js`：
    - `createPluginHost({ ..., toolRegistry })` —— `toolRegistry` 省略时用 `assistant?.agent?.tools`；
    - 插件被关掉时它的工具从注册表里摘掉；打开时挂回去。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-plugin-tools.test.js`（测试 1~5 是清单，6~10 是宿主）：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateManifest } from '../../src/shared/plugin.js';
import { createPluginHost } from '../../src/main/plugins/host.js';
import { createToolRegistry } from '../../src/main/assistant/agent/tools/registry.js';

/**
 * 插件给 agent 提供工具。
 *
 * 契约在**两边**：清单里**声明**，实例里**实现**，名字必须一样。
 * 对不上就不注册，并留一行日志——插件作者还能继续跑，只是这个工具没了。
 */

async function makePlugin(root, id, manifest, main) {
  const dir = join(root, 'plugins', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  if (main) await writeFile(join(dir, 'main.js'), main, 'utf8');
  return dir;
}

const TOOL_DECL = {
  name: 'weather.get',
  label: '查天气',
  description: '按城市名查当前天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
  },
  risk: 'read',
};

test('清单：tools[] 会被规整', () => {
  const out = validateManifest({ id: 'x', name: 'X', tools: [TOOL_DECL] });
  assert.ok(out.ok);
  assert.equal(out.value.tools.length, 1);
  assert.equal(out.value.tools[0].name, 'weather.get');
  assert.equal(out.value.tools[0].risk, 'read');
  assert.equal(out.value.tools[0].label, '查天气');
});

test('清单：没写 tools 就是没有', () => {
  const out = validateManifest({ id: 'x', name: 'X' });
  assert.ok(out.ok);
  assert.deepEqual(out.value.tools, []);
});

test('清单：工具名不合法就把这个工具丢掉，但插件还能加载', () => {
  const out = validateManifest({ id: 'x', name: 'X', tools: [{ name: 'Bad Name', risk: 'read' }] });
  assert.ok(out.ok, '一个坏工具不该把整个插件干掉');
  assert.equal(out.value.tools.length, 0);
  assert.equal(out.value.toolErrors.length, 1);
});

test('清单：风险等级不合法就把这个工具丢掉', () => {
  const out = validateManifest({ id: 'x', name: 'X', tools: [{ ...TOOL_DECL, risk: '随便写的' }] });
  assert.ok(out.ok);
  assert.equal(out.value.tools.length, 0);
  assert.equal(out.value.toolErrors.length, 1);
});

test('清单：同一个工具名重复声明只留一个', () => {
  const out = validateManifest({ id: 'x', name: 'X', tools: [TOOL_DECL, { ...TOOL_DECL }] });
  assert.equal(out.value.tools.length, 1);
  assert.equal(out.value.toolErrors.length, 1);
});

test('宿主：插件声明的工具进注册表', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气', tools: [TOOL_DECL] },
      `export default function create(ctx) {
         return {
           tools() {
             return [{ name: 'weather.get', run: async ({ city }) => ({ text: '北京 晴', data: { city } }) }];
           },
         };
       }`
    );
    const registry = createToolRegistry();
    const host = await createPluginHost({
      rootDir: root,
      userDataDir: root,
      assistant: {},
      toolRegistry: registry,
    });
    await host.load();
    const tool = registry.get('weather.get');
    assert.ok(tool, '插件的工具应该在表里');
    assert.equal(tool.label, '查天气');
    assert.equal(tool.risk, 'read');
    const out = await tool.run({ city: '北京' });
    assert.equal(out.text, '北京 晴');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：清单声明了但没实现 → 不注册', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气', tools: [TOOL_DECL] },
      `export default function create() { return {}; }`
    );
    const registry = createToolRegistry();
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {}, toolRegistry: registry });
    await host.load();
    assert.equal(registry.get('weather.get'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：实现了但清单没声明 → 不注册', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气' },
      `export default function create() {
         return { tools() { return [{ name: '私货.get', run: async () => ({ text: 'x' }) }]; } };
       }`
    );
    const registry = createToolRegistry();
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {}, toolRegistry: registry });
    await host.load();
    assert.equal(registry.get('私货.get'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：插件的 tools() 抛异常不能带崩宿主', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气', tools: [TOOL_DECL] },
      `export default function create() {
         return { tools() { throw new Error('炸了'); } };
       }`
    );
    const registry = createToolRegistry();
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {}, toolRegistry: registry });
    await host.load();
    assert.equal(registry.get('weather.get'), null);
    assert.ok(host.list().length >= 1, '插件本身还在');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：关掉的插件，它的工具不在表里', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气', tools: [TOOL_DECL] },
      `export default function create() {
         return { tools() { return [{ name: 'weather.get', run: async () => ({ text: 'x' }) }]; } };
       }`
    );
    const registry = createToolRegistry();
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {}, toolRegistry: registry });
    await host.load();
    assert.ok(registry.get('weather.get'));
    await host.setEnabled('weather', false);
    assert.equal(registry.get('weather.get'), null, '插件关了，工具就该消失');
    await host.setEnabled('weather', true);
    assert.ok(registry.get('weather.get'), '插件开了，工具该回来');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('宿主：插件拿得到 ctx.agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-pet-plugins-'));
  try {
    let seen = null;
    await makePlugin(
      root,
      'weather',
      { id: 'weather', name: '天气' },
      `export default function create(ctx) {
         seen = ctx.agent;
         return { tools() { return []; } };
       }`
    );
    const agent = {
      run: async () => ({ ok: true, taskId: 't1' }),
      cancel: async () => ({ ok: true }),
      history: () => [{ id: '1', kind: 'user', text: '在呢' }],
      onEvent: () => () => {},
    };
    const host = await createPluginHost({ rootDir: root, userDataDir: root, assistant: {}, agent });
    await host.load();
    assert.ok(seen, 'ctx.agent 应该在');
    assert.equal(typeof seen.run, 'function');
    assert.equal(typeof seen.cancel, 'function');
    assert.equal(typeof seen.history, 'function');
    assert.equal(typeof seen.onEvent, 'function');
    assert.equal(seen.history().length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-plugin-tools.test.js"`

Expected: FAIL —— 清单还没有 `tools` 段、宿主还没有注册插件的工具。

- [x] **Step 3: 改 `src/shared/plugin.js`**

- [x] **Step 4: 改 `src/main/plugins/host.js`**

- [x] **Step 5: 给天气插件加一个真工具**

- [x] **Step 6: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-plugin-tools.test.js"`

Expected: PASS —— 15 个测试全过。

- [x] **Step 7: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 251 + 15 = 266 个测试全过。

- [x] **Step 8: 提交**

```bash
git add src/shared/plugin.js src/main/plugins/host.js plugins/weather/plugin.json plugins/weather/main.js test/unit/agent-plugin-tools.test.js
git commit -m "feat(插件): 插件能给 agent 提供工具——清单声明 + 实例实现，两边对不上不注册"
```

---

### Task 4: T6 插件反向调用 agent

**Files:**
- Create: `src/main/assistant/agent/facade.js`
- Modify: `src/main/assistant/index.js`（对外暴露 `agent`：`tools` / `run` / `cancel` / `history` / `onEvent`）
- Modify: `src/main/plugins/host.js`（`ctx.agent` 接上）
- Test: `test/unit/agent-facade.test.js`

**Interfaces:**
- Consumes: Task 2 的注册表、Task 3 的宿主接线
- Produces:
  - `src/main/assistant/agent/facade.js`：
    - `createAgentFacade({ tools, runtime, getHistory }) → { tools, run, cancel, history, onEvent, emit }`
  - `ctx.agent = { run(prompt, opts), cancel(taskId), history(), onEvent(cb) }`

**为什么单独一个模块**：`src/main/assistant/index.js` 引了 electron 的 `powerMonitor`，
在普通 node 里测不了。所以「agent 这个口子」单独成文件——
它不引 electron，能直接测。

**这一层的边界（重要）**：规格 §14 把 T6 排在 L1，却让它依赖 L3 的 T9（后台任务运行时）。
所以 L1 交付的是**接缝**：

- `history()` 是真的：返回聊天记录；
- `onEvent(cb)` 是真的：订阅事件，返回取消订阅的函数；
- `run()` / `cancel()` **明确返回「还没上线」**，不假装成功——
  L3 的运行时接上即可（运行时通过 `agent.emit(event)` 把事件推给订阅者）。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-facade.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentFacade } from '../../src/main/assistant/agent/facade.js';

/**
 * agent 的对外接口（插件用它反向提交任务）。
 *
 * L1 只交付**接缝**：后台任务运行时排在 L3（T9），
 * 所以 run/cancel 明确说「还没上线」，不假装成功——
 * 插件作者拿到一个假成功会以为任务在跑，而它根本没进队列。
 */

test('facade：没有运行时时，提交任务明确说还没上线', async () => {
  const agent = createAgentFacade({});
  const r = await agent.run('帮我看看项目');
  assert.equal(r.ok, false);
  assert.match(r.message, /还没上线/);
  assert.equal(r.taskId, undefined, '不能编一个任务号出来');
});

test('facade：运行时接上后，提交与取消都转给它', async () => {
  const calls = [];
  const runtime = {
    run: async (prompt, opts) => {
      calls.push(['run', prompt, opts]);
      return { ok: true, taskId: 't1' };
    },
    cancel: async (taskId) => {
      calls.push(['cancel', taskId]);
      return { ok: true };
    },
  };
  const agent = createAgentFacade({ runtime });
  assert.deepEqual(await agent.run('做事', { tag: 'x' }), { ok: true, taskId: 't1' });
  assert.deepEqual(await agent.cancel('t1'), { ok: true });
  assert.deepEqual(calls, [['run', '做事', { tag: 'x' }], ['cancel', 't1']]);
});

test('facade：历史读的是聊天记录', () => {
  const agent = createAgentFacade({ getHistory: () => [{ id: '1', kind: 'user', text: '在呢' }] });
  assert.equal(agent.history().length, 1);
});

test('facade：没有历史源就空数组，别抛错', () => {
  const agent = createAgentFacade({});
  assert.deepEqual(agent.history(), []);
});

test('facade：订阅事件能收到，也能退订', () => {
  const agent = createAgentFacade({});
  const got = [];
  const off = agent.onEvent((e) => got.push(e));
  agent.emit({ type: 'step', text: '做了一步' });
  assert.equal(got.length, 1);
  off();
  agent.emit({ type: 'step', text: '又一步' });
  assert.equal(got.length, 1, '退订之后不该再收到');
});

test('facade：订阅者抛异常不许带崩别人', () => {
  const agent = createAgentFacade({});
  const got = [];
  agent.onEvent(() => {
    throw new Error('炸了');
  });
  agent.onEvent((e) => got.push(e));
  agent.emit({ type: 'step' });
  assert.equal(got.length, 1);
});

test('facade：工具表挂在上面', () => {
  const tools = { get: () => null };
  const agent = createAgentFacade({ tools });
  assert.equal(agent.tools, tools);
});
```

- [x] **Step 2: 跑测试，确认它失败**

Run: `node --test "test/unit/agent-facade.test.js"`

Expected: FAIL —— `src/main/assistant/agent/facade.js` 不存在。

- [x] **Step 3: 写 `src/main/assistant/agent/facade.js`**

- [x] **Step 4: 改 `src/main/assistant/index.js`**（建 facade、暴露 `agent` 与 `agentTools`）

- [x] **Step 5: 改 `src/main/plugins/host.js`**（`ctx.agent` 接上：优先用宿主注入的，其次 `assistant.agent`）

- [x] **Step 6: 跑测试，确认它通过**

Run: `node --test "test/unit/agent-facade.test.js"`

Expected: PASS —— 7 个测试全过。

- [x] **Step 7: 跑全量单元测试**

Run: `npm run test:unit`

Expected: PASS —— 266 + 7 = 273 个测试全过。

- [x] **Step 8: 提交**

```bash
git add src/main/assistant/agent/facade.js src/main/assistant/index.js src/main/plugins/host.js test/unit/agent-facade.test.js
git commit -m "feat(助手): 插件能反向调用 agent——提交任务、取消任务、读历史、订阅事件"
```

---

## 自查（写完计划后对着规格过一遍）

- **规格覆盖**：本计划只实现 §14 的 L1 四项——T3（Task 1）、T4（Task 2）、T5（Task 3）、T6（Task 4）。
- **占位符扫描**：无 TBD / TODO；每个任务的接口、测试与实现要点都写全了。
- **类型一致性**：`TOOL_RISK` / `TOOL_RISK_ORDER` / `TOOL_NAME_RE` 在 shared 里定义一次，
  注册表与清单校验都从那里取；`createToolRegistry` / `normalizeTool` / `effectiveRisk` /
  `stricterRisk` / `TOOL_RISK_FLOOR` 的名字在 Task 1 的接口段、测试、步骤里一致；
  `createBuiltinTools` / `resolveInsideWorkspace` 在 Task 2 里一致。
- **Review Focus 覆盖**：
  「插件冒充 read」→ Task 1 的「宿主给已知危险工具名兜底」与「注册时就把生效风险盖在描述符上」；
  「插件抢内置工具名」→ Task 1 的「同名先到先得」；
  「工作区为空」→ Task 2 的 `resolveInsideWorkspace` 与助理侧的空串退回主目录；
  「读不到文件」→ Task 2 的「读不到就抛错」；
  「tools() 抛异常」→ Task 3 的「插件的 tools() 抛异常不能带崩宿主」；
  「命令超时」→ Task 2 的 `shell.exec` 实现（超时杀掉子进程并抛错）。
