# 桌宠内置 Agent 运行时 · 设计

> 日期：2026-11-07
> 状态：待评审
> 范围：`src/main/assistant/agent/` 新增子系统 + 插件系统两处扩展 + 气泡/面板的界面改动

---

## 1. 背景

桌宠现在会聊天，但只能「一次调用、一段回复」：用户问一句，模型答一句，没有工具、没有多步、没有后台任务。

要做的是给它一个 **agent 形态**：能操作本机设备、能调度外部 harness、能跟插件系统联动；长任务丢后台跑，不阻塞前端。

代码里早为此留了接缝，这次就是把它们填上：

| 已有接缝 | 位置 | 用途 |
|---|---|---|
| `ctx.tools` / `ctx.runTool()` | `src/main/assistant/chat/backend.js` 的 `ChatContext` 注释 | agent 循环的工具表与执行入口 |
| `ctx.onEvent` | 同上 | 中间事件（工具调用、步骤、状态） |
| `DEFAULT_LLM.backend` | `src/shared/assistant.js` | 后端 id 可切换（`'chat'` → `'agent'`） |
| `plain.js` = 「零工具、一步」 | `src/main/assistant/chat/plain.js` | 普通对话是 agent 的退化形态 |
| `surface.broadcast(pluginId, 'data', …)` | `src/main/plugins/surface.js` | 宿主实时推数据给插件页面 |

## 2. 目标与范围

### 2.1 本期要做

1. 内置 agent 循环（多步 + 工具调用），走现有 OpenAI 兼容接口
2. 内置工具集：文件读/写、列目录、搜索、执行命令、启动程序、读剪贴板
3. 插件可**声明工具**给 agent 用；插件也可**反向提交** agent 任务
4. 外部 harness（claude code CLI 等）作为一个工具接入
5. 后台任务运行时：队列、并发上限、取消、状态机
6. 分级审批：只读自动放行，写/执行需确认；策略可切 `auto`
7. 审批气泡（带按钮）、任务完成/失败气泡
8. 聊天记录升级为**分类记录**；「聊天记录」从内置功能改成**真插件**

### 2.2 本期不做

| 不做 | 理由 |
|---|---|
| 多 agent 并行协作、任务 DAG | 「同一时间只跑一个后台任务」已经够用，复杂编排是下一期 |
| 沙箱隔离 | Windows 上做不干净；靠**审批闸门**而不是靠隔离 |
| MCP 协议接入 | 是「能力扩展」的一种实现，但插件机制已经覆盖同样的需求 |
| 语音输入 | 沿用现有文本输入链路（面板输入框） |
| 云同步、账号体系 | 与本机 agent 无关 |
| 任务本体的持久化与恢复 | 正在跑的 shell 子进程本来就死了，假装能恢复是自欺欺人（见 §7.4） |

## 3. 总体架构

```
渲染层
  面板 panel        搜索视图（双击桌宠弹出的那个输入框，行为不变）
                    └ 插件工作台：聊天记录插件的页面（iframe）
  气泡 bubble      普通消息 | 流式回复 | 审批气泡（带按钮）
        │ IPC
主进程
  assistant/chat/backend.js      后端注册表 —— 新增 id:'agent'
  assistant/agent/
    runtime.js      任务运行时：队列 / 并发 / 状态机 / 取消
    loop.js         agent 循环：多步、工具调用、上下文
    prompt.js       agent 系统提示词（人设 + 工具表 + 工作区 + 审批策略）
    approval.js     审批闸门：策略判定 / 等待 / 决议
    harness.js      外部 harness 适配（子进程 / JSONL 解析 / 取消）
    record.js       聊天记录写入（分类）
    tools/
      registry.js   工具表
      builtin.js    内置工具（fs / shell / app / clipboard）
  assistant/llm/openai.js        加 tools 支持（请求体 / 流式 tool_calls 累积）
插件层
  plugins/<id>/plugin.json       加 tools[] 声明
  plugins/<id>/main.js           实例加 tools() 钩子
  plugins/chat-history/          本期新增：聊天记录插件（由内置功能降级而来）
```

### 3.1 两种对话后端

普通对话与 agent 是**同一个契约下的两个实现**，用户可以在设置里切换（`llm.backend`）：

| 后端 | 行为 | 工具 | 步骤 |
|---|---|---|---|
| `chat`（现有 `plain.js`） | 一次调用、一段回复 | 无 | 1 |
| `agent`（本期新增） | 多步循环 | 有 | 最多 `maxSteps` |

`chat` 后端**不删**——它是「不需要工具的普通闲聊」，也是 agent 循环的退化形态，出问题时可以退回去。

## 4. 聊天记录：从 `{role, text}` 到分类记录

### 4.1 现在的形状

`assistant.json` 的 `chat.messages` 里每条是 `{role: 'user'|'assistant', text, at, proactive}`。
`buildChatMessages()`（`assistant/chat/prompt.js`）把它们映射成 `{role, content}` 喂给模型，只取最近 12 条。

**现在的问题**：没法区分「给人看的」和「给模型看的」。agent 引入后，记录里会混进工具调用日志、审批请求、任务状态——这些东西**绝不能**进模型上下文。

### 4.2 新的形状

```js
{ id, at, kind, role, text, meta }
```

`kind` 取值（定义放 `src/shared/assistant.js`，与 `MESSAGE_KIND` 并列）：

| kind | 含义 | role | meta |
|---|---|---|---|
| `user` | 用户输入 | `user` | — |
| `reply` | 桌宠的回复（普通对话结论或 agent 的最终答复） | `assistant` | `{ taskId? }` |
| `task` | 任务状态变化：排队 / 开始 / 完成 / 失败 / 取消 | `assistant` | `{ taskId, status, title }` |
| `step` | 任务中的一次步骤（模型决定、工具调用、工具结果） | `assistant` | `{ taskId, index, tool, args, result, error }` |
| `approval` | 审批请求与用户的选择 | `assistant` | `{ taskId, tool, args, risk, decision }` |

`role` 保留是为了**兼容旧数据**：老记录没有 `kind`，按 `role` 兜底推断（`user` → `user`，其余 → `reply`）。

### 4.3 喂模型的过滤规则（关键）

`buildChatMessages()` 改成**只取 `kind` 为 `user` / `reply` 的条目**。这样：

- 步骤、任务状态、审批记录永远不会挤占模型的上下文
- 「桌宠给用户看的过程」与「模型看得见的对话」从此分开

> 这是本次扩展里最容易做错的一步。漏了这条过滤，工具日志会把对话上下文冲垮，而且症状是「模型突然变笨」而不是报错。

### 4.4 记录条数

一个数组装不下两套限额——`user`/`reply` 要留得久（模型要看），步骤记录增长极快（几步就几条）。
所以 `appendMessage` 改成**按 kind 分路截断**，而不是砍数组尾巴：

| kind | 上限 | 理由 |
|---|---|---|
| `user` / `reply` | 各 40（`MAX_CHAT_MESSAGES` 不变） | 模型上下文只用这两类；40 条足够回忆 |
| `step` | 200 | 一个任务十几步，几个任务就满了 |
| `task` | 100 | 状态变化比步骤少 |
| `approval` | 100 | 同上 |

截断时**每路各自砍自己的尾巴**，不动别的路。总条数没有硬上限（最坏约 440 条，每条约 200 字，磁盘上不到 100 KB，可以接受）。

> 砍数组尾巴的做法在有步骤之后是错的：一条新步骤会把最老的用户输入挤掉，
> 而模型恰恰最需要那几条用户输入。

## 5. 工具系统

### 5.1 工具描述符

所有工具（内置的、插件的）都是同一个形状：

```js
{
  name: 'shell.exec',              // 全局唯一
  label: '执行命令',                // 给人看的
  description: '在 shell 里执行一条命令…',  // 给模型看的
  parameters: {                     // JSON Schema（OpenAI tools 格式）
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的命令' } },
    required: ['command'],
  },
  risk: 'read' | 'write' | 'exec', // 决定审批策略
  run(args, ctx) → Promise<{ text: string, data?: any }>,
}
```

`run` 的返回值统一是 `{ text, data }`：`text` 是**给模型看的**结果摘要（会被截断后进上下文），`data` 是给插件/界面看的结构化数据（不进上下文）。

### 5.2 风险等级

| risk | 含义 | 默认策略（`graded`） |
|---|---|---|
| `read` | 只读：读文件、列目录、搜索、读剪贴板、查状态 | **自动放行** |
| `write` | 写入：写文件、改配置 | 需确认 |
| `exec` | 执行：跑命令、启动程序、启动外部进程 | 需确认 |

风险等级是**工具自己声明的**，但宿主取「声明值」与「当前策略」的**更严格者**。插件不能通过声明 `read` 来绕过检查——宿主对**已知危险工具名**（`shell.exec`、`fs.write` 等）有硬编码的下限。

### 5.3 内置工具（第一批）

| name | risk | 说明 |
|---|---|---|
| `fs.read` | read | 读文件（带行范围） |
| `fs.list` | read | 列目录 |
| `fs.search` | read | 在目录里搜字符串（grep） |
| `fs.write` | write | 写文件 |
| `shell.exec` | exec | 执行一条命令 |
| `app.launch` | exec | 启动本机程序（复用 `src/main/apps.js`） |
| `clipboard.read` | read | 读剪贴板（复用 `assistant/clipboard.js`） |

`shell.exec` 的工作目录默认是设置里的「工作区」，**不设则用用户主目录**。

> **2026-11-08 变更**：原设计要求「所有路径参数都要归一化后检查是否逃出工作区，
> 检查只在 `risk: 'read'` 的内置工具上强制」。**这条已撤销**——
> 用户要求 agent 能访问工作区之外的目录（素材在别的盘符上），
> 于是内置工具一律不设目录边界：相对路径按工作区解析，绝对路径原样给。
> 收紧改由审批策略（`approval.policy`）负责，审批气泡上线后生效。

### 5.4 插件提供的工具

清单加 `tools[]`：

```json
{
  "id": "weather",
  "name": "天气",
  "tools": [
    {
      "name": "weather.get",
      "label": "查天气",
      "description": "按城市名查当前天气与未来三天预报",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string", "description": "城市名" } },
        "required": ["city"]
      },
      "risk": "read"
    }
  ]
}
```

插件实例加 `tools()` 钩子，返回与清单**同名**的实现：

```js
export default function createWeatherPlugin(ctx) {
  return {
    // …
    tools() {
      return [{
        name: 'weather.get',
        run: async ({ city }) => ({ text: '北京 晴 26℃', data: { city, temp: 26 } }),
      }];
    },
  };
}
```

**渐进式加载是天然的**：agent 的系统提示词里**只列当前启用的插件提供的工具**。插件没开、没声明工具，那它就不在提示词里——模型看不见它，也就不会去调它。

**清单与实现不一致时的处理**：清单里声明了但 `tools()` 没返回同名实现 → 该工具**不注册**，并在宿主日志里记一行（与「目录名 ≠ 清单 id 就被静默跳过」同样的宽容度：插件作者能继续跑，只是这个工具没了）。

反过来，`tools()` 返回了清单里没声明的工具 → **不注册**（清单是契约，两边必须一致）。

### 5.5 插件反向调用 agent

插件的 `ctx` 上新增 `ctx.agent`：

```js
ctx.agent = {
  run(prompt, opts) → taskId,       // 提交一个后台任务
  cancel(taskId) → ok,
  history() → ChatEntry[],            // 读聊天记录
  onEvent(cb) → unsubscribe,          // 订阅 agent 事件
}
```

插件跑在主进程里，与 agent 运行时同处一个进程，所以这是**直接调用**，不需要 IPC。

## 6. agent 循环

### 6.1 骨架

```
组 system prompt（人设 + 工具表 + 工作区 + 审批策略 + 输出契约）
messages = 历史（只取 user/reply）+ 用户这一句
循环（最多 maxSteps 步）：
  1. 调模型（流式）
  2. 没有 tool_calls → 这就是最终回复 → 落记录 → 结束
  3. 有 tool_calls → 逐个处理：
     a. 查工具表；查不到 → 立刻回一条错误给模型（让模型自己纠正）
     b. 查审批闸门 → 需要审批 → 发审批气泡 → 等用户决议
     c. 执行工具 → 结果整理成 { text, data }
     d. 结果作为 role:'tool' 消息追加进 messages
  4. 继续循环
```

**工具报错不终止任务**：错误信息喂回模型，模型可以换条路。只有「模型连续报错」或「步数用尽」才终止，并把原因落进记录。

### 6.2 LLM 客户端要加的东西

`src/main/assistant/llm/openai.js` 现在只做纯对话，要加三样：

1. **请求体带 `tools`**：OpenAI 兼容格式的 `[{type:'function', function:{name, description, parameters}}]`
2. **能发 `role: 'tool'` 的消息**：`{role:'tool', tool_call_id, content}`
3. **能读 `tool_calls`**：

> **最大的坑：流式下的 `tool_calls` 是分片的。**
> `choices[].delta.tool_calls[]` 里的 `function.arguments` 是一段被网络切碎的 JSON 字符串，
> 按 `index` 到达，**必须按 index 累积成一整段再 JSON.parse**。
> 每帧单独 parse 必然失败；按到达顺序拼接而不看 index 也必然错位
> （一轮里多个并行 tool call 会交错到达）。
> 非流式响应没有这个问题，但两条路径都要支持。

现有的错误分类（`LLM_ERRORS`）够用，不扩。

## 7. 后台任务运行时

### 7.1 状态机

```
queued ──► running ──► done
   │          │  │
   │          │  ├──► waiting_approval ──► running
   │          │  └──► failed
   │          └─────► cancelled
   └───────────────► cancelled
```

### 7.2 队列与并发

- **FIFO 队列**，`maxConcurrent` 可配（默认 1）。用户说「最大任务数量可配置」——这是它。
- 超出上限**排队，不拒绝**。排队时在气泡里告诉用户「排第 N 位」。
- **等待审批不占并发槽**：用户可能几分钟不回，槽位应该让给别的任务。

### 7.3 打断语义

任务运行中用户又发了一句话 → **当作新任务排队**，并在气泡里说明「上一个还在跑，这个排后面」。

**不做隐式打断**：正在跑的 shell 命令被悄悄杀掉，事后极难排查。需要停就显式停（记录里/气泡上给「取消」动作）。

### 7.4 重启后的中断

任务本体**不持久化**，只持久化聊天记录。应用重启后：

- 运行中的任务 → 在记录里标为「已中断」
- 不尝试恢复 shell 子进程（它已经死了）

## 8. 审批

### 8.1 策略

三档，存 `assistant.json` 的 `agent.approval.policy`：

| policy | 行为 |
|---|---|
| `auto` | 全部放行（界面上要明确警示：一次注入就能在你机器上执行命令） |
| `graded`（默认） | `read` 自动放行；`write` / `exec` 需确认 |
| `manual` | 全部需确认 |

外加「永久放行列表」`allowAlways: ['fs.read', 'weather.get']`——用户信任某个工具后可以单独放行。

### 8.2 审批气泡

气泡新增 **sticky 形态**：不自动消失，一直挂着等用户点。

| 按钮 | 语义 |
|---|---|
| **允许** | 本次放行这一次调用 |
| **拒绝** | 本次拒绝，**把错误喂回模型**——模型可以换条路，而不是整个任务死掉 |
| **自动** | 本任务内，后续同风险等级的操作全部自动放行（任务级策略升级为 `auto`） |

三个按钮的语义不对称是有意的：「拒绝」是**给模型一个否定的信号**（"这个不能做"），不是终止任务。

**用户不在场怎么办**：审批气泡挂在桌宠旁边，桌宠要有明显表现（「有件事等你」的表情/动作），否则用户根本不知道有个任务卡住了。任务在 `waiting_approval` 状态会一直等，不设超时——超时自动放行是不安全的。

### 8.3 气泡的 sticky 形态要怎么加

`src/main/bubble.js` 的 `scheduleHide(ttlMs)` 里，`ttlMs: 0` 会**退回默认 TTL**（不是「不消失」）。所以要新加一个明确的 sticky 标志，不能靠 `ttlMs: 0` 表达。

`src/preload/bubble.cjs` 加 `onApproval(cb)` / `respondApproval({id, decision})`；`bubble/index.html` 加按钮行。

## 9. 外部 harness

外部 harness（claude code CLI 等）实现成**一个工具**：`harness.run({agent, prompt, cwd, timeout})`。

- 用 `child_process` 启动，stdout 按 JSONL 解析成 step 事件流式吐给用户
- **Windows 上取消必须杀进程树**：`child.kill()` 杀不掉子孙进程，要走 `taskkill /T /F`
- 超时、退出码、非零退出的 stderr 都要落进记录
- 日志落盘 `userData/agent-logs/<taskId>.log`
- 「查询/监控」：harness 的任务是 agent 循环里的**一个步骤**，但它自己可能跑很久——所以它必须能**异步地产出事件**，而不是阻塞循环直到结束。实现上：启动子进程后立即返回「已启动」的 step，后续输出以异步事件的形式注入记录。

> claude code CLI 的确切参数（`--print --output-format stream-json` 之类）**必须实测确认**，不能照抄记忆。T13 的第一个动作就是跑一次真实的 CLI 看它的输出格式。

## 10. 界面

### 10.1 聊天记录：从内置功能改成插件

**现状**：「聊天记录」是面板搜索里的一个**内置功能**（`src/main/builtins.js` 的 `BUILTIN_HISTORY = 'history'`），
用声明式积木 `messagesBlock` 画，只能显示 `{role, text, at, proactive}`。

**改成**：`plugins/chat-history/`

```
plugins/chat-history/
  plugin.json          id 必须等于目录名
  main.js              data() 给首份快照；订阅 agent 事件 → ctx.push()
  pages/
    history.html       页面外壳
    history.js         bindSurface() + 分类渲染
```

**清单**：

```json
{
  "id": "chat-history",
  "name": "聊天记录",
  "icon": "📜",
  "description": "和桌宠说过的话，还有它做过的事",
  "keywords": ["history", "chat", "record", "duihua", "liaotian", "jl", "聊天", "记录", "对话", "记忆", "任务"],
  "window": { "page": "pages/history.html", "width": 520, "height": 640 }
}
```

**为什么值得这么改**：agent 之后记录要**分类展示**（用户输入 / 桌宠回复 / 任务状态 / 步骤 / 审批），
声明式积木表达不了；而且它要**实时更新**、要能**分离成独立窗口**、变小部件。
做成插件后这些能力是白送的。

**连带改动**：

| 位置 | 改动 |
|---|---|
| `src/main/builtins.js` | 撤掉 `BUILTIN_HISTORY` 与它的 `builtinPage`/`builtinAction` 分支；只留「设置」 |
| `src/main/panel.js` | `isBuiltin()` 分支只剩 `settings`；插件清单 `[...builtinFeatures(), ...plugins.list()]` 的形状不变 |
| `test/unit/builtins.test.js` | 相应调整 |
| `src/shared/panel.js` | `messagesBlock` **保留**（仍是插件可用的积木），只是聊天记录插件不用它 |

插件化之后，「聊天记录」在搜索结果里的**位置和用法跟现在完全一样**——双击桌宠 → 面板 → 搜「聊天」→ 打开。
差别是它现在能分离成独立窗口（↗）、能变小部件（▣）、能实时刷新。

### 10.2 插件侧的实时推送

宿主要给插件一个推数据的口子：

```js
ctx.push(data)   // → surfaces.broadcast(pluginId, 'data', data)
```

这条通道**已经存在**（`surface.js` 的 `broadcast` → `plugin:data` / `panel:surface:data` → 页面侧 `onData`），
只是从来没给插件用过（目前只有 `tick` 定时器在用它）。补上 `ctx.push` 即可，**不用改插件桥的协议**。

聊天记录插件的 `main.js`：

```js
export default function createChatHistory(ctx) {
  const off = ctx.assistant.agent.onEvent((entry) => ctx.push(entry));
  return {
    data: () => ({ entries: ctx.assistant.agent.history() }),
    // …
  };
}
```

页面侧用 `bindSurface()` 收：首份用 `surface.data()`，后续用 `surface.onData(cb)`。

### 10.3 双击行为不变

**明确不改**：双击桌宠 → 弹面板 → 顶部输入框既能搜插件/程序、也能聊天。搜索结果里「和桌宠聊天」这一项照旧。

### 10.4 记录视图长什么样

页面按 kind 分区，五种 kind 视觉区分：

```
┌──────────────────────────────────┐
│ 💬 桌宠                          │
│  在呢～帮我看看这个项目结构       │
├──────────────────────────────────┤
│ ⚙ 任务 · 整理项目结构            │
│  ▸ 1. fs.list  src/              │
│  ▸ 2. fs.read  src/main.js       │
│  ▸ 3. shell.exec  ls -la         │
├──────────────────────────────────┤
│ 🔒 审批 · shell.exec             │
│  运行 `npm test`？              │
│  [允许] [拒绝] [自动]            │
└──────────────────────────────────┘
```

步骤可折叠（点标题展开/收起），任务状态变化用一行一条（排队 → 开始 → 完成）。

## 11. 持久化

`assistant.json` 扩展：

```js
llm.backend: 'chat' | 'agent'      // 已有字段，取值多一个

agent: {
  maxConcurrent: 1,                // 同时跑几个后台任务
  maxSteps: 20,                    // 一个任务最多走几步
  workspace: '',                   // 工作目录（空 = 用户主目录）
  timeoutMs: 120000,               // 单个工具调用的超时
  maxTokensPerTask: 0,             // 单任务 token 上限（0 = 不限）
  approval: {
    policy: 'graded',              // auto | graded | manual
    allowAlways: [],               // 永久放行的工具名
  },
}
```

`chat.messages` 按 §4.2 扩展。

## 12. 错误处理与降级

| 情况 | 处理 |
|---|---|
| 模型返回了没有的 tool name | 回一条错误消息给模型（「没有这个工具」），让它自己纠正；不终止任务 |
| 工具执行失败 | 错误喂回模型；连续 3 次同类错误 → 终止任务并说明原因 |
| 工具超时 | 同上（当成一次工具失败） |
| 步骤用尽 | 终止任务，落一条「步数用尽」的记录，用当前上下文让模型给个总结 |
| 模型接口报错（401/429/5xx） | 沿用 `LLM_ERRORS` 分类；任务失败并把错误分类落进记录；429 要退避 |
| 审批长时间没人管 | 任务一直挂 `waiting_approval`，不超时放行；桌宠持续提示 |
| 应用退出 | `runtime.stop()` 取消所有任务、杀掉所有子进程 |
| 插件的工具实现抛异常 | 捕获成工具错误，不让插件的异常掀翻 agent 循环 |
| 后端是 `agent` 但模型不支持 tools | 检测到 `bad_request` 且请求里带了 tools → 提示「这个模型不支持工具调用」并建议切回 `chat` 后端 |

## 13. 测试策略

### 13.1 单元测试（`node --test`）

| 测试 | 覆盖 |
|---|---|
| `agent-tools.test.js` | 工具注册表：注册 / 查找 / 未知名 / 清单与实现不一致 |
| `agent-approval.test.js` | 策略判定（`auto`/`graded`/`manual`）、永久放行、拒绝的语义 |
| `agent-loop.test.js` | 多步循环：假 LLM 驱动「调工具 → 拿结果 → 再调 → 出结论」；工具报错后换路；步数上限 |
| `agent-tools-stream.test.js` | **流式 `tool_calls` 累积器**：分片 arguments、多并行 tool call 交错到达 |
| `agent-runtime.test.js` | 队列 FIFO、并发上限、等待审批不占槽、取消 |
| `agent-record.test.js` | 分类记录的写入与截断；**只有 `user`/`reply` 进模型上下文**（喂模型的过滤规则） |
| `chat-history-plugin.test.js` | 插件清单合法、目录名 == id、首份数据与事件推送 |

### 13.2 e2e（playwright）

- 双击桌宠 → 面板打开 → 搜「聊天」→ 打开聊天记录插件 → 看到分类记录
- 触发一个需要审批的工具 → 审批气泡出现 → 点「允许」→ 任务继续 → 完成气泡
- 面板里的「和桌宠聊天」项仍能正常发送（双击行为未变）

## 14. 任务拆分

按架构分层，编号即执行顺序（同层可并行）。

### L0 · 地基

| # | 任务 | 涉及 | 依赖 | 验收 |
|---|---|---|---|---|
| T0 | **前置探针：实测 MiniMax 的 tool calling 稳定性** | 一次性脚本，不进仓库 | — | 能稳定产生合法的 `tool_calls`（含分片累积）；不稳则回头改方案（见 §15） |
| T1 | 消息分类扩展 | `shared/assistant.js`、`assistant/chat/memory.js`、`assistant/chat/prompt.js`、`assistant/index.js`（`chatHistoryView`） | — | 记录能存 kind；**喂模型只取 `user`/`reply`**；旧数据按 role 兜底；**截断按 kind 分路**（§4.4） |
| T2 | LLM 客户端支持 tools | `assistant/llm/openai.js` | T0 | 请求带 `tools`；能发 `role:'tool'`；流式 `tool_calls` 正确累积 |

### L1 · 工具系统

| # | 任务 | 涉及 | 依赖 | 验收 |
|---|---|---|---|---|
| T3 | 工具描述符与注册表 | `agent/tools/registry.js` | T2 | 注册 / 查找 / 未知工具；风险等级取严格者 |
| T4 | 内置工具集 | `agent/tools/builtin.js`、`src/main/apps.js`、`assistant/clipboard.js` | T3 | 六个工具可用；路径不设目录边界（见 §5.3 的变更说明） |
| T5 | 插件提供工具 | `shared/plugin.js`（清单加 `tools[]`）、`plugins/host.js`（收集注册）、插件实例 `tools()` 钩子 | T3 | 插件声明的工具进 agent 工具表；清单/实现不一致时不注册 |
| T6 | 插件反向调用 agent | `plugins/host.js`（`ctx.agent`） | T9 | 插件能提交/取消任务、能订阅事件 |

### L2 · agent 循环

| # | 任务 | 涉及 | 依赖 | 验收 |
|---|---|---|---|---|
| T7 | agent 后端 | `assistant/chat/agent.js`、`assistant/index.js`（后端注册）、`shared/assistant.js`（`llm.backend` 取值） | T2、T4 | `llm.backend='agent'` 时走多步循环 |
| T8 | 系统提示词与上下文管理 | `agent/prompt.js` | T3、T7 | 提示词含工具表/工作区/审批策略；上下文压缩不超限 |

### L3 · 运行时

| # | 任务 | 涉及 | 依赖 | 验收 |
|---|---|---|---|---|
| T9 | 任务运行时 | `agent/runtime.js` | T7 | 队列 FIFO、并发上限、等待审批不占槽、取消、重启标中断 |
| T10 | 审批闸门 | `agent/approval.js` | T9 | 三档策略、永久放行、拒绝喂回模型 |
| T11 | 审批气泡 | `preload/bubble.cjs`、`renderer/bubble/index.html`、`renderer/bubble/main.js`、`main/bubble.js`（sticky 形态） | T10 | 气泡带三个按钮；不自动消失；决议回传 |
| T12 | 任务完成/失败通知 | `main/bubble.js`、`agent/record.js` | T9 | 完成/失败都有气泡 |

### L4 · 外部 harness

| # | 任务 | 涉及 | 依赖 | 验收 |
|---|---|---|---|---|
| T13 | harness 适配器 | `agent/harness.js` | T9 | 真实 CLI 跑通；JSONL 解析；**Windows 杀进程树**；超时与日志落盘 |
| T14 | harness 接入 | `agent/tools/builtin.js`（harness 工具）、`agent/runtime.js` | T13 | 作为工具出现在工具表；输出异步流成步骤 |

### L5 · 界面

| # | 任务 | 涉及 | 依赖 | 验收 |
|---|---|---|---|---|
| T15 | 宿主给插件加 `ctx.push` | `plugins/host.js`、`plugins/surface.js` | T9 | 插件能实时收到推来的数据 |
| T16 | **聊天记录插件化** | 新增 `plugins/chat-history/`（清单 / `main.js` / `pages/`）、`main/builtins.js`（撤掉 `BUILTIN_HISTORY`）、`main/panel.js`、`test/unit/builtins.test.js` | T1、T15 | 插件出现在搜索结果里，位置用法与现在的内置项一致；内置项只剩「设置」 |
| T17 | 记录分类渲染 | `plugins/chat-history/pages/history.js` | T16 | 五种 kind 分区显示；步骤可折叠；能实时追加 |

### L6 · 收尾

| # | 任务 | 涉及 | 依赖 | 验收 |
|---|---|---|---|---|
| T18 | 设置界面 | `settings/index.html`、`settings/main.js`、`shared/assistant.js`、`assistant/state.js` | T7、T9、T10 | 可选后端、并发数、审批策略、永久放行列表、工作区、步数/超时上限 |
| T19 | 文档 | `docs/开发说明/插件开发指南.md`（加「插件给 agent 提供工具」一节）、`docs/开发说明/插件系统架构.md` | T5、T6 | 插件作者能照着写出工具 |
| T20 | e2e 覆盖 | `test/e2e/` | T11、T16 | 聊天记录插件可打开；审批气泡可点；双击行为未变 |

**依赖图（关键路径）**：

```
T0 → T2 → T3 → T4 ─┐
              T5 ───┤
              T7 ←──┘ → T9 → T10 → T11
                        ├→ T12
                        ├→ T13 → T14
                        └→ T15 → T16 → T17
```

## 15. 风险与未决

| 风险 | 影响 | 应对 |
|---|---|---|
| **MiniMax 的 tool calling 不稳** | agent 循环建在沙上 | **T0 前置探针**先做。若工具调用格式不稳定，加解析容错；若彻底不行，本期「只用 OpenAI 兼容接口」这个前提要重新谈（改走 Anthropic 原生协议） |
| shell 权限太大 | 一次 prompt injection 就能在用户机器上执行命令 | 分级审批是硬闸门；`auto` 档在界面上明确警示；内置工具的 risk 有宿主侧下限，插件不能自报 `read` 蒙混 |
| 循环烧 token | 账单失控 | `maxSteps` + `maxTokensPerTask` + 单工具超时 |
| claude code CLI 的参数/输出格式记错 | harness 接不上 | T13 第一个动作就是跑真实 CLI 看输出，不照抄记忆 |
| Windows 杀不掉子进程树 | harness 取消不掉 | `taskkill /T /F` |
| 插件无沙箱，插件能自己造工具 | 恶意插件可提供危险工具 | 工具 risk 由插件声明但有**宿主侧下限**；插件本身已经是无沙箱的既成事实（见 `docs/开发说明/插件开发指南.md`），本期不扩大这个洞 |

### 未决（本期按默认处理，需要时再调）

| 问题 | 本期默认 |
|---|---|
| 用户在 agent 模式下说的话，是每句都开一个任务，还是先判断需不需要？ | 每句都开一个任务；不需要工具的任务会在第一步就结束（模型不产生 tool_calls） |
| `chat` 与 `agent` 后端要不要自动路由？ | 不自动路由，用户在设置里显式选 |
| 审批气泡在桌宠被隐藏时怎么办？ | 桌宠隐藏时气泡照常显示（气泡是独立窗口），但桌宠的「等你」表情看不见——所以记录里必须有审批项，用户从聊天记录里能看到还卡着 |
