# 桌宠 Agent 运行时 · 剩余工作与接续说明

> **这份文档是给「清空上下文之后」的你看的。**
> 读完这一份，就能接着干，不必重新翻规格与提交历史。
>
> 日期：2026-11-10
> 总规格：`docs/superpowers/specs/2026-11-07-agent-runtime-design.md`
> 双层设计：`docs/superpowers/specs/2026-11-08-two-layer-agent-design.md`

---

## 一、现在到哪一步了

### 已经做完的（不用重做）

| 层 | 内容 | 计划文档 | 状态 |
|---|---|---|---|
| L0 | 地基（契约、状态、记录、错误处理） | `plans/2026-11-07-agent-runtime-l0.md` | ✅ 25/25 |
| L1 | 工具系统（描述符、风险等级、注册表、内置工具、插件工具） | `plans/2026-11-07-agent-runtime-l1.md` | ✅ 32/32 |
| L2 | agent 循环（多步、工具调用、审批闸门接口、上下文压缩） | `plans/2026-11-07-agent-runtime-l2.md` | ✅ 22/22 |
| L3 | 后台运行时（队列、并发、取消、重启中断、审批策略、气泡 sticky） | `plans/2026-11-08-agent-runtime-l3.md` | ✅ 36/36 |
| L5 | 界面（`ctx.push`、聊天记录插件化、实时追加、分类渲染） | `plans/2026-11-08-agent-runtime-l5.md` | ✅ 做完（勾选框没打） |
| 双层 T1–T4 | 派单记录与按层过滤、交互层后端、五个任务管理工具、两层接线 | `plans/2026-11-08-two-layer-agent.md` Task 1–4 | ✅ 做完（勾选框没打） |
| 聊天记录 T1–T10 | 两层接线、任务号、`model` 分类、`onRound`、交互层记过程、轮数与模型名、`turns.js`、页面重画、e2e | `plans/2026-11-08-chat-history-turns.md` | ✅ 做完（勾选框没打） |
| T19 | 文档：插件给 agent 提供工具 | — | ✅ `开发说明/插件开发指南.md` §`tools[]`、`插件系统架构.md` |

> **三个计划的勾选框是过期的**：L5、聊天记录、双层这三个文件的 `- [ ]` 一个没打，
> 但活儿都干完了。**别拿勾选框当进度表**，看下面的「未完成」清单。

### 未完成（按建议顺序）

| # | 缺口 | 规格出处 | 详细计划 |
|---|---|---|---|
| — | **五个缺口全部做完了** | — | — |

### 已经做完（这一轮补上的）

| # | 缺口 | 落地在哪 |
|---|---|---|
| 1 | steer 注入 | `src/main/assistant/agent/loop.js` + `chat/agent.js` 接上；`test/unit/agent-steer.test.js` |
| 2 | 派单开关 + 退役 `llm.backend` | `src/settings/` 的「桌宠能做什么」下拉；`state.js` 的 `migrateDispatch`；`test/e2e/dispatch-mode.spec.js` |
| 3 | L6 T18 设置界面 | `src/settings/index.html` 的「后台任务」分组 + `src/settings/main.js`；`test/unit/agent-settings.test.js`、`test/e2e/agent-settings.spec.js` |
| 4 | L4 外部 harness（T13/T14） | `src/main/assistant/agent/harness.js`、`builtin.js` 的 `harness.run` 工具、`index.js` 的接线；`plans/2026-11-10-agent-runtime-l4.md`；`test/unit/agent-harness*.test.js`、`test/e2e/harness.spec.js` |
| 5 | T20 审批气泡 e2e | `test/e2e/approval-bubble.spec.js` |

> **缺口 3 的一个决定**：`maxTokensPerTask` **没有做成设置项**。
> 全仓库没有任何地方解析接口返回的 token 用量（`src/main/assistant/llm/openai.js`
> 的 `parseFrame` / `parseCompletionBody` 都不返回 `usage`），
> 流式请求要拿用量还得发 `stream_options`——代码里明确记着
> 「严格的服务端会报未知字段直接 400」。
> 要真接上得先改 LLM 客户端（带「服务端不认就撤掉」的兜底），那是另一件事。

---

## 二、原来的五件事（都已做完，留着当背景）

### 缺口 1 · steer 注入（用户追加的要求没进执行层）

**现象**：交互层能调用 `task.steer`（`src/main/assistant/layer/taskTools.js:172`），
指令也确实排进了任务队列，但**执行层的 agent 循环从来不取**——
所以用户说「顺便也看看 D 盘」，桌宠回一句「好」，然后什么也没发生。

**精确位置**

| 文件 | 行 | 现状 |
|---|---|---|
| `src/main/assistant/agent/runtime.js` | 129 | `steer: () => task.steerNotes.splice(0)` —— 队列有了，取它的钩子也有了 |
| `src/main/assistant/agent/runtime.js` | 297 / 320 / 344 | `steer()` / `archive()` / 取消时清空队列 |
| `src/main/assistant/agent/loop.js` | 83 | `createAgentLoop` 的选项里**没有** `steer` |
| `src/main/assistant/agent/loop.js` | 132 | 步骤边界 `while (steps < maxSteps)` —— 注入点就在这里 |
| `src/main/assistant/agent/loop.js` | 351 | `tool.run(args, { signal })` —— 工具拿到的 ctx 只有 signal |
| `src/main/assistant/chat/agent.js` | 59 | `chat(ctx)` 解构出 `messages/config/onDelta/onEvent/signal`，**没有** `steer` |
| `src/main/assistant/chat/agent.js` | 84 | 调 `createAgentLoop` 时没传 `steer` |
| `src/main/assistant/agent/tasks.js` | 143 / 183 | `run: async (scope) =>` 拿得到 `scope.steer`，但 `backend.chat({...})` 没往下传 |

**做法**：在 `loop.js` 的**步骤边界**（`while` 循环开头，`steps += 1` 之前）
读一次 steer 队列，有新指令就作为一条 `role:'user'` 插进上下文。
正在执行的工具调用**不打断**。

**验收标准**

- 新增 `test/unit/agent-steer.test.js`，至少覆盖：追加的要求在**下一步**开头进上下文；
  正在执行的工具调用不被中途打断；一条指令**只读一次**（`splice(0)` 取走即清空）；
  任务取消后队列作废。
- `node --test "test/unit/**/*.test.js"` 全绿。

**坑**

- 注入点必须在步骤边界，不能在 `tool.run` 前后——不然会打断正在跑的工具。
- 「取走即清空」不能省：留在队列里的会被下一轮再读一遍，模型会当成新要求重复执行。
- 别新建 `assistant/agent/steer.js`。规格 §10.1 列了它，但计划第 83 行已说明这是有意偏差：
  队列直接挂在任务对象上（`task.steerNotes`），单开一个文件只是把一个数组包一层。

---

### 缺口 2 · 派单开关与 `llm.backend` 退役

**现象**：`dispatchEnabled()` 恒返回 `true`（`src/main/assistant/index.js:377`）。
用户没有任何办法关掉「桌宠能派单、能动手」这件事。

**精确位置**

| 文件 | 行 | 现状 |
|---|---|---|
| `src/main/assistant/index.js` | 377 | `function dispatchEnabled() { return true; }` |
| `src/shared/assistant.js` | 72 / 80 / 94 | `LLM_BACKENDS` / `LLM_BACKEND_INFO` / `llmBackendInfo` —— 要退役 |
| `src/shared/assistant.js` | 223 | `DEFAULT_LLM.backend = 'chat'` —— 要删 |
| `src/shared/assistant.js` | 263 | `DEFAULT_AGENT` —— **没有** `dispatch` 键，要加 |
| `src/main/assistant/state.js` | 186 | 清洗 `llm.backend` 的那行，要删 |
| `src/main/assistant/state.js` | 227–257 | `agent` 块是**逐字段重建**的，加 `dispatch` 必须在这里显式加 |
| `src/settings/index.html` | — | 「对话后端」下拉**已经不在了**（聊天记录计划 Task 3 撤的） |
| `src/settings/main.js` | 542 | `assistantPatchFromControls()` 产出的补丁里**没有** `agent` 键 |
| `src/shared/assistant.js` | 341 / 353 / 387 | `CHAT_KIND.DISPATCH` / `CHAT_KIND_LIMITS` / `CHAT_KIND_FOR_LAYER` —— 派单记录那一套**已经在了** |

**做法**（= 计划的 Task 6，九步）

1. 共享契约加 `DISPATCH_MODES = ['auto','off']`、`DISPATCH_MODE_INFO`、`dispatchModeInfo(id)`、
   `DEFAULT_AGENT.dispatch = 'auto'`；删 `LLM_BACKENDS` / `LLM_BACKEND_INFO` / `llmBackendInfo` /
   `DEFAULT_LLM.backend`。
2. `state.js` 删 `llm.backend`，加 `agent.dispatch` 与**迁移**。
3. 设置页加「桌宠能做什么」下拉（`#llmDispatch`），选项从 `DISPATCH_MODES` 填。
4. `dispatchEnabled()` 改成读 `state.agent.dispatch`。
5. 删 `test/unit/llm-backends.test.js`，新增 `test/unit/dispatch-modes.test.js`；
   改 `test/unit/agent-backend.test.js:163`（它断言 `llm.backend` 还在）；
   新增 `test/e2e/dispatch-mode.spec.js`。

**验收标准**

- 迁移规则精确：`llm.backend === 'agent'` → `dispatch: 'auto'`；
  `llm.backend === 'chat'` → `dispatch: 'off'`（**保守**：不给老用户平白发一个能动手的能力）；
  **整个文件里没有 `llm` 段**（新装）→ `'auto'`。
- 设置页改完立刻落盘 `assistant.json`，重启后还在。
- 派单关掉时，交互层**只带快工具**（时钟/剪贴板/读单文件/列目录），不带五个任务管理工具。
  这条**开关那一侧已经写好了**（`src/main/assistant/layer/interaction.js:65–72`：
  `dispatchEnabled ? getTaskTools(turn) : []`），缺的是让它读到设置。

**坑**

- **迁移要看 `raw.llm`，不能看清洗后的结果**。`sanitizeAssistant` 总会补一个
  `llm.backend = 'chat'` 的默认值；拿它判断会把「新装」误判成「选过普通对话」，
  于是新用户默认拿不到派单能力。判断必须落在 `raw.llm?.backend === undefined` 这一支上。
- **`state.js` 的 `agent` 块是显式重建的**（227–257 行逐字段列出）。
  在 `DEFAULT_AGENT` 里加了 `dispatch` 却不在这儿加，值会在清洗时**被丢掉**——
  这正是 `index.js:373–376` 那段注释说的事。
- **计划里的两处引用已经过期**（Task 6 Step 5 与 Step 9）：
  - 「把 `llmBackend` 下拉换成 `llmDispatch`」——`#llmBackend` **早就不存在了**，
    现在的动作是**新增**一个下拉，不是替换。
  - `git rm test/e2e/backend-select.spec.js` —— 那个文件**已经删过**（聊天记录计划 Task 3）。
- `test/unit/agent-backend.test.js:163` 那个用例（「后端取值：只认 chat 与 agent」）
  在 `llm.backend` 退役后会直接失败，必须一起改。

---

### 缺口 3 · L6 T18 设置界面

**现象**：`state.agent` 里 `maxConcurrent` / `maxSteps` / `workspace` / `timeoutMs` /
`approval.policy` / `approval.allowAlways` **全都存在**，主进程也全都读了
（`src/main/assistant/index.js:194–219`、`329–331`），但**设置页一个控件都没有**——
用户改不了。Task 6 补的「桌宠能做什么」只覆盖派单那一个。

**规格要求**（总规格 §14 L6 T18）：可选后端、并发数、审批策略、永久放行列表、
工作区、步数/超时上限。

「可选后端」这一项已被缺口 2 取代（现在是「桌宠能做什么」）。剩下五项：
并发数、审批策略三档（auto/graded/manual）、永久放行的工具名列表、工作区、
步数与超时上限。

**精确位置**

- `src/settings/index.html`：现有六个分区（桌宠/语音/对话/记忆/插件/系统）。
  这些控件该放哪儿是个设计决定——**对话**分区最自然。
- `src/settings/main.js:542` `assistantPatchFromControls()`：产出 `{tts, tapTalk, llm}`，
  要多一个 `agent` 键。
- `src/main/assistant/state.js:298` `mergePatch`：补丁怎么合并（见坑）。

**验收标准**

- 每个控件改完立刻落盘，重启后还在。
- 审批策略切 `manual` 后，写类工具真的开始弹审批气泡（不是只存了个值）。
- 永久放行的列表里加一个工具名后，同名工具不再弹审批。

**坑**

- **`mergePatch` 只深合并一层**。`{agent: {approval: {policy: 'manual'}}}` 这种补丁，
  会把整个 `approval` 对象**换掉**，`allowAlways` 列表**整个丢失**。
  要么补丁里把 `allowAlways` 一起带上，要么改 `mergePatch` 的深度。
- 界面上只写用户看得懂的后果，不写 `agent.dispatch` / `allowAlways` 这种字段名
  （总规格 §10 与计划的 Global Constraints 都这么要求）。
- `maxTokensPerTask` 在 `DEFAULT_AGENT` 里（`src/shared/assistant.js:273`），
  但**代码里没有任何地方消费它**——总规格 §15 把它列为防烧 token 的手段之一。
  做设置界面时顺手确认一下要不要真的接上，别做成一个摆设开关。

---

### 缺口 4 · L4 外部 harness（T13 / T14）

**现象**：`src/main/assistant/` 下**没有任何 harness 相关文件**，
内置工具里也没有 harness 工具（现有 7 个：`fs.read` / `fs.list` / `fs.search` /
`fs.write` / `shell.exec` / `app.launch` / `clipboard.read`，见
`src/main/assistant/agent/tools/builtin.js`）。

**规格要求**（总规格 §9）：一个工具 `harness.run({agent, prompt, cwd, timeout})`；
`child_process` 启动，stdout 按 JSONL 解析成 step 事件**流式**吐给用户；
Windows 上取消必须**杀进程树**；超时/退出码/非零退出 stderr 落进记录；
日志落盘 `userData/agent-logs/<taskId>.log`。

**最关键的一条**：harness 的任务是 agent 循环里的**一个步骤**，但它自己可能跑很久——
所以它必须能**异步地产出事件**，而不是阻塞循环直到结束。实现上：启动子进程后
立即返回「已启动」的 step，后续输出以异步事件的形式注入记录。

**这会撞上一个现成的架构限制**

工具的 ctx **只有 `signal`**（`src/main/assistant/agent/loop.js:351`：
`tool.run(args, { signal })`）。异步事件流需要一条**新的通道**——
要么给 ctx 加一个事件 sink，要么让 harness 自己往 `onEvent` 推。
**这个决定要先做**，再做别的。

**能直接复用的东西**

- `src/main/assistant/agent/tools/builtin.js:146` `killProcessTree(child, {...})`
  —— **已经实现**了 Windows 上的 `taskkill /pid /T /F`（非 win32 走进程组 kill）。
  harness 直接用，别重写一份。
- `src/main/assistant/agent/tools/registry.js` 的 `run(args, ctx)` 契约、
  `TOOL_RISK_FLOOR`（`shell.exec` / `app.launch` 是 exec 底线）也照着用。

**必须先做的事**

规格 §15 明写：**claude code CLI 的确切参数与输出格式不能照抄记忆，
T13 的第一个动作就是跑一次真实的 CLI 看它的输出格式。**

**验收标准**

- 真实 CLI 跑通；JSONL 解析成 step；Windows 上取消能把进程树杀干净；
  超时与日志落盘到 `userData/agent-logs/<taskId>.log`。
- harness 作为工具出现在工具表里；输出以异步事件流的形式成为步骤。

**坑**

- 这是本期最大的一块，**没有现成的计划文档**。做之前建议先按
  `plans/` 的既有格式写一份 L4 实施计划（目标 / 架构 / 文件地图 / 逐步 Step）。
- 别用 `child.kill()` 收尾——Windows 上杀不掉子孙进程。

---

### 缺口 5 · T20 e2e：审批气泡可点

**现象**：`test/e2e/` 下**没有一条** e2e 碰过审批气泡（`grep -rn "approval\|允许\|approve" test/e2e/`
只命中 `visible-area.spec.js` 的一句注释）。

T20 三项里另两项已经有覆盖：

| T20 要求 | 覆盖情况 |
|---|---|
| 聊天记录插件可打开 | ✅ `test/e2e/chat-history.spec.js:451` |
| 双击行为未变 | ✅ `test/e2e/visible-area.spec.js:112`（单击摸头，双击才弹面板） |
| **审批气泡可点** | ❌ 没有 |

**要验的东西**

审批气泡是**独立窗口**（`src/renderer/bubble/index.html`），
按钮在 `src/renderer/bubble/main.js:128–131` 动态生成：

| 按钮 | `data-decision` | 语义 |
|---|---|---|
| 允许 | `allow` | 这一次放行 |
| 拒绝 | `deny` | 这一次不给（错误喂回模型，它换条路） |
| 自动 | `always` | 本任务内同风险的后续操作都放行 |
| 取消任务 | `cancel` | 整个任务停掉 |

**坑**

- **规格 §8.2 的表格只列了三个按钮，实现是四个**（多一个「取消任务」）。
  这是**有意为之的偏差**：规格 §8.2 的正文只解释了「允许/拒绝/自动」的语义不对称，
  第四个按钮是规格正文提到、表格漏掉的。做 e2e 时按**实现的四个**写，
  别照着规格表格只测三个。
- 气泡是独立窗口，测试要用 `app.windows()` 按 URL 找（参考
  `test/e2e/tap-talk.spec.js:145` 的 `findWindow`），不是主窗口里的一个元素。

---

## 三、已知会绊人的地方（一次性列清）

1. **`scope.steer` 有人写、没人用。** `runtime.js:129` 提供的取队列钩子，
   全工程**零调用**。看到 `steerNotes` 就以为功能通了——没有。
2. **`mergePatch`（`src/main/assistant/state.js:298`）只深合并一层。**
   补丁里出现 `agent.approval` 这种嵌套对象会把整个子对象换掉。
3. **`sanitizeAssistant` 的 `agent` 块是逐字段重建的**（`state.js:227–257`）。
   新加的键不在那儿显式列出，清洗时会被丢。
4. **工具 ctx 原来只有 `{ signal }`**，现在多了 `onEvent` 与 `taskId`
   （`loop.js` 的 `tool.run(args, { signal, taskId, onEvent })`）。
   harness 的异步事件流就走 `onEvent`。
5. **`killProcessTree` 已经能杀 Windows 进程树**（`builtin.js:146`），别重写。
6. **`LLM_BACKENDS` 只剩 `state.js` 与两个测试在用**，
   退役时把这几处一起清掉，别留半截。
7. **规格 §8.2 的审批按钮表与实现差一个**，见缺口 5。
8. **`docs/开发说明/README.md:11` 指向 `./Agent能力架构.md`，那个文件不存在。**
   顺手补上或者把链接改掉。

---

## 四、怎么验证

```bash
# 单元测试（当前基线：549 条全过）
node --test "test/unit/**/*.test.js"

# e2e：单跑一个文件
npx playwright test test/e2e/tap-talk.spec.js
npx playwright test test/e2e/two-layer-agent.spec.js
npx playwright test test/e2e/chat-history.spec.js
```

**本机已知会挂的 e2e**（环境问题，与本工程无关——干净树上单跑也挂）：

- `test/e2e/screen-recorder.spec.js` 的几条：多显示器环境。
- 剪贴板相关的：这台机器的剪贴板在 Electron 里不可用。

**动手前先跑一遍基线**，分不清是谁弄坏的时候有个底。

---

## 五、当前工作树的状态（未提交）

分支 `agent`，主分支 `master`。工作树里有 5 个文件没提交，是「双击桌宠不念台词」那次改动：

| 文件 | 状态 | 内容 |
|---|---|---|
| `src/renderer/pet/tapVoiceGate.js` | 新增（未跟踪） | 台词闸门：押后一个双击窗口（550ms）才念，双击来了就作废 |
| `src/renderer/main.js` | 已改 | 接上闸门；`onTap` 押后报告，`onDoubleTap` 先作废 |
| `src/shared/tapVoice.js` | 已改 | 一行注释：`lastVoiceAt` 的含义 |
| `test/unit/tap-voice-gate.test.js` | 新增（未跟踪） | 7 条单测（假时钟） |
| `test/e2e/tap-talk.spec.js` | 已改 | 新增一条 e2e：双击桌宠不念台词 |

**这批改动已验证**：549 单测全过；`tap-talk` / `two-layer-agent` / `chat-history`
三个 e2e 文件 26 条全过。**要不要提交由用户定**，接手时先别动它。

设计取舍（已与用户确认过）：单击的台词**延迟最多 550ms** 才念；
摸头的表情/动作/心情**照旧立刻发生**；`decideTapVoice` 与
`window.__pet.lastTapDecision` 仍**同步**产出（老 e2e 依赖这一点）。

---

## 六、现在的状态

五个缺口（1 steer / 2 派单开关 / 3 设置界面 / 4 外部 harness / 5 审批气泡 e2e）
**全部做完了**。

- 单元测试基线：**592 条全过**（`node --test "test/unit/**/*.test.js"`）。
- e2e：本轮新增 `agent-settings`（3 条）、`harness`（2 条）、`dispatch-mode`、
  `approval-bubble`。本机已知会挂的仍是 `screen-recorder.spec.js` 的那几条
  （多显示器环境，与本工程无关）。

**还没做的收尾**（都不大）：

1. **工作树没提交**。这一轮的 agent 相关改动（10 个已改 + 9 个新增文件）
   全在树里。**要不要提交由用户定**——先别动 `tapVoiceGate` 那批（第五节）。
2. **`docs/开发说明/README.md:11` 指向 `./Agent能力架构.md`，那个文件不存在**
   （第三节第 8 条）。顺手补上或者把链接改掉。
3. ~~设置界面上「一条命令最多跑多久」这个说法现在窄了~~ **已改**：
   现在是「一条命令或一次外部助手最多跑多久」——`harness.run` 与 `shell.exec`
   共用同一个上限（默认走设置里的值）。

