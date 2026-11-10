# 桌宠内置 Agent 运行时 · L4 外部 harness 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 L4 的两件事做完——**T13 harness 适配器**（把 claude code CLI 的 JSONL 输出解析成 step 事件、Windows 上取消杀进程树、超时与日志落盘）、**T14 harness 接入**（`harness.run` 工具出现在工具表里，输出以异步事件流成步骤）。

**Architecture:** 三块，按依赖排队：

```
T13 agent/harness.js   适配器：起子进程 / 解析 JSONL / 杀进程树 / 落日志
                        （不 import electron，能在普通 node 里测）
   │
   ▼
事件通道 agent/loop.js  工具的 ctx 从 {signal} 扩成 {signal, onEvent, taskId}
                        —— 工具要能**异步**往记录里塞东西
   │
   ▼
T14 agent/tools/       harness.run 工具 + 接线（assistant/index.js）
    builtin.js +       工具表里多一个「外部任务」，审批按 exec 走
    assistant/index.js
```

- **为什么先做适配器**：CLI 的输出格式是**实测**出来的（见下面「实测到的 CLI 输出格式」），
  格式不对的话后面全白搭。适配器是纯函数 + 一个能注入假 spawn 的启动器，能脱离 Electron 单测。
- **为什么要动工具的 ctx**：规格 §9 明写「harness 的任务是 agent 循环里的**一个步骤**，
  但它自己可能跑很久——所以它必须能**异步地产出事件**，而不是阻塞循环直到结束」。
  工具的 ctx 现在只有 `signal`（`agent/loop.js` 里 `tool.run(args, { signal })`），
  没有地方把异步事件送回记录——**这条通道必须先有**，再做别的。
- **为什么工具跑起来立刻返回**：规格 §9 的原话。harness 可能跑好几分钟，
  agent 循环不能卡在那儿等。工具返回「已启动」，后续输出以异步事件进记录。

**Tech Stack:** Electron + Node（`node --test` 跑单元测试，无测试框架依赖）。
适配器与事件通道**都不 import electron**。

**Spec:** `docs/superpowers/specs/2026-11-07-agent-runtime-design.md`（§9 外部 harness、§14 的 **L4** 两项：T13 / T14）

---

## Global Constraints

- **注释与文档用中文。** 每个新文件开头一段块注释，说明「这是什么」和「为什么这么写」。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `test(助手): …` / `docs(助手): …`。
- **能被测到的改动，先写测试。** 每个任务都按 RED→GREEN 走。
- **Edit 的 `file_path` 必须是绝对路径。**
- **不碰用户的真实配置**：单元测试注入假的 spawn、假的信号；不读真实 `assistant.json`。
- **用户给模型的字符串不进命令行。** harness 的 prompt 走 **stdin**，不进 argv——
  走 argv 就等于把它交给 shell 去拼，模型写一句 `"; rm -rf ~` 就能在用户机器上执行。
- **取消必须杀整棵进程树。** `child.kill()` 在 Windows 上杀不掉孙进程，
  复用 `agent/tools/builtin.js` 里现成的 `killProcessTree`（`taskkill /T /F`），别重写一份。
- **单元测试命令：** `npm run test:unit`（等价于 `node --test "test/unit/**/*.test.js"`）。

## 这几件事最容易做错（写代码时反复看）

1. **CLI 的输出不是每一行都是 JSON。**
   实测：stdout 正常时是一行一个 JSON，但 CLI 自己也会往 stdout 吐纯文本
   （例如安全分类器不可用时的整段说明）。解析器必须**跳过认不出的行**，不能抛。
2. **Windows 上 `spawn('claude', …)` 直接 ENOENT。**
   npm 装出来的是 `claude.cmd` 批处理，Node 不能直接执行它。
   要么 `shell: true`（命令行里只有固定参数，**没有用户数据**，所以安全），
   要么自己找 `claude.exe`。本计划选 `shell: true` + 固定参数表。
3. **prompt 走 stdin，不走 argv。** 见 Global Constraints。
4. **harness 的工具风险是 exec，不是 read。**
   它能在用户机器上做任何事，风险等级必须与 `shell.exec` 同档（`TOOL_RISK.EXEC`），
   否则审批策略会放它过关。
5. **harness 的权限模式要跟桌宠自己的审批档位对齐。**
   headless 运行里没有人能回答 CLI 的权限提问——所以档位要**翻译**成 CLI 的
   `--permission-mode`，而不是让 CLI 去问一个不会有人答的问题。
6. **工具返回之后子进程还在跑。** 循环已经往下走了，
   子进程的退出、超时、取消都要**在工具之外**处理（适配器自己兜着）。
7. **取消/超时之后必须杀掉进程树**，否则孙进程占着管道，
   `close` 事件永远不来，任务永远不结束。

## Review Focus

以下是规格暗示、但**没有一个任务的测试会覆盖**的输入类与失败模式。按「最可能先咬到人的」排序：

1. **CLI 没装 / 不在 PATH** → 工具要报一句人话（「找不到 claude 命令」），不是「spawn ENOENT」。
2. **CLI 吐了一行非 JSON** → 跳过它，但**写进日志**（那是排查的唯一线索）。
3. **CLI 退出码非 0** → 退出码与 stderr 都要进记录，不能只说一句「失败了」。
4. **超时** → 杀进程树 + 记录里写明「超时了（多少毫秒）」。
5. **任务被取消** → 杀进程树，**不**当成失败通知用户（取消是用户自己的意思）。
6. **harness 的输出比任务活得久** → 任务先结束，harness 的步骤后到：
   步骤要落在**同一个任务块**里（靠 taskId 归组），不能变成孤儿。
7. **模型给的 cwd 不存在** → 报「目录不存在」，不是 `spawn ENOENT`。
8. **prompt 里有引号、换行、`&&`、`|`** → 一个字都不能改变命令行结构。

---

## 附：实测到的 claude code CLI 输出格式

**这一节是 T13 的第一个动作的产物**（规格 §15：「不能照抄记忆」）。
实测环境：Windows 11、`claude` 2.1.319（npm 全局安装）。

### 命令行

```
claude --print --output-format stream-json --verbose --permission-mode <mode> --no-session-persistence
```

- `--print`（`-p`）：非交互，一次跑完就退出。
- `--output-format stream-json`：stdout 变成 **JSONL**（一行一个 JSON）。
- `--verbose`：配合 stream-json 才有完整的输出。
- `--permission-mode`：`acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan`。
- **prompt 走 stdin**：`printf '提示词' | claude -p --output-format stream-json …`
  —— 实测有效，且 stdout 仍然是 JSONL。这样命令行里就没有任何用户数据了。

### stdout 的四种行

```jsonc
// 1. 开头一定有这一行
{"type":"system","subtype":"init","cwd":"…","session_id":"…","tools":[…],"model":"…",…}

// 2. 模型调工具
{"type":"assistant","message":{"role":"assistant","content":[
   {"type":"tool_use","id":"call_…","name":"Read","input":{"file_path":"…"}}],…},
 "session_id":"…","uuid":"…","timestamp":"…"}
//    content 里也可能是 {"type":"text","text":"…"}（模型自己说话）

// 3. 工具的结果
{"type":"user","message":{"role":"user","content":[
   {"tool_use_id":"call_…","type":"tool_result","content":"1\thello\n2\t"}]},
 "tool_result_meta":[{"id":"call_…","permission_decision":{"decision":"accept","source":"config","reason_type":"mode"}}],…}

// 4. 最后一行：结果
{"type":"result","subtype":"success","is_error":false,"result":"最终答复",
 "total_cost_usd":0.017,"usage":{…},"num_turns":2,"duration_ms":1234,"session_id":"…"}
```

### 实测到的三件事

1. **stderr 是噪音**：`[claude-code:unrecognized_model] {…}` 之类，**不是 JSON**。
   它只进日志，不进解析。
2. **stdout 也可能出现非 JSON 的整段纯文本**（例如安全分类器不可用时的说明）。
   → 解析器必须跳过认不出的行。
3. **退出码是 0**，哪怕模型这轮没干成事；真正的成败看 `result.is_error` 与 `result.subtype`。

---

### Task 1: T13 harness 适配器

**Files:**
- Create: `src/main/assistant/agent/harness.js`
- Test: `test/unit/agent-harness.test.js`

**Interfaces:**
- Produces:
  - `src/main/assistant/agent/harness.js`：
    - `HARNESS_AGENTS`：支持的外部助手（目前只有 `claude`），每项带 `label`、`command` 与固定 `args`
    - `permissionModeForPolicy(policy)` → CLI 的 `--permission-mode`
      （`auto`→`bypassPermissions`、`graded`→`acceptEdits`、`manual`→`dontAsk`）
    - `parseHarnessLine(line)` → **事件数组**（认不出的行返回空数组）
      - 一条 assistant 消息里可能有多个内容块（先说话、再调工具），
        丢掉一个就丢信息——所以是数组，不是单个事件
      - kind：`'init'` / `'tool_use'` / `'tool_result'` / `'text'` / `'result'`
    - `createHarnessRunner({spawn, killTree, logDir, now})` → `{ run(args) }`
      - `run({agent, prompt, cwd, timeoutMs, taskId, permissionMode, onEvent, signal})` → `{ok, agent, label, logPath}`
      - **立刻返回**（不等子进程结束），子进程的后续输出走 `onEvent`
- Consumes: `killProcessTree`（`agent/tools/builtin.js` 里现成的那个）

**描述：**

`run()` 做四件事：

1. 起子进程（`claude --print --output-format stream-json --verbose --permission-mode <mode> --no-session-persistence`），
   **prompt 写进 stdin**（写完就 `end()`）。
2. stdout 按行切，逐行 `parseHarnessLine`：
   - 认得出的 → `onEvent({kind, …})`；
   - 认不出的 → **只写日志**。
3. stderr 全部写进日志。
4. 退出/超时/取消：
   - 超时 → `killProcessTree` + `onEvent({kind:'error', error:'超时了…'})`；
   - 取消（`signal` aborted）→ `killProcessTree`，**不**报失败；
   - 正常退出 → `onEvent({kind:'result', …})`，退出码非 0 或 `is_error` 时带 `error`。

**日志**：`userData/agent-logs/<taskId>.log`，每行 `[时间] 来源 内容`。
stdout 的原始行与 stderr 都进去——排查时只有它。

- [x] **Step 1: 写失败的测试**

创建 `test/unit/agent-harness.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHarnessLine, HARNESS_AGENTS } from '../../src/main/assistant/agent/harness.js';

const kindOf = (line) => parseHarnessLine(line)[0]?.kind;

test('认得出 CLI 的四种行', () => {
  assert.equal(kindOf('{"type":"system","subtype":"init"}'), 'init');
  assert.equal(
    kindOf('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"a"}}]}}'),
    'tool_use'
  );
  assert.equal(
    kindOf('{"type":"user","message":{"content":[{"tool_use_id":"c1","type":"tool_result","content":"ok"}]}}'),
    'tool_result'
  );
  assert.equal(
    kindOf('{"type":"assistant","message":{"content":[{"type":"text","text":"说点什么"}]}}'),
    'text'
  );
  assert.equal(kindOf('{"type":"result","subtype":"success","result":"干完了"}'), 'result');
});

test('认不出的行返回空数组（不抛）', () => {
  assert.deepEqual(parseHarnessLine('MiniMax is temporarily unavailable…'), []);
  assert.deepEqual(parseHarnessLine(''), []);
  assert.deepEqual(parseHarnessLine('{"type":"assistant"'), []);
});
```

- [x] **Step 2: 跑测试，确认它失败**

```bash
node --test "test/unit/agent-harness.test.js"
```

- [x] **Step 3: 写 `parseHarnessLine` 与 `HARNESS_AGENTS`，让测试过**

- [x] **Step 4: 写启动器的失败测试**（假 spawn：一个能吐数据的假子进程）

```js
test('启动器：立刻返回，输出以事件的形式流出来', async () => { … });
test('启动器：非零退出码要带在事件里', async () => { … });
test('启动器：认不出的行不抛，只进日志', async () => { … });
test('启动器：超时要杀掉进程树', async () => { … });
test('启动器：取消要杀掉进程树，且不算失败', async () => { … });
```

- [x] **Step 5: 跑测试，确认它失败**
- [x] **Step 6: 写 `createHarnessRunner`，让测试过**
- [x] **Step 7: 跑全部单元测试**

```bash
npm run test:unit
```

---

### Task 2: 工具的事件通道（ctx 扩成三样）

**Files:**
- Modify: `src/main/assistant/agent/loop.js`（`runOne` 造 ctx；`run` 把 index 传进去）
- Modify: `src/main/assistant/chat/agent.js`（`chat(ctx)` 收 `taskId`，传给循环）
- Modify: `src/main/assistant/agent/tasks.js`（`backend.chat({…, taskId: scope.taskId})`）
- Modify: `src/main/assistant/agent/record.js`（`stepRecord` 支持 `label`）
- Test: `test/unit/agent-harness-events.test.js`

**Interfaces:**
- Produces:
  - 工具的 ctx：`{ signal, onEvent, taskId }`
    - `onEvent(payload)`：`{tool?, label?, args?, result?, error?, data?}`
      → 循环把它变成一条 step 事件（`type:'step'`）
    - `taskId`：字符串；没有任务时是空串
  - `stepRecord({…, label})`：`label` 非空时用它当条目的正文（页面上显示的那行）

**描述：**

`onEvent` 与循环自己的 `onEvent` 是同一条路：`payload` 会被补上
`type:'step'`、`index`（这次工具调用的序号）、`tool`（默认是那个工具的名字）。

**为什么要有 `label`**：step 记录的正文就是工具名。
harness 的步骤要让人看得懂（「外部任务读了 note.txt」），
光有工具名与参数预览不够——所以允许调用方给一行人话。

- [x] **Step 1: 写失败的测试**（假工具往 `ctx.onEvent` 推一条，断言它变成了一条 step 事件）
- [x] **Step 2: 跑测试，确认它失败**
- [x] **Step 3: 改 `loop.js` / `chat/agent.js` / `tasks.js` / `record.js`，让测试过**
- [x] **Step 4: 跑全部单元测试**

---

### Task 3: T14 harness 工具与接线

**Files:**
- Modify: `src/main/assistant/agent/tools/builtin.js`（工具表里多一个 `harness.run`）
- Modify: `src/main/assistant/index.js`（造 runner、传日志目录、传审批档位）
- Test: `test/unit/agent-harness-tool.test.js`
- Test: `test/e2e/harness.spec.js`

**Interfaces:**
- Produces:
  - 工具 `harness.run`：`{agent, prompt, cwd, timeout}`
    - `agent`：外部助手的名字（目前 `claude`）
    - `prompt`：交给它的活儿
    - `cwd`：工作目录（默认是工作区）
    - `timeout`：毫秒（默认取设置里的工具超时）
  - 风险等级：`TOOL_RISK.EXEC`

**描述：**

工具**立刻返回**「已启动」，不等子进程结束（规格 §9）。
返回的那句话要跟模型说清楚：**结果会陆续出现在记录里，别自己编一个结果出来**。

**审批档位 → CLI 权限模式**（headless 里没人能回答 CLI 的提问）：

| 桌宠的档位 | CLI 的 `--permission-mode` | 效果 |
|---|---|---|
| `auto`（都不问） | `bypassPermissions` | 什么都能做（用户自己选的） |
| `graded`（问一声） | `acceptEdits` | 读与改文件自动过，跑命令被拒（没人能点头） |
| `manual`（每件事都问） | `dontAsk` | 需要权限的动作一律被拒 |

- [x] **Step 1: 写失败的测试**（工具表里有 `harness.run`；风险是 exec；跑起来立刻返回）
- [x] **Step 2: 跑测试，确认它失败**
- [x] **Step 3: 写工具与接线，让测试过**
- [x] **Step 4: 写 e2e**
- [x] **Step 5: 跑全部单元测试与 e2e**

**e2e 的做法（跟计划里写的不一样，记一下为什么）：**

计划里说的是「真起一个 node 子进程吐 JSONL」。实际做的是**一个真的 CLI 都不起**：
调 `harness.run` 时 prompt 给空串，工具在起进程之前就会拒绝——
流程照样走完（工具表对得上、审批弹得出来），但不会真的把 claude code 拉起来。
e2e 里起真 CLI 要联网、要几十秒，还是一台机器上跑不了一回的速率；
CLI 本身的行为（JSONL 解析、进程树、日志）在单元测试里测。

---

## 复审要点（做完之后自己过一遍）

1. **prompt 有没有进过命令行？**（不该有）
2. **取消之后进程树杀干净了吗？**（Windows 上要 `taskkill /T /F`）
3. **非 JSON 的行有没有把解析器打挂？**
4. **harness 的步骤有没有落在正确的任务块里？**
5. **超时与非零退出码有没有进记录？**
6. **日志文件在不在 `userData/agent-logs/<taskId>.log`？**
7. **`harness.run` 的风险是不是 exec？**（不是的话审批会放它过关）
8. **任务先结束、harness 后到的情形**：步骤是不是成了孤儿？
