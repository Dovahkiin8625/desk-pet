# 聊天记录页面分层重设计 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把聊天记录页面从一条平铺的时间流，改成按「一次发话」分块、块内分「桌宠这边 / 后台那边」两段、三级折叠的查阅视图；顺带把交互层这一回合的过程（模型每轮说了什么、快工具调用、派单的交底原文、后台完成时桌宠说的话）记进记录。

**Architecture:** 三段推进——① **两层接线**（前台恒定走交互层、后台走执行层，照已有的双层 agent 计划做）→ ② **补记**（新增 `model` 记录分类；loop 把每轮的模型正文交出来；交互层写记录；派单记录带上交底；完成的答复带上任务号）→ ③ **页面**（新增 `turns.js` 纯函数做归属与分组，`history.js` 照着画，块/段/明细三层折叠）。

**Tech Stack:** Electron 主进程 + 普通 Node 模块（`node --test` 单元测试）+ Playwright e2e；无新增依赖；样式沿用 `src/renderer/ui/theme.css` 的 `--dp-*` 变量。

**Spec:** `docs/superpowers/specs/2026-11-08-chat-history-turns-design.md`（设计规格，与这份计划一起读）

---

## Global Constraints

- **注释与文档用中文。** 每个新文件开头一段块注释，说明「这是什么」和**「为什么这么写」**；反直觉的设计尤其要写清楚。
- **提交信息用中文 + 约定式前缀**：`feat(助手): …` / `fix(助手): …` / `feat(聊天记录): …` / `docs(聊天记录): …` / `test(聊天记录): …`。
- **UI 界面上不出现代码逻辑的说明。** 页面上只写用户看得懂的话——不写 `kind: task`、`taskId`、`layer` 这种字段名，也不写「这段是交互层」。
- **单元测试不引 electron。** `src/main/assistant/`、`src/shared/`、`plugins/chat-history/pages/` 里的纯逻辑都要能在普通 node 里跑。
- **契约只有一份。** 「有哪些记录分类」「每个分类进不进模型上下文」「任务的状态有哪些」都放在 `src/shared/assistant.js`，主进程与渲染层都从那儿取。
- **不新增依赖。** 用现成的 `node:test` 与 `@playwright/test`。
- **不重构与本计划无关的代码。** 每一处改动都要能指回规格的某一条。
- **页面上不出现代码逻辑的解释。** 「桌宠这边」「后台那边」「交底」「结果」——这些是给人看的话；`dispatch` / `step` / `model` 这些不是。

## Review Focus

规格没有穷举、但最容易咬人的五个输入/状况。每一条都落到下面某个任务的测试里。

1. **后台任务在用户发话之后很久才完成**——结果必须回到**发起它的那一块**，不能漂到"完成那一刻"的块里（用户是按"我那句话说的事"找结果的）。→ Task 8「后台任务晚完成：结果回到发起它的那一块」。
2. **用户在任务跑着的时候又说话**——两轮的记录不能串；后来那句"停掉它"派生的 `dispatch` 要留在**它自己那一轮**，任务本体仍归第一轮。→ Task 8「同一个任务号有多条派单：任务归最早那一轮，后来的动作留在自己那一轮」。
3. **老记录没有派单记录**（接线完成前写的）——任务要**自己成一块**，不能整块消失，也不能挂到不相干的一轮里。→ Task 8「找不到派单的任务：自己成一块」。
4. **`user` 记录被 40 条上限砍掉之后**，`model` / `dispatch` 变成孤儿——要成块，不能变成没有标题的碎片，也不能丢。→ Task 8「没有锚点的记录：自己成一块，不丢」。
5. **页面开着时新记录实时进来**——用户手动展开的东西不能被收起（重画会丢展开状态）。→ Task 9「实时更新：用户展开的东西不收起来」。

---

## 文件地图

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/main/assistant/layer/foreground.js` | 建 | 跑一轮前台对话；模型不认 `tools` 时退回普通对话 |
| `src/main/assistant/index.js` | 改 | 注册交互层、前台恒定走它、写记录的唯一入口 `appendChatRecord` |
| `src/main/assistant/agent/tasks.js` | 改 | `notify` 的载荷带上 `taskId`；去掉 `foreground`；取消的任务不通知 |
| `src/main/assistant/agent/loop.js` | 改 | 多交一个 `onRound` 回调，把每轮的模型正文交出来 |
| `src/main/assistant/agent/record.js` | 改 | 新增 `modelRecord`；`dispatchRecord` 带交底；`stepRecord` 带 `layer` |
| `src/main/assistant/layer/interaction.js` | 改 | 把交互层这一回合的过程写成记录 |
| `src/main/assistant/layer/taskTools.js` | 改 | 派单记录带上交底原文 |
| `src/shared/assistant.js` | 改 | 新增 `model` 分类与它的条数上限 |
| `src/settings/index.html`、`src/settings/main.js` | 改 | 撤掉「对话后端」下拉（前台不再有得选） |
| `plugins/chat-history/pages/turns.js` | 建 | 归属算法：一次发话归一块、按天分组、徽标 |
| `plugins/chat-history/pages/history.js` | 改 | 照 `turns.js` 的结果画三层折叠 |
| `plugins/chat-history/pages/history.html` | 改 | 三层折叠的样式 |
| `plugins/chat-history/pages/groups.js` | 删 | 被 `turns.js` 取代 |
| `test/unit/agent-two-layers.test.js` | 建 | 两层接线 |
| `test/unit/chat-history-turns.test.js` | 建 | 归属算法 |
| `test/unit/chat-history-view.test.js` | 删 | 测的是 `groups.js`，被 `chat-history-turns.test.js` 取代 |
| `test/e2e/backend-select.spec.js` | 删 | 测的是被撤掉的下拉框 |
| `test/e2e/chat-history.spec.js` | 改 | 页面结构、交底、归属、实时更新 |

---

### Task 1: 两层接线（前台走交互层）

**Files:**
- Create: `src/main/assistant/layer/foreground.js`
- Modify: `src/main/assistant/index.js`（注册交互层、删掉 `agent` 后端、`runChat` 改三处）
- Modify: `src/main/assistant/agent/tasks.js`（去掉 `foreground`；被取消的任务不通知）
- Test: `test/unit/agent-two-layers.test.js`、`test/e2e/two-layer-agent.spec.js`

**Interfaces:**
- Consumes: `createInteractionBackend` / `INTERACTION_MAX_STEPS`（`src/main/assistant/layer/interaction.js`）、`createTaskTools`（`src/main/assistant/layer/taskTools.js`）、`isToolsUnsupportedError`（`src/main/assistant/chat/agent.js`）
- Produces:
  - `src/main/assistant/layer/foreground.js`：`export async function runForeground({ interaction, plain, ctx, onFallback = null })` → 返回与 `interaction.chat(ctx)` 同形状的结果（`{ text, emotion, mood, memories, baseUrl, steps, outcome }`）
  - `src/main/assistant/index.js`：`backends.register('interaction', interactionBackend)`；`runChat` 里 `const backend = backends.get('interaction')`；**`backends.register('agent', …)` 整段删除**；上下文按 `layer: LAYER.INTERACTION` 过滤
  - `src/main/assistant/index.js`：具名函数 `appendChatRecord(entry)` —— 写聊天记录的**唯一入口**（中枢的事件记录、任务管理工具的派单记录、前台的答复都走它）
  - `src/main/assistant/agent/tasks.js`：`submit()` 不再接受 `foreground` 参数；被取消的任务**不**通知用户

**这一步为什么在前面**：不接线的话前台不走交互层，`model` 记录一条都不会有，页面上的「桌宠这边」永远是空的。

- [ ] **Step 1: 执行双层 agent 计划的 Task 4**

  打开 `docs/superpowers/plans/2026-11-08-two-layer-agent.md`，**从「## Task 4: 两层接线（前台交互层、后台执行层）」照着做完它的每一个 Step**（Step 1 到 Step 10）。

  那份计划里的代码是现成的，不要重写。它已经包含：`foreground.js` 的实现、交互层的注册、`runChat` 的三处改动（后端固定成 `interaction`、上下文按交互层过滤、调 `runForeground`）、中枢去掉 `foreground`、被取消的任务不通知、`agent` 后端的删除。

  做完它自己的 Step 7（跑单元测试，确认全绿）与 Step 9（跑 e2e）。

- [ ] **Step 2: 确认 `appendChatRecord` 是唯一入口**

  `src/main/assistant/index.js` 里现在有两处能写记录：一处是 `createAgentTasks({...})` 里的内联箭头函数，另一处是任务管理工具传的 `appendRecord: appendChatRecord`。

  确认内联那处**已经换成**具名的 `appendChatRecord`——**不要留两份**。两份都能用的话，下一个改这里的人会不知道该改哪一个。

- [ ] **Step 3: 跑单元测试，确认全绿**

  Run: `node --test test/unit/`
  Expected: 全部 PASS。

- [ ] **Step 4: 提交**

  ```bash
  git add src/main/assistant/layer/foreground.js src/main/assistant/index.js src/main/assistant/agent/tasks.js test/unit/agent-two-layers.test.js test/e2e/two-layer-agent.spec.js
  git commit -m "feat(助手): 两层接线——前台走交互层，后台走执行层"
  ```

---

### Task 2: 完成的答复带上任务号

**Files:**
- Modify: `src/main/assistant/agent/tasks.js`（`notify` 的载荷带上 `taskId`）
- Modify: `src/main/assistant/index.js`（`notify` 回调写记录时带上 `meta`）
- Test: `test/unit/agent-tasks.test.js`

**Interfaces:**
- Consumes: Task 1 的 `appendChatRecord(entry)`
- Produces: `notify({ title, text, ok, taskId })` —— 载荷里**多了 `taskId`**；完成的 `reply` 记录形状是 `{ role: 'assistant', text, at, proactive: false, meta: { taskId, layer: 'execution' } }`

**为什么**：页面要能把后台的结果**归回发起它的那一块**——唯一的钥匙就是任务号。现在完成的记录里没有它（Task 1 写的那条只有 `role`/`text`/`at`/`proactive`），页面无从归起。

- [ ] **Step 1: 写失败的测试**

  在 `test/unit/agent-tasks.test.js` 里加：

  ```js
  test('任务做完了：通知里带着任务号', async () => {
    const seen = [];
    const tasks = createAgentTasks({
      backend: { chat: async () => ({ text: '干完了' }) },
      getMessages: () => [],
      appendRecord: () => {},
      notify: (payload) => seen.push(payload),
      now: () => 1,
    });
    const res = await tasks.submit({ prompt: '查视频', title: '查视频', config: {} });
    await res.done;
    assert.equal(seen.length, 1);
    assert.equal(seen[0].taskId, res.taskId);
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test test/unit/agent-tasks.test.js`
  Expected: FAIL —— `seen[0].taskId` 是 `undefined`。

- [ ] **Step 3: 让中枢把任务号带进通知**

  `src/main/assistant/agent/tasks.js`：成功与失败两处 `notify({...})` 都加上 `taskId: job.taskId`。

- [ ] **Step 4: 让主进程把任务号写进记录**

  `src/main/assistant/index.js` 的 `notify` 回调：

  ```js
    notify: ({ text, ok, taskId }) => {
      // 完成通知也是**桌宠说的话**：记成 reply，
      // 交互层下一轮要记得「刚才那件事做完了」（规格 §7.3）。
      // **带上任务号**：页面要靠它把结果归回发起它的那一块。
      appendChatRecord({
        role: 'assistant',
        text: String(text || ''),
        at: Date.now(),
        proactive: false,
        meta: { taskId: String(taskId || ''), layer: 'execution' },
      });
      // **不带 interrupt**：用户正在说话或正在做决定时，完成通知要排队，
      // 不能把气泡顶掉（规格 §5.3）。
      say(text, { emotion: ok ? 'happy' : 'sad', sound: ok ? 'success' : '' });
    },
  ```

- [ ] **Step 5: 跑测试，确认全绿**

  Run: `node --test test/unit/agent-tasks.test.js`
  Expected: PASS。

- [ ] **Step 6: 提交**

  ```bash
  git add src/main/assistant/agent/tasks.js src/main/assistant/index.js test/unit/agent-tasks.test.js
  git commit -m "feat(助手): 完成的答复带上任务号——页面靠它归回原来那一块"
  ```

---

### Task 3: 撤掉「对话后端」下拉

**Files:**
- Modify: `src/settings/index.html`（删掉 `#llmBackend` 那一块）
- Modify: `src/settings/main.js`（删掉 `llmBackendSelect` / `llmBackendHint` 的引用与填充逻辑）
- Delete: `test/e2e/backend-select.spec.js`
- Test: `test/e2e/settings-sections.spec.js`

**Interfaces:**
- Consumes: 无
- Produces: 设置窗口里不再有「对话后端」下拉；`src/shared/assistant.js` 的 `LLM_BACKENDS` / `llmBackendInfo` **留着不动**（迁移那一步再清，本计划不碰 shared 的这两块）

**为什么**：Task 1 之后前台恒定走交互层，这个下拉选了也没用——留着就是一个骗人的控件。

- [ ] **Step 1: 写失败的测试**

  在 `test/e2e/settings-sections.spec.js` 里加一条：打开设置窗口，**页面里不该再有 `#llmBackend`**。

  ```js
  test('设置里没有「对话后端」下拉了', async () => {
    const { app, settings } = await openSettings(app);
    try {
      await expect(settings.locator('#llmBackend')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
  ```

  （`openSettings` 用这个文件里已有的那个助手函数，名字照它现有的写法。）

- [ ] **Step 2: 跑测试，确认失败**

  Run: `npx playwright test test/e2e/settings-sections.spec.js`
  Expected: FAIL —— `#llmBackend` 还在。

- [ ] **Step 3: 删掉下拉**

  `src/settings/index.html`：删掉 `#llmBackend` 的 `<label>` / `<select>` / `#llmBackendHint` 那段（连同它上面的注释）。

  `src/settings/main.js`：删掉
  - `const llmBackendSelect = ...` 与 `const llmBackendHint = ...` 两行；
  - 填充选项的那段循环（约 419–431 行）；
  - 读值的那两处（约 276 行的 `llmBackendInfo(llmBackendSelect.value).label` 与约 475 行的 hint 刷新）；
  - 读值回填的那处（约 514 行）；
  - 保存时写进 patch 的那处（约 598 行的 `backend: llmBackendSelect.value`）；
  - `change` 事件的监听（约 715 行）；
  - import 里的 `LLM_BACKENDS` 与 `llmBackendInfo`（**只删这两个**，`LLM_BACKENDS` 从 `src/shared/assistant.js` 导出，`llmBackendInfo` 同理）。

  每一处删完确认没有别的引用残留（`grep -n "llmBackend" src/settings/main.js` 应当没有输出）。

- [ ] **Step 4: 删掉测那个下拉的 e2e**

  删 `test/e2e/backend-select.spec.js`——它测的是一个已经不存在的控件，留着必挂。

  `src/shared/assistant.js` 的 `LLM_BACKENDS` / `llmBackendInfo` **留着**（`test/unit/llm-backends.test.js` 还在测它们，且迁移那一步会用到）。**在提交信息里提一句它们现在是没人用的**——不要顺手删掉，那是另一件事。

- [ ] **Step 5: 跑测试，确认全绿**

  Run: `npx playwright test test/e2e/settings-sections.spec.js`
  Expected: PASS。

  Run: `node --test test/unit/llm-backends.test.js`
  Expected: PASS（shared 那两块没动，测试照旧过）。

- [ ] **Step 6: 提交**

  ```bash
  git add src/settings/index.html src/settings/main.js test/e2e/settings-sections.spec.js
  git rm test/e2e/backend-select.spec.js
  git commit -m "feat(设置): 撤掉「对话后端」下拉——前台恒定走交互层，没得选了"
  ```

---

### Task 4: 共享契约加 `model` 分类

**Files:**
- Modify: `src/shared/assistant.js`（`CHAT_KIND` 加 `MODEL`；`CHAT_KIND_LIMITS` 加 `model: 200`）
- Test: `test/unit/agent-record.test.js`（这个文件已经在测 `normalizeChatEntry` / `buildChatMessages` / `sanitizeAssistant`）

**Interfaces:**
- Consumes: 无
- Produces: `CHAT_KIND.MODEL === 'model'`；`CHAT_KIND_LIMITS.model === 200`；`CHAT_KIND_FOR_LAYER` **不含**它（两层模型都看不见它）

**为什么必须加进 `CHAT_KIND`**：`normalizeChatEntry` 里的 `chatKindOf` 对不认识的 kind 会**降级成 `reply`**——它不会被丢掉，而是会混进两层模型上下文（`buildHistoryMessages` 只按 `CHAT_KIND_FOR_LAYER` 过滤）。这是最糟的失败形态：看起来正常，其实模型开始吃不该吃的东西。

- [ ] **Step 1: 写失败的测试**

  在 `test/unit/agent-record.test.js` 里加（这个文件已经 import 了 `normalizeChatEntry` 与 `buildChatMessages`，**再加一个 `LAYER`**）：

  ```js
  test('model 记录不会被降级成 reply', () => {
    const [entry] = normalizeChatEntry({ kind: 'model', role: 'assistant', text: '我先看看剪贴板', at: 1 });
    assert.equal(entry.kind, 'model');
  });

  test('model 记录不进任何一层的模型上下文', () => {
    const history = [{ kind: 'model', role: 'assistant', text: '我先看看剪贴板', at: 1 }];
    for (const layer of [LAYER.INTERACTION, LAYER.EXECUTION]) {
      const messages = buildChatMessages({ history, layer });
      assert.equal(messages.some((m) => m.content === '我先看看剪贴板'), false);
    }
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test test/unit/agent-record.test.js`
  Expected: FAIL —— `entry.kind` 是 `'reply'`。

- [ ] **Step 3: 加进共享契约**

  `src/shared/assistant.js`：

  ```js
  export const CHAT_KIND = Object.freeze({
    USER: 'user',
    REPLY: 'reply',
    TASK: 'task',
    STEP: 'step',
    APPROVAL: 'approval',
    DISPATCH: 'dispatch',
    /** 模型的一轮往返（交互层跟模型之间说了什么）。只给人看。 */
    MODEL: 'model',
  });
  ```

  `CHAT_KIND_LIMITS` 里加：

  ```js
    // 模型回合：交互层一轮最多 3 次模型调用，一次发话最多几句——
    // 200 条够记很多轮对话了。
    model: 200,
  ```

  **`CHAT_KIND_FOR_LAYER` 不要动**——`model` 不在里面，两层模型就都看不见它。

- [ ] **Step 4: 跑测试，确认全绿**

  Run: `node --test test/unit/agent-record.test.js`
  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/shared/assistant.js test/unit/agent-record.test.js
  git commit -m "feat(助手): 记录里新增「模型回合」这一类——只给人看"
  ```

---

### Task 5: loop 把每轮的模型正文交出来

**Files:**
- Modify: `src/main/assistant/agent/loop.js`
- Test: `test/unit/agent-loop.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `createAgentLoop({ ..., onRound = null })` —— 每轮模型调用**之后**调一次 `onRound({ index, text, toolCalls })`：
  - `index`：第几轮，从 1 开始
  - `text`：该轮模型的正文（**已去掉 `<<META>>` 段**）；模型只给了工具调用时是空串
  - `toolCalls`：该轮模型请求的工具名数组（字符串数组，如 `['fs.list']`）
  - 回调是**可选**的：不传就什么都不发生（执行层不受影响）

- [ ] **Step 1: 写失败的测试**

  在 `test/unit/agent-loop.test.js` 里加：

  ```js
  test('每轮模型调用都交出正文', async () => {
    const rounds = [];
    const loop = createAgentLoop({
      callModel: async ({ messages }) => {
        const n = rounds.length + 1;
        return n === 1
          ? { text: '我先看看剪贴板', toolCalls: [{ id: 'c1', function: { name: 'clipboard.read', arguments: '{}' } }] }
          : { text: '在你剪贴板里', toolCalls: [] };
      },
      resolveTool: () => ({ name: 'clipboard.read', risk: 'read', run: async () => ({ text: '内容' }) }),
      maxSteps: 3,
      onRound: (r) => rounds.push(r),
    });
    await loop.run({ system: '', messages: [{ role: 'user', content: '在吗' }] });
    assert.equal(rounds.length, 2);
    assert.equal(rounds[0].text, '我先看看剪贴板');
    assert.deepEqual(rounds[0].toolCalls, ['clipboard.read']);
    assert.equal(rounds[1].text, '在你剪贴板里');
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test test/unit/agent-loop.test.js`
  Expected: FAIL —— `rounds` 是空的（回调还没接）。

- [ ] **Step 3: 加 `onRound` 回调**

  `src/main/assistant/agent/loop.js`：

  1. `createAgentLoop` 的参数里加 `onRound = null`（放在 `onEvent` 旁边）；
  2. 在每轮 `callModel` 返回之后、`if (!calls.length)` 判断**之前**调一次：

  ```js
      // **每轮都交出去**：模型这一轮说了什么，是交互层那部分记录的全部内容。
      // 工具调用轮通常没有正文（text 是空串）——那种轮由 step/dispatch 记录表达，
      // 这里照样交出去，轮数才对得上。
      onRound?.({
        index: steps,
        text: stripMeta(text),
        toolCalls: calls.map((c) => String(c?.function?.name || '')),
      });
  ```

  `stripMeta` 已经在 `loop.js` 里 import 了（它给 `convo` 里的 assistant 消息用）。

  **`callModel` 抛错的那一轮不调**——那一轮没有正文。

- [ ] **Step 4: 跑测试，确认全绿**

  Run: `node --test test/unit/agent-loop.test.js`
  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/main/assistant/agent/loop.js test/unit/agent-loop.test.js
  git commit -m "feat(助手): 循环把每轮的模型正文交出来——交互层要靠它记过程"
  ```

---

### Task 6: 交互层记下这一回合的过程

**Files:**
- Modify: `src/main/assistant/agent/record.js`（新增 `modelRecord`；`dispatchRecord` 带交底；`stepRecord` 带 `layer`）
- Modify: `src/main/assistant/layer/taskTools.js`（派单记录带上交底原文）
- Modify: `src/main/assistant/layer/interaction.js`（接 `onRound` 与 `onEvent`，写记录）
- Test: `test/unit/agent-interaction.test.js`、`test/unit/agent-record.test.js`

**Interfaces:**
- Consumes: Task 4 的 `CHAT_KIND.MODEL`；Task 5 的 `onRound`
- Produces:
  - `export function modelRecord({ index = 0, text = '', model = '', at = Date.now() } = {})` → `{ kind: 'model', role: 'assistant', text, at, meta: { layer: 'interaction', index, model } }`
  - `stepRecord({ ..., layer = 'execution' })` → `meta` 多一个 `layer`
  - `dispatchRecord({ ..., brief = '' })` → `meta` 多一个 `brief`
  - `createInteractionBackend({ ..., appendRecord = () => {} })` —— 新选项；交互层用它写 `model` 记录与快工具的 `step` 记录

- [ ] **Step 1: 写失败的测试（记录形态）**

  在 `test/unit/agent-record.test.js` 里加：

  ```js
  test('模型回合的记录', () => {
    const entry = modelRecord({ index: 1, text: '我先看看剪贴板', model: 'MiniMax-M2' });
    assert.equal(entry.kind, 'model');
    assert.equal(entry.text, '我先看看剪贴板');
    assert.equal(entry.meta.layer, 'interaction');
    assert.equal(entry.meta.index, 1);
    assert.equal(entry.meta.model, 'MiniMax-M2');
  });

  test('派单记录带着交底原文', () => {
    const entry = dispatchRecord({ tool: 'task.submit', taskId: 't-1', title: '查视频', brief: '看看 F 盘 video 下有什么' });
    assert.equal(entry.meta.brief, '看看 F 盘 video 下有什么');
  });

  test('步骤记录带着是哪一层的', () => {
    assert.equal(stepRecord({ taskId: '', tool: 'fs.list' }).meta.layer, 'execution');
    assert.equal(stepRecord({ taskId: '', tool: 'fs.list', layer: 'interaction' }).meta.layer, 'interaction');
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test test/unit/agent-record.test.js`
  Expected: FAIL —— `modelRecord` 不是导出、`meta.brief` 是 `undefined`。

- [ ] **Step 3: 改 `record.js`**

  - 新增 `modelRecord`（照 `taskRecord` / `stepRecord` 的写法：块注释说明「这是什么」与「为什么」）。
  - `stepRecord` 的参数加 `layer = 'execution'`，`meta` 里带上它。**旧记录没有这个字段，页面按 `execution` 兜底**。
  - `dispatchRecord` 的参数加 `brief = ''`，`meta` 里带上它。

- [ ] **Step 4: 写失败的测试（交互层写记录）**

  在 `test/unit/agent-interaction.test.js` 里加：

  ```js
  test('交互层把这一回合的过程写成记录', async () => {
    const written = [];
    const backend = createInteractionBackend({
      fetchImpl: fakeFetch([
        toolCall('clipboard.read', {}),
        say('在你剪贴板里'),
      ]),
      getRegistry: () => fakeRegistry([{ name: 'clipboard.read', risk: 'read', run: async () => ({ text: '内容' }) }]),
      getTaskTools: () => [],
      appendRecord: (entry) => written.push(entry),
      getPersona: () => ({}),
      getFacts: () => [],
      getNow: () => new Date(),
      getTaskCounts: () => ({ running: 0, queued: 0 }),
    });
    await backend.chat({ messages: [{ role: 'user', content: '剪贴板里是什么' }], config: { model: 'stub-model' } });

    const model = written.filter((e) => e.kind === 'model');
    assert.equal(model.length, 1);
    assert.equal(model[0].text, '在你剪贴板里');
    assert.equal(model[0].meta.model, 'stub-model');

    const call = written.filter((e) => e.kind === 'step');
    assert.equal(call.length, 1);
    assert.equal(call[0].meta.tool, 'clipboard.read');
    assert.equal(call[0].meta.layer, 'interaction');
  });
  ```

  （`fakeFetch` / `toolCall` / `say` / `fakeRegistry` 用这个文件里**已有**的那些助手函数；没有就照 `test/unit/agent-two-layers.test.js` 里的写法补。）

- [ ] **Step 5: 跑测试，确认失败**

  Run: `node --test test/unit/agent-interaction.test.js`
  Expected: FAIL —— `written` 是空的。

- [ ] **Step 6: 改 `interaction.js`**

  1. `createInteractionBackend` 的参数加 `appendRecord = () => {}`。
  2. `createAgentLoop({...})` 里接上两个回调：

  ```js
      onRound: (round) => {
        // **只记有正文的轮**：工具调用轮模型通常不说话（它只给 tool_calls），
        // 那种轮由 step / dispatch 记录表达——再记一条空记录，页面上就是一行空白。
        const text = String(round?.text || '').trim();
        if (!text) return;
        appendRecord(modelRecord({ index: round.index, text, model: String(config.model || '') }));
      },
      onEvent: (event) => {
        if (event?.type !== 'step') return;
        // **任务管理工具不记 step**：它们已经由 taskTools 记成派单记录了，
        // 再记一份，页面上会出现两行说同一件事的话。
        const tool = String(event.tool || '');
        if (!tool || tool.startsWith('task.')) return;
        appendRecord(stepRecord({
          taskId: '',
          index: event.index,
          tool,
          args: event.args || null,
          result: event.result || '',
          error: event.error || '',
          layer: 'interaction',
        }));
      },
  ```

  3. `modelRecord` / `stepRecord` 从 `../agent/record.js` import。

  **快工具的白名单**：`FAST_TOOL_NAMES`（`clock.now` / `clipboard.read` / `fs.read` / `fs.list`）已经在 `fastTools.js` 里定好了，这里的 `task.` 前缀过滤正好把两类工具分开——不用再引一次白名单。

- [ ] **Step 7: 派单记录带上交底**

  `src/main/assistant/layer/taskTools.js`：`record()` 函数加一个 `brief` 参数并传进 `dispatchRecord`；`task.submit` 的 `record('task.submit', {...})` 那一处把 `brief` 传进去。

  ```js
    function record(tool, { taskId = '', title = '', action = '', brief = '' } = {}) {
      appendRecord(dispatchRecord({ tool, taskId, title, action, brief, at: now() }));
    }
  ```

  `task.submit` 那处：

  ```js
        record('task.submit', { taskId: task.taskId, title, action: `派了个任务：${title}`, brief });
  ```

  **只有 `task.submit` 有交底**——其它四个工具不交底什么。

- [ ] **Step 8: 跑测试，确认全绿**

  Run: `node --test test/unit/agent-record.test.js test/unit/agent-interaction.test.js test/unit/agent-task-tools.test.js`
  Expected: 全部 PASS。

- [ ] **Step 9: 提交**

  ```bash
  git add src/main/assistant/agent/record.js src/main/assistant/layer/interaction.js src/main/assistant/layer/taskTools.js test/unit/agent-record.test.js test/unit/agent-interaction.test.js
  git commit -m "feat(助手): 交互层记下这一回合——模型说了什么、调了什么工具、交底是什么"
  ```

---

### Task 7: 前台的答复带上轮数与模型名

**Files:**
- Modify: `src/main/assistant/index.js`（写前台答复那一处加 `meta`）
- Test: `test/unit/agent-two-layers.test.js`

**Interfaces:**
- Consumes: Task 1 的 `appendChatRecord(entry)`；Task 5 之后 `interaction.chat(ctx)` 的返回值里有 `steps`（轮数）
- Produces: 前台答复的记录形状是 `{ role: 'assistant', text, at, proactive, meta: { rounds, model } }`

**为什么**：页面上那行「问模型 MiniMax-M2 · 3 轮」读的是它。轮数不能靠数 `model` 记录条数——"模型不支持工具、退回普通对话"那种轮没有正文，数条数会算漏。

- [ ] **Step 1: 写失败的测试**

  在 `test/unit/agent-two-layers.test.js` 里加一条：跑一轮前台对话之后，记录里有一条 `reply`，它的 `meta.rounds` 是这次模型调用的轮数、`meta.model` 是模型名。

  ```js
  test('前台的答复带着轮数与模型名', async () => {
    const written = [];
    // 用这个文件里已有的前台跑法（fakeFetch + runForeground），
    // 把 appendRecord 换成收集记录的版本。
    // ...
    const reply = written.filter((e) => e.role === 'assistant');
    assert.equal(reply[0].meta.rounds, 1);
    assert.equal(reply[0].meta.model, 'stub-model');
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test test/unit/agent-two-layers.test.js`
  Expected: FAIL —— `reply[0].meta` 是 `undefined`。

- [ ] **Step 3: 写进 meta**

  `src/main/assistant/index.js` 里写前台答复那一处：

  ```js
    // 记下这一轮。
    appendChatRecord({
      role: 'assistant',
      text: result.text,
      at: Date.now(),
      proactive: trigger === 'proactive',
      // **轮数与模型名**：页面上那行「问模型 X · N 轮」读的是它。
      // 轮数取后端返回的步数——数 model 记录条数会把「退回普通对话」那种轮算漏。
      meta: {
        rounds: Number(result.steps) || 0,
        model: String(config.model || ''),
      },
    });
  ```

- [ ] **Step 4: 跑测试，确认全绿**

  Run: `node --test test/unit/agent-two-layers.test.js`
  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add src/main/assistant/index.js test/unit/agent-two-layers.test.js
  git commit -m "feat(助手): 前台的答复带上轮数与模型名"
  ```

---

### Task 8: `turns.js` —— 一次发话归一块

**Files:**
- Create: `plugins/chat-history/pages/turns.js`
- Delete: `plugins/chat-history/pages/groups.js`
- Delete: `test/unit/chat-history-view.test.js`
- Test: `test/unit/chat-history-turns.test.js`

**Interfaces:**
- Consumes: 无（只吃记录数组）
- Produces:

  ```js
  /**
   * @param {Array} entries 聊天记录（按时间先后）
   * @param {object} [options]
   * @param {number} [options.now] 「今天」的基准时刻（测试里传固定值）
   * @returns {Array} 分组
   */
  export function buildTurns(entries, { now = Date.now() } = {})
  ```

  分组：

  ```js
  Group = {
    key: string,        // 'today' | 'yesterday' | '2026-11-06'
    label: string,      // '今天' | '昨天' | '11月6日'
    turns: Turn[],
  }
  ```

  一块：

  ```js
  Turn = {
    id: string,                              // 'turn:<这一块第一条记录的 id>'，重画时用它记展开状态
    at: number,                              // 这一块第一条记录的时刻
    opener: 'user' | 'pet',                  // 用户开的，还是桌宠主动开的
    title: string,                           // 标题行上那句话
    badge: 'answered' | 'running' | 'done' | 'failed',
    front: Line[],                           // 桌宠这边，按时间排
    back: TaskCard[],                        // 后台那边
  }
  ```

  **id 必须锚在记录上，不能用序号**：新的块是插在**前面**的（新的在前），用序号的话新块一进来，后面的块全体错位一格——用户展开的那块就找不回来了，展开状态全丢。记录本身的 id 是唯一的且不会变。

  「桌宠这边」的一行：

  ```js
  Line =
    | { type: 'model',    text, index, model }
    | { type: 'call',     tool, args, result, error }
    | { type: 'dispatch', tool, action, title, brief, taskId }
    | { type: 'reply',    text, rounds, model }
  ```

  `reply` 那行的 `rounds` 与 `model` 来自答复记录的 `meta`（Task 7 写的）——页面上的「问模型 MiniMax-M2 · 3 轮」读的是它。**取不到时**：模型名用最后一条 `model` 记录的 `meta.model`，轮数用 `model` 记录的条数。

  「后台那边」的一张卡：

  ```js
  TaskCard = {
    taskId: string,
    title: string,
    statuses: Array,    // 状态记录（排队中 → 进行中 → 完成）
    steps: Array,       // 步骤记录
    approvals: Array,   // 审批记录
    result: object | null,  // 完成时桌宠说的话（那条带 taskId 的 reply）
  }
  ```

- [ ] **Step 1: 写失败的测试**

  新建 `test/unit/chat-history-turns.test.js`：

  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { buildTurns } from '../../plugins/chat-history/pages/turns.js';

  const NOW = Date.parse('2026-11-08T12:00:00+08:00');
  const AT = (text) => Date.parse(`2026-11-08T${text}:00+08:00`);

  function entry(kind, text, { id = '', at = AT('10:00'), meta = {} } = {}) {
    return { id: id || `${kind}:${text}`, kind, role: 'assistant', text, at, meta };
  }
  ```

  至少覆盖这七条：

  ```js
  test('一次发话收成一块', () => {
    const groups = buildTurns([
      entry('user', '在吗', { at: AT('10:00') }),
      entry('reply', '在呢', { at: AT('10:00') }),
    ], { now: NOW });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].turns.length, 1);
    assert.equal(groups[0].turns[0].title, '在吗');
  });

  test('桌宠这边与后台那边分开', () => {
    const groups = buildTurns([
      entry('user', '查视频', { at: AT('10:00') }),
      entry('dispatch', '派了个任务：查视频', { at: AT('10:01'), meta: { tool: 'task.submit', taskId: 't-1', brief: '看看 video 下有什么' } }),
      entry('task', '完成 · 查视频', { at: AT('10:05'), meta: { taskId: 't-1', status: 'done', title: '查视频' } }),
      entry('step', 'fs.list', { at: AT('10:04'), meta: { taskId: 't-1', tool: 'fs.list' } }),
      entry('reply', '有 12 个视频', { at: AT('10:06'), meta: { taskId: 't-1', layer: 'execution' } }),
    ], { now: NOW });
    const turn = groups[0].turns[0];
    assert.equal(turn.front.filter((l) => l.type === 'dispatch').length, 1);
    assert.equal(turn.back.length, 1);
    assert.equal(turn.back[0].taskId, 't-1');
    assert.equal(turn.back[0].result.text, '有 12 个视频');
  });

  test('后台任务晚完成：结果回到发起它的那一块', () => {
    // 用户在 10:00 派了单，10:05 任务完成——完成记录不能自己另起一块。
    const groups = buildTurns([
      entry('user', '查视频', { at: AT('10:00') }),
      entry('dispatch', '派单', { at: AT('10:01'), meta: { tool: 'task.submit', taskId: 't-1' } }),
      entry('user', '顺便看看天气', { at: AT('10:03') }),
      entry('reply', '有 12 个视频', { at: AT('10:05'), meta: { taskId: 't-1' } }),
    ], { now: NOW });
    assert.equal(groups[0].turns.length, 2);
    assert.equal(groups[0].turns[0].back[0].result.text, '有 12 个视频');
    assert.equal(groups[0].turns[1].back.length, 0);
  });

  test('同一个任务号有多条派单：任务归最早那一轮，后来的动作留在自己那一轮', () => {
    const groups = buildTurns([
      entry('user', '查视频', { at: AT('10:00') }),
      entry('dispatch', '派单', { at: AT('10:01'), meta: { tool: 'task.submit', taskId: 't-1' } }),
      entry('user', '停掉它', { at: AT('10:02') }),
      entry('dispatch', '停掉', { at: AT('10:03'), meta: { tool: 'task.cancel', taskId: 't-1' } }),
      entry('task', '已取消', { at: AT('10:04'), meta: { taskId: 't-1', status: 'cancelled' } }),
    ], { now: NOW });
    assert.equal(groups[0].turns[0].back.length, 1);
    assert.equal(groups[0].turns[1].front.filter((l) => l.type === 'dispatch').length, 1);
  });

  test('找不到派单的任务：自己成一块', () => {
    const groups = buildTurns([
      entry('task', '完成 · 查视频', { at: AT('10:05'), meta: { taskId: 't-9', status: 'done', title: '查视频' } }),
      entry('step', 'fs.list', { at: AT('10:04'), meta: { taskId: 't-9', tool: 'fs.list' } }),
    ], { now: NOW });
    assert.equal(groups[0].turns.length, 1);
    assert.equal(groups[0].turns[0].back.length, 1);
    assert.equal(groups[0].turns[0].title, '查视频');
  });

  test('没有锚点的记录：自己成一块，不丢', () => {
    const groups = buildTurns([
      entry('model', '我先看看剪贴板', { at: AT('10:00'), meta: { layer: 'interaction', index: 1 } }),
    ], { now: NOW });
    assert.equal(groups[0].turns.length, 1);
    assert.equal(groups[0].turns[0].front.length, 1);
  });

  test('徽标：已答 / 后台运行中 / 已完成 / 失败', () => {
    const answered = buildTurns([entry('user', '在吗'), entry('reply', '在呢')], { now: NOW })[0].turns[0];
    assert.equal(answered.badge, 'answered');

    const running = buildTurns([
      entry('user', '查视频'),
      entry('dispatch', '派单', { meta: { tool: 'task.submit', taskId: 't-1' } }),
      entry('task', '进行中', { meta: { taskId: 't-1', status: 'running' } }),
    ], { now: NOW })[0].turns[0];
    assert.equal(running.badge, 'running');

    const done = buildTurns([
      entry('user', '查视频'),
      entry('dispatch', '派单', { meta: { tool: 'task.submit', taskId: 't-1' } }),
      entry('task', '完成', { meta: { taskId: 't-1', status: 'done' } }),
    ], { now: NOW })[0].turns[0];
    assert.equal(done.badge, 'done');

    const failed = buildTurns([entry('user', '在吗')], { now: NOW })[0].turns[0];
    assert.equal(failed.badge, 'failed');
  });
  ```

- [ ] **Step 2: 跑测试，确认失败**

  Run: `node --test test/unit/chat-history-turns.test.js`
  Expected: FAIL —— `Cannot find module '.../pages/turns.js'`。

- [ ] **Step 3: 写 `turns.js`**

  文件开头一段块注释，说明「这是什么」（把一堆记录归成"一次发话"的块）与「为什么这么写」（散着看是一堆噪音，合起来才是"这件事干到哪了"）。

  算法（纯函数，不碰 DOM）：

  1. **挑出后台记录**：带 `meta.taskId` 的 `task` / `step` / `approval`，以及带 `meta.taskId` 的 `reply`（那是后台完成时桌宠说的话）。按 `taskId` 聚成任务卡（`statuses` / `steps` / `approvals` / `result`）。剩下的记录进时间流。
  2. **切块**：时间流里一条 `user` 开一块；`reply` 且 `proactive` 为真也开一块（桌宠主动说的）。块之间按时间排。
  3. **挂派单**：每条 `dispatch` 落在它时间上所属的块里（`front` 的一行）。同时记下 `taskId → 块序号` 的**最早**映射。
  4. **挂任务卡**：按最早那条派单找到块，挂进那一块的 `back`；找不到派单的（老记录）**自己成一块**（`opener: 'pet'`，`title` 取任务标题）。
  5. **算徽标**：有任务还没到终态 → `running`；有任务但全到终态（有失败的） → `failed`，否则 `done`；没有任务 → 有前台答复 `answered`，没有 `failed`。
     终态用 `TASK_FINAL_STATUS`（`src/shared/assistant.js`）：任务的**最后一条**状态记录是终态就算完了。
  6. **按天分组**：`now` 当天 → `today`（标签「今天」）；昨天 → `yesterday`（标签「昨天」）；其余 → `YYYY-MM-DD`（标签「M月D日」）。组按时间倒序（新的在前），块在组内按时间倒序。

  **`title`**：用户开的块用那句用户说的话；桌宠开的块用桌宠那句话；孤儿块用块里第一条有正文的记录。

- [ ] **Step 4: 跑测试，确认全绿**

  Run: `node --test test/unit/chat-history-turns.test.js`
  Expected: 全部 PASS。

- [ ] **Step 5: 删掉旧的分块与它的测试**

  删 `plugins/chat-history/pages/groups.js` 与 `test/unit/chat-history-view.test.js`——`turns.js` 取代了它们。

- [ ] **Step 6: 提交**

  ```bash
  git add plugins/chat-history/pages/turns.js test/unit/chat-history-turns.test.js
  git rm plugins/chat-history/pages/groups.js test/unit/chat-history-view.test.js
  git commit -m "feat(聊天记录): 一次发话归一块——桌宠这边与后台那边分开"
  ```

---

### Task 9: 页面按三层折叠重画

**Files:**
- Modify: `plugins/chat-history/pages/history.js`
- Modify: `plugins/chat-history/pages/history.html`
- Test: `test/e2e/chat-history.spec.js`

**Interfaces:**
- Consumes: Task 8 的 `buildTurns(entries, { now })`
- Produces: 页面上的 DOM 结构（e2e 按这些选择器断言）：

  ```html
  <section class="day" data-day="today">
    <h2 class="day-title">今天</h2>
    <details class="turn" data-turn="turn:0" open>
      <summary class="turn-head">
        <span class="turn-time">14:32</span>
        <span class="turn-title">F 盘 video 下有什么</span>
        <span class="turn-badge badge-running">后台运行中</span>
      </summary>
      <div class="turn-body">
        <section class="lane lane-front">
          <h3 class="lane-title">桌宠这边</h3>
          <details class="detail" data-detail="model">
            <summary class="detail-head">问模型 MiniMax-M2 · 3 轮</summary>
            <div class="detail-body">
              <p class="model-line">第 1 轮：我先看看剪贴板</p>
            </div>
          </details>
          <details class="detail" data-detail="call:clipboard.read">
            <summary class="detail-head">调了一次剪贴板</summary>
            <div class="detail-body"><pre class="detail-pre"></pre></div>
          </details>
          <details class="detail" data-detail="dispatch:t-1">
            <summary class="detail-head">派了个后台任务：查 F 盘 video</summary>
            <div class="detail-body">
              <details class="detail" data-detail="brief:t-1">
                <summary class="detail-head">交底</summary>
                <div class="detail-body"><pre class="detail-pre">看看 F 盘 video 下有什么</pre></div>
              </details>
            </div>
          </details>
          <p class="reply-line">我去看看</p>
        </section>
        <section class="lane lane-back">
          <h3 class="lane-title">后台那边</h3>
          <section class="task">
            <div class="task-title">查 F 盘 video</div>
            <div class="task-status">排队中 → 进行中</div>
            <details class="detail" data-detail="steps:t-1">
              <summary class="detail-head">步骤（3）</summary>
              <div class="detail-body"><ol class="step-list"></ol></div>
            </details>
            <div class="task-result">有 12 个视频</div>
          </section>
        </section>
      </div>
    </details>
  </section>
  ```

- [ ] **Step 1: 写失败的 e2e**

  在 `test/e2e/chat-history.spec.js` 里，把现有的断言改成新结构，并加一条「交底默认折起，展开看得到原文」：

  ```js
  // 一次发话 = 一块
  await expect(frame.locator('.turn')).toHaveCount(1);
  await expect(frame.locator('.turn-title')).toHaveText('在吗');

  // 块里分两段
  await expect(frame.locator('.lane-front .lane-title')).toHaveText('桌宠这边');
  await expect(frame.locator('.lane-back .lane-title')).toHaveText('后台那边');

  // 交底默认折起，展开看得到原文
  const brief = frame.locator('.lane-front details').filter({ hasText: '交底' });
  await expect(brief).not.toHaveAttribute('open', '');
  await brief.locator('summary').click();
  await expect(brief).toHaveAttribute('open', '');
  await expect(brief.locator('.detail-pre')).toHaveText('看看 F 盘 video 下有什么');
  ```

  （种子里那份 `assistant.json` 要加一条带 `meta.brief` 的 `dispatch` 记录。）

  **还有一条已有的测试要改选择器**：「页面开着的时候：新记录不用重开就出现」那条里，展开步骤用的是 `.task details`——新结构里步骤是 `.detail[data-detail="steps:t-1"]`。**那条测试的作用是"实时更新别把用户正在看的收起来"，改选择器时别把它删了。**

- [ ] **Step 2: 跑 e2e，确认失败**

  Run: `npx playwright test test/e2e/chat-history.spec.js`
  Expected: FAIL —— `.turn` 这个选择器找不到。

- [ ] **Step 3: 改 `history.js`**

  1. `import { buildTurns } from './turns.js'`，去掉 `groupEntries`。
  2. `render()` 改成：先 `buildTurns(store.list())`，再按分组画。
  3. **展开状态**：`captureView()` 记下所有 `details[data-detail]` 与 `details[data-turn]` 的 `open` 状态（用它们的 `data-*` 当钥匙）；`restoreView()` 还原。
     **用户手动改过的优先于默认值**：默认值只在"用户没碰过的块"上生效——记一个 `touched` 集合（本次会话内），重画时若某块在 `touched` 里，就用它上次的 `open` 值。
  4. **默认展开**：后台还在跑的块默认展开，其余折起。**默认只作用于用户没碰过的块。**
  5. **滚动位置**：新的在前，所以新记录进来是在**上面**。记下重画前的 `scrollTop` 与 `scrollHeight`，重画后把 `scrollTop` 加上内容高度的变化量（`新 scrollHeight - 旧 scrollHeight`）——这样他看到的那一条**停在原地**，不会因为上面多了东西而被顶走。原来那句"贴着底部就跟着往下走"（旧的列表是新的在下）**不再适用**，删掉。
  6. 渲染仍然**不用 `innerHTML`**（记录里全是用户与模型的原话，直接拼进 HTML 就是注入的口子）：用 `createElement` + `textContent`。

- [ ] **Step 4: 改 `history.html`**

  用 `theme.css` 的 `--dp-*` 变量写三层折叠的样式：

  - `.turn`：`border: 1px solid var(--dp-border-soft)`；`border-radius: var(--dp-radius)`；`background: var(--dp-surface)`。
  - `.turn summary`：`cursor: pointer`；列表样式去掉（`list-style: none`）。
  - `.lane-title`：`font-size: 12px`；`color: var(--dp-text-soft)`。
  - `.turn-badge`：小圆角标签；`running` 用 `var(--dp-accent-strong)`；`failed` 用 `var(--dp-danger)`。
  - `.detail-head`：`cursor: pointer`；`font-size: 12px`；`color: var(--dp-text-soft)`。
  - `.detail-pre`：`white-space: pre-wrap`；`word-break: break-word`；`font-size: 12px`。
  - `.turn-title`：**一行截断**（`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`）。

  面板里（`body.dp-panel`）与独立窗口里都能看：宽度靠弹性布局，不写死像素。

- [ ] **Step 5: 写文案映射**

  页面上的话照规格 §4.5 那张表：

  | 内部 | 页面上的话 |
  |---|---|
  | `model` 记录 | 「问模型 {model} · {rounds} 轮」；展开后每轮「第 {index} 轮：{text}」 |
  | 交互层 `step` | 「调了一次剪贴板」/「看了目录 {args}」 |
  | `dispatch`（`task.submit`） | 「派了个后台任务：{title}」 |
  | `dispatch`（`task.list`） | 「看了看后台任务」 |
  | `dispatch`（`task.cancel`） | 「停掉了任务 {taskId}」 |
  | `dispatch`（`task.delete`） | 「归档了任务 {taskId}」 |
  | `dispatch`（`task.steer`） | 「给任务追加了一句要求」 |
  | 不认识的工具 | 直接显示 `meta.action` 原文 |
  | `dispatch.meta.brief` | 摘要写「交底」 |
  | 执行层 `task` | 「{title} · {状态}」 |
  | 执行层 `step` | 摘要写「步骤（N）」 |
  | 执行层 `reply` | 摘要写「结果」 |
  | 徽标 | 「已答」/「后台运行中」/「已完成」/「失败」 |

  **快工具的人话**：`clipboard.read` → 「调了一次剪贴板」；`fs.read` → 「读了一个文件」；`fs.list` → 「看了目录」；`clock.now` → 「问了时间」。参数取第一个，截到 40 字。

- [ ] **Step 6: 跑 e2e，确认全绿**

  Run: `npx playwright test test/e2e/chat-history.spec.js`
  Expected: 全部 PASS。

- [ ] **Step 7: 提交**

  ```bash
  git add plugins/chat-history/pages/history.js plugins/chat-history/pages/history.html test/e2e/chat-history.spec.js
  git commit -m "feat(聊天记录): 页面按三层折叠重画——一次发话一块，块里分两段"
  ```

---

### Task 10: e2e 走一遍完整链路

**Files:**
- Modify: `test/e2e/chat-history.spec.js`

**Interfaces:**
- Consumes: Task 2（完成的答复带任务号）、Task 6（交互层的记录）、Task 9（页面结构）
- Produces: 一条把「发话 → 交互层过程 → 派单 → 后台干完 → 结果回到原来那一块」串起来的端到端验证

- [ ] **Step 1: 写失败的 e2e**

  ```js
  test('一次发话的事：过程与结果都在同一块里', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      // ... 打开聊天记录插件、分离成独立窗口（照这个文件里已有的写法）...

      // 种子里：一条 user + 一条 model + 一条 dispatch(带 brief) + 一条 task + 一条带 taskId 的 reply
      const turn = winFrame.locator('.turn').first();
      await expect(turn.locator('.lane-front')).toContainText('派了个后台任务');
      await expect(turn.locator('.lane-back .task')).toContainText('查视频');
      // 结果回到**这一块**里
      await expect(turn.locator('.task-result')).toHaveText('有 12 个视频');
      // 只有一块
      await expect(winFrame.locator('.turn')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
  ```

- [ ] **Step 2: 跑 e2e，确认失败**

  Run: `npx playwright test test/e2e/chat-history.spec.js`
  Expected: FAIL（哪一条挂就修哪一条——大概率是种子里少一条带 `taskId` 的 `reply`）。

- [ ] **Step 3: 补齐种子数据**

  `seedChat()` 里加上：`model` 记录（`meta.layer: 'interaction'`）、带 `meta.brief` 的 `dispatch`、`meta.taskId` 的 `task` 与 `reply`。

  **`reply` 那条要有 `meta.taskId`**——Task 2 之后完成的通知才有任务号。

- [ ] **Step 4: 跑 e2e，确认全绿**

  Run: `npx playwright test test/e2e/chat-history.spec.js`
  Expected: 全部 PASS。

  Run: `node --test test/unit/`
  Expected: 全部 PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add test/e2e/chat-history.spec.js
  git commit -m "test(聊天记录): 端到端——一次发话的过程与结果在同一块里"
  ```

---

## 收尾清单

- [ ] `node --test test/unit/` 全绿
- [ ] `npx playwright test` 全绿（**本机已知会挂的除外**：剪贴板助手那条、录屏插件的多显示器那几条——见 MEMORY.md）
- [ ] 页面上找不到 `kind` / `taskId` / `layer` / `dispatch` 这类词
- [ ] 设置窗口里没有「对话后端」下拉
- [ ] `docs/superpowers/specs/2026-11-08-chat-history-turns-design.md` 与实现一致（实现过程中若改了设计，回改规格）
