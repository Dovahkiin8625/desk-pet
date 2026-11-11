# 交互层与后台任务层重新分工 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交互层只留 4 个动作类工具并把派单压到一次模型往返；桌宠的话里不出现工具名与内部话术；「某某工作怎么样了」不用调工具就能答；后台任务层的答复按桌宠口吻；切「只聊天」时先确认再停掉在跑的任务。

**Architecture:** 两层重新划界——交互层只负责「说话」（4 个动作工具、一次往返、状态写在提示词里），后台任务层负责「做事」（全部工具、技能渐进披露）。新增一个话术过滤模块 `layer/speech.js`，作用在所有对用户可见的桌宠文字上（交互层的流式正文与最终答复、后台任务的汇报、兜底路径的普通对话）。

**Tech Stack:** Electron 45 / 原生 ESM（无构建步骤）/ node:test（单元）/ Playwright（端到端）/ `node --test "test/unit/**/*.test.js"`。

**Spec:** `docs/superpowers/specs/2026-11-11-interaction-and-task-layers-design.md`（本计划的依据；执行时两份一起读）

## Global Constraints

- **回复用中文；注释简洁，不加解释性注释；UI 里不出现解释代码逻辑的说明。**
- **工具名只进数据，不进界面。** 例外：任务看板是排查用的调试面板，继续显示工具名（`fs.write`）。
- **桌宠嘴里不许出现**：工具名、函数名、插件名，以及「后台任务」「派单」「派发」「工具」这些词。
- **交互层的模型往返必须是 1 次**（直接回答 1 次，派单 1 次）。
- **交互层的 `maxTokens` 是下限不是上限**：`max(用户设置, 1024)`。工具参数与正文共用这一个额度，截断了 JSON 就废了。
- **接口的规矩一个字不改**：每个 `tool_call` 都必须有对应的 `role:'tool'` 消息；工具出错要喂回模型而不是终止。
- **改动只碰本计划列出的文件**；不顺手重构相邻代码，不删本次改动之外的死代码。
- 每个任务结束都要 `npm run test:unit` 通过；涉及界面的任务还要跑对应的 e2e。

## Review Focus

以下五类输入/状况，规格没明说，但最可能咬人。每一类都在下面某个任务里有对应的测试钉住。

1. **模型调工具时正文里带了半句禁词**（「我用 fs.read 读」被切成「我用 fs.re」+「ad 读」）——过滤器必须按住尾巴，不能把半截词吐给用户（Task 4）。
2. **派单那一轮模型没写 `reply`**——不能因此卡住或丢答案，要退回第 2 轮让模型自己说（Task 2 / Task 5）。
3. **工具调用那一轮的 JSON 被 `max_tokens` 截断**——参数不是合法 JSON，工具调用直接失败，1 次往返的承诺破功（Task 5 的 `minMaxTokens`）。
4. **`reply` 里带了 `<<META>>`**——正文要剥掉 META，情绪与记忆要留下，漏出来的标记不能进气泡（Task 4 / Task 5）。
5. **切「只聊天」时正好有任务在跑**——用户点「取消」就什么都不能改（下拉框要退回原值），点「确定」才停任务（Task 9）。

---

### Task 1: 循环支持「工具直接给出答复」

派单要压到一次模型往返，靠的是：工具执行成功后，**工具自己带回的那句话就是这一轮的最终答复**，循环不再问模型第二遍。

**Files:**
- Modify: `src/main/assistant/agent/loop.js`（`createAgentLoop` 的选项与回合收尾处）
- Test: `test/unit/agent-loop.test.js`

**Interfaces:**
- Consumes: 现有 `createAgentLoop({callModel, resolveTool, gate, maxSteps, summarize, ...})`；工具返回值 `{text, data}`（`data` 是给界面的，不进上下文）。
- Produces: `createAgentLoop({ ..., answerFromTool = false })`。
  - `answerFromTool` 为 `true` 时：某个工具调用**成功**且返回的 `data.answer` 是非空字符串 → 收集它；本回合的 `tool_call` 全部处理完后，循环以 `finalText = 收集到的 answer 用空格连起来（最多取前 2 条）`、`outcome = AGENT_OUTCOME.DONE` 结束。
  - 为 `false` 时行为与现在完全一样（执行层用这个默认值）。

- [ ] **Step 1: 写失败测试**

在 `test/unit/agent-loop.test.js` 里加：

```js
test('answerFromTool：工具带回的答复就是最终答复，不再问模型第二遍', async () => {
  const calls = [];
  const loop = createAgentLoop({
    answerFromTool: true,
    callModel: async ({ messages }) => {
      calls.push(messages);
      if (calls.length === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', function: { name: 'do.it', arguments: '{}' } }],
        };
      }
      throw new Error('不该有第二次模型调用');
    },
    resolveTool: () => ({
      name: 'do.it',
      risk: 'read',
      run: async () => ({ text: '做完了', data: { answer: '我去办' } }),
    }),
  });
  const run = await loop.run({ system: 's', messages: [{ role: 'user', content: '去办' }] });
  assert.equal(run.text, '我去办');
  assert.equal(run.outcome, AGENT_OUTCOME.DONE);
  assert.equal(calls.length, 1, '工具给了答复就不该再问模型');
});

test('answerFromTool：默认关闭时行为不变（工具的 data.answer 不算数）', async () => {
  // 同样的工具，但循环没开 answerFromTool：
  // 模型得自己再答一次，工具带的 answer 不能顶替它。
  // 断言 run.text 是模型第二轮说的话，不是「我去办」。
});

test('answerFromTool：工具失败时不带答复，循环照常走下一轮', async () => {
  // 工具抛错 → data.answer 不存在 → 循环继续调模型，
  // 模型第二轮给答案，答案要是模型说的那句。
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/agent-loop.test.js`
Expected: FAIL（`answerFromTool` 未定义，行为还是「工具给了答复也再问一次模型」）

- [ ] **Step 3: 实现**

在 `src/main/assistant/agent/loop.js`：

1. `createAgentLoop` 的参数表里加 `answerFromTool = false`（带一句注释说明它是给交互层用的）。
2. 在每回合的工具循环里，`const one = await runOne(...)` 之后、错误计数之前，加：

```js
// 工具自己带回了一句给用户的话：这句就是这一轮的最终答复。
if (answerFromTool && one.ok) {
  const answer = String(one.data?.answer || '').trim();
  if (answer) answers.push(answer);
}
```

（`answers` 是每个回合开始时清空的数组。）

3. 该回合的 `tool_call` 全部处理完、`convo.push({role:'tool',...})` 都补齐之后、`if (outcome === AGENT_OUTCOME.REPEATED_ERRORS) break;` 之前，加：

```js
// 工具给了答复：这一轮就是最终答复，不再问模型。
if (answerFromTool && answers.length) {
  finalText = answers.slice(0, 2).join(' ');
  outcome = AGENT_OUTCOME.DONE;
  break;
}
```

**注意**：`break` 要跳出**回合while 循环**（不是只跳出工具 for 循环）——确认缩进层级。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/agent-loop.test.js`
Expected: PASS（既有测试也要全过）

- [ ] **Step 5: 提交**

```bash
git add src/main/assistant/agent/loop.js test/unit/agent-loop.test.js
git commit -m "feat(agent): 循环支持工具直接给出最终答复"
```

---

### Task 2: 任务管理工具瘦身到 4 个 + `reply` 参数

**Files:**
- Modify: `src/main/assistant/layer/taskTools.js`
- Test: `test/unit/agent-task-tools.test.js`

**Interfaces:**
- Consumes: 现有 `createTaskTools({tasks, turn, dispatchEnabled, appendRecord, now})`，`tasks` 是任务中枢（`submit` / `cancel` / `archive` / `steer`）。
- Produces: `createTaskTools(...)` 返回**恰好 4 个**工具，形状不变（`{name, label, description, parameters, risk, run}`）：

| 工具 | parameters.properties | required | 返回的 `data` |
|---|---|---|---|
| `task.submit` | `title`(string), `brief`(string), `reply`(string) | `['title','brief']` | `{taskId, queued, answer}` |
| `task.cancel` | `taskId`(string), `reply`(string) | `['taskId']` | `{taskId, answer}` |
| `task.steer` | `taskId`(string), `note`(string), `reply`(string) | `['taskId','note']` | `{taskId, note, answer}` |
| `task.delete` | `taskId`(string), `reply`(string) | `['taskId']` | `{taskId, answer}` |

`data.answer` = `reply` 参数去掉首尾空白后的字符串；模型没写就空串。

- [ ] **Step 1: 写失败测试**

在 `test/unit/agent-task-tools.test.js` 里加：

```js
test('工具表：只剩四个动作类工具，没有查列表与查状态', () => {
  const names = createTaskTools({ tasks: fakeTasks() }).map((t) => t.name);
  assert.deepEqual(names, ['task.submit', 'task.cancel', 'task.steer', 'task.delete']);
});

test('四个工具都带 reply 参数，且是可选的', () => {
  const tools = createTaskTools({ tasks: fakeTasks() });
  for (const t of tools) {
    assert.ok(t.parameters.properties.reply, `${t.name} 少了 reply 参数`);
    assert.equal(t.parameters.properties.reply.type, 'string');
    assert.ok(!t.parameters.required.includes('reply'), `${t.name} 的 reply 不该是必填`);
  }
});

test('派单：reply 原样带回 data.answer', async () => {
  const tools = createTaskTools({ tasks: fakeTasks(), turn: { userText: '查天气' } });
  const submit = tools.find((t) => t.name === 'task.submit');
  const out = await submit.run({ title: '查天气', brief: '查一下', reply: ' 我这就去查 ' });
  assert.equal(out.data.answer, '我这就去查');
});

test('派单：模型没写 reply 时 answer 是空串（不是 undefined）', async () => {
  const tools = createTaskTools({ tasks: fakeTasks(), turn: { userText: '查天气' } });
  const submit = tools.find((t) => t.name === 'task.submit');
  const out = await submit.run({ title: '查天气', brief: '查一下' });
  assert.equal(out.data.answer, '');
});

test('工具描述里不许出现「后台任务」「派单」这类词', () => {
  const tools = createTaskTools({ tasks: fakeTasks() });
  for (const t of tools) {
    assert.ok(!/后台任务|派单|派发/.test(t.description), `${t.name} 的描述漏了内部话术：${t.description}`);
    assert.ok(!/后台任务|派单|派发/.test(t.parameters.properties.reply?.description || ''));
  }
});
```

（`fakeTasks()` 是这个测试文件里已有的假任务中枢；若没有就照 `agent-interaction.test.js` 里那个写法补一个最小的。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/agent-task-tools.test.js`
Expected: FAIL（现在还有 6 个工具，也没有 `reply`）

- [ ] **Step 3: 实现**

改 `src/main/assistant/layer/taskTools.js`：

1. **删掉** `task.list` 与 `task.status` 两个工具。
2. **删掉**因此没人用的 `describeTask`、`STATUS_LABEL`、`formatElapsed`（`formatElapsed` 在 Task 5 会以另一份实现出现在 `layer/prompt.js`）。
3. 四个工具的 `description` 换成下面这四句（一字不改）：

```js
// task.submit
'把一件事交出去做——你自己干不了、或者要花时间的事都走这里。' +
  '要什么结果写在 brief 里；要跟用户说的那句话写在 reply 里。做完会另行通知你。'
// task.cancel
'让一件正在做的事停下。'
// task.steer
'给一件正在做的事补一句要求（不改它原本要做什么）。'
// task.delete
'把一件已经结束的事收起来（记录仍然留着）。'
```

4. `reply` 参数的定义（四个工具都一样）：

```js
reply: {
  type: 'string',
  description:
    '要跟用户说的那一句话：一两句，口语。不要报告结果，不要提任何工具名。' +
    '后面可以跟一段 <<META>>{...}（情绪与要记住的事），不写也行。',
},
```

5. 四个工具的 `run` 都要先把 `reply` 取出来：

```js
const answer = String(args?.reply || '').trim();
```

并在返回的 `data` 里带上 `answer`（`task.submit` 是 `{taskId, queued, answer}`，其余是 `{..., answer}`）。

6. `label` 字段也换成用户语言：`开始做一件事` / `让一件事停下` / `给一件事补要求` / `把一件事收起来`（`label` 是给人看的，页面上会显示）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/agent-task-tools.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/assistant/layer/taskTools.js test/unit/agent-task-tools.test.js
git commit -m "refactor(layer): 任务管理工具瘦身为四个动作，答复写进 reply 参数"
```

---

### Task 3: 工具名的友好标签

状态块要写进提示词（「刚读完一个目录」），就不能把 `fs.list` 写进提示词——模型会照着说给用户听。

**Files:**
- Modify: `src/main/assistant/agent/loop.js`（step 事件带 `label`）
- Modify: `src/main/assistant/agent/tasks.js`（`brief()` 增 `lastStepLabel`）
- Modify: `src/main/assistant/agent/skills.js`（`skill.read` 的 label）
- Test: `test/unit/agent-loop.test.js`、`test/unit/agent-tasks.test.js`

**Interfaces:**
- Consumes: 工具描述符里的 `label` 字段（给人看的那句，如「列目录」「查天气」）。
- Produces:
  - 循环的 step 事件多一个 `label` 字段（工具描述符的 `label`，没有就空串）。
  - `agentTasks.list()` 每个任务多一个 `lastStepLabel` 字段：最近一步的友好标签；**没有步���或最近一步失败时是空串**。
  - `lastStep` **保持不变**（仍是工具名）——任务看板还要用它。

- [ ] **Step 1: 写失败测试**

`test/unit/agent-tasks.test.js` 加：

```js
test('任务清单：给的是人话标签（lastStepLabel），工具名照旧留在 lastStep', () => {
  // 造一个跑过一步的任务（那一步是 fs.list，label 是「列目录」）：
  //   assert.equal(task.lastStep, 'fs.list');
  //   assert.equal(task.lastStepLabel, '列目录');
});

test('最近一步失败时 lastStepLabel 是空串（不装作成功）', () => {
  // 那一步报错 → lastStep 含「出错」，lastStepLabel 为空串。
});
```

`test/unit/agent-loop.test.js` 加：

```js
test('step 事件带上工具的人话标签', async () => {
  // 工具的 label 是「列目录」→ 收到的 step 事件里 label === '列目录'。
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/agent-loop.test.js test/unit/agent-tasks.test.js`
Expected: FAIL（`lastStepLabel` 不存在，step 事件没有 label）

- [ ] **Step 3: 实现**

1. `src/main/assistant/agent/loop.js`：step 事件里加 `label: String(tool?.label || '')`（工具描述符上的 label）。注意：**外部 harness 的事件自带 label**（`ctx.onEvent` 传上来的），那一条不要被覆盖——harness 事件的 label 是「这一��做了什么」的描述，比工具标签更具体。
2. `src/main/assistant/agent/tasks.js`：
   - `lastSteps.set(taskId, { tool, label, index, failed })` 里存下 label；
   - `brief()` 里加 `lastStepLabel: step && !step.failed ? String(step.label || '') : ''`。
3. `src/main/assistant/agent/skills.js`：`skill.read` 的 `label` 从 `'读技能说明'` 改成 `'读文档'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/agent-loop.test.js test/unit/agent-tasks.test.js test/unit/agent-runtime-tasks.test.js test/unit/tasks-format.test.js`
Expected: PASS（后两个文件断言 `lastStep` 是工具名——**不许动 `lastStep`**）

- [ ] **Step 5: 提交**

```bash
git add src/main/assistant/agent/loop.js src/main/assistant/agent/tasks.js src/main/assistant/agent/skills.js test/unit/agent-loop.test.js test/unit/agent-tasks.test.js
git commit -m "feat(agent): 步骤带人话标签，任务清单给 lastStepLabel"
```

---

### Task 4: 话术过滤器

桌宠嘴里不许出现工具名与内部话术。提示词是第一道防线，过滤器是第二道（兜底第三道在 Task 5 接）。

**Files:**
- Create: `src/main/assistant/layer/speech.js`
- Test: `test/unit/layer-speech.test.js`

**Interfaces:**
- Produces（两个导出）：
  - `sanitizeSpeech(text, { toolNames = [] } = {}) → string`：把一整段话里的内部话术清掉。
  - `createSpeechFilter({ toolNames = [] } = {}) → { push(delta) → string, finish() → string, get text() → string }`：流式版。`push` 收一段增量、返回**可以显示**的部分；`finish` 收尾，返回剩下的。

**替换表（先长后短，长的先替）**：

| 原样 | 换成 |
|---|---|
| `后台任务` | `这件事` |
| `后台的事` | `这件事` |
| `派出任务` | `这件事` |
| `后台` | （删掉） |
| `派单` | `安排` |
| `派发` | `安排` |
| `派出去` | `去做` |
| `任务` | `事情` |
| `工具` | （删掉） |
| `插件` | （删掉） |
| `MCP` | （删掉） |
| `<<META>>` | （删掉） |

**工具名**：出现在 `toolNames` 里的名字一律换成 `这件事`。`toolNames` 是**精确匹配**（`weather.get`、`fs.read` 这种），**不要**用 `a.b` 这种形状去乱猜——文件路径 `a.mp4` 不能被误伤。

**删完之后收拾**：去掉空括号 `（）`、`()`，合并多余空格，去掉首尾多余的 `，`,`、`。`、空格。**删空了**（结果为空或只剩标点）→ 返回兜底句 `这个我记下了。`

**流式的尾巴**：一个禁词可能被切成两半（「后台任」+「务」）。所以 `push` 时要算出「当前缓冲区末尾有多长的一段是某个禁词的前缀」，把这一段按住不吐，等下一段来了看清了再吐。常态下按住 0 个字。

- [ ] **Step 1: 写失败测试**

新建 `test/unit/layer-speech.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSpeech, createSpeechFilter } from '../../src/main/assistant/layer/speech.js';

test('内部话术被换掉', () => {
  assert.equal(sanitizeSpeech('我派了个后台任务'), '我安排了个这件事');
  assert.equal(sanitizeSpeech('这个任务我记下了'), '这件事我记下了');
  assert.equal(sanitizeSpeech('我派单了'), '我安排了');
});

test('工具名按名字精确替换，文件路径不误伤', () => {
  assert.equal(sanitizeSpeech('我用 fs.read 读的', { toolNames: ['fs.read'] }), '我用这件事读的');
  assert.equal(sanitizeSpeech('文件是 a.mp4', { toolNames: ['fs.read'] }), '文件是 a.mp4');
});

test('删空了给兜底句', () => {
  assert.equal(sanitizeSpeech('工具'), '这个我记下了。');
});

test('流式：禁词被切成两半时不会漏出去', () => {
  const f = createSpeechFilter({ toolNames: [] });
  const a = f.push('我用 fs.re');
  const b = f.push('ad 读完了');
  const c = f.finish();
  const all = a + b + c;
  assert.ok(!all.includes('fs.read'), `半个词漏出去了：${all}`);
  assert.ok(all.includes('读完了'));
});

test('流式：普通文本逐段吐出来，不整段憋着', () => {
  const f = createSpeechFilter({ toolNames: [] });
  assert.equal(f.push('你好'), '你好');
  assert.equal(f.push('啊'), '啊');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/layer-speech.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `src/main/assistant/layer/speech.js`：

```js
/**
 * 桌宠说话前的过滤：把内部话术与工具名清掉。
 *
 * 提示词是第一道防线，这里是第二道：模型偶尔还是会漏一个词出来，
 * 用户看见「后台任务」四个字，整套「只有桌宠的存在」的设定就破了。
 */

/** 内部话术的替换表：先长后短（长的先替，免得被短的截胡）。 */
const REPLACEMENTS = [
  ['后台任务', '这件事'],
  ['后台的事', '这件事'],
  ['派出任务', '这件事'],
  ['后台', ''],
  ['派单', '安排'],
  ['派发', '安排'],
  ['派出去', '去做'],
  ['任务', '事情'],
  ['工具', ''],
  ['插件', ''],
  ['MCP', ''],
  ['<<META>>', ''],
];

/** 删空了之后说的那句。 */
export const SPEECH_FALLBACK = '这个我记下了。';
```

导出两个函数：

- `sanitizeSpeech(text, {toolNames = []})`：依次做「工具名替换 → 话术替换 → 收拾」，空了就返回 `SPEECH_FALLBACK`。
- `createSpeechFilter({toolNames = []})`：内部维护 `raw`（收到的原文）、`emitted`（已吐出的长度）。
  - `push(delta)`：`raw += delta` → 算出 `hold`（末尾可能是禁词前缀的那一段的长度）→ `stable = raw.slice(0, raw.length - hold)` → `safe = sanitizeSpeech(stable, {toolNames})` → 吐出 `safe.slice(emitted)` → 更新 `emitted = safe.length`。
  - `hold` 的算法：把 REPLACEMENTS 的词与 `toolNames` 收成一张「禁词表」，对每个词检查「`raw` 的末尾是不是它的前缀」，取最长的那个前缀长度（上限是词长减一）。
  - `finish()`：对完整的 `raw` 做一次 `sanitizeSpeech`，吐出 `safe.slice(emitted)`。
  - **注意**：`sanitizeSpeech` 在流里不能因为「删空了」就返回兜底句——流还没完。空结果在流里就返回空串，只有 `finish()` 时才用兜底句。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/layer-speech.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/assistant/layer/speech.js test/unit/layer-speech.test.js
git commit -m "feat(layer): 桌宠说话前的内部话术过滤器"
```

---

### Task 5: 交互层重做

交互层这一版只做三件事：**说话**（一次往返）、**知道自己在忙什么**（状态块）、**不漏内部话术**（接过滤器）。外部能力一件不留。

**Files:**
- Modify: `src/main/assistant/layer/prompt.js`（整份重写）
- Modify: `src/main/assistant/layer/interaction.js`（工具集、往返、状态块、过滤器、步数上限）
- Modify: `src/main/assistant/index.js`（接线）
- Delete: `src/main/assistant/layer/fastTools.js`
- Delete: `src/main/assistant/layer/capabilityTool.js`
- Delete: `test/unit/agent-capability-tool.test.js`
- Rewrite: `test/unit/agent-interaction.test.js`

**Interfaces:**
- Consumes: Task 1 的 `answerFromTool`、Task 2 的四个工具、Task 3 的 `lastStepLabel`、Task 4 的 `createSpeechFilter`。
- Produces:
  - `buildInteractionPrompt({persona = {}, facts = [], now = new Date(), taskStates = [], pluginNames = [], dispatchEnabled = true} = {}) → string`
    - `taskStates`：`[{taskId, title, status, lastStepLabel, elapsedMs}]`。
    - `pluginNames`：`string[]`（能干的活儿的名字，如「天气」「待办」）。
  - `createInteractionBackend({...})` 的选项变化：
    - **新增** `getTaskStates = () => []`（替代 `getTaskCounts`）。
    - **删除** `getSkills`（能力清单工具没了）。
    - `getRegistry`、`getPlugins`、`getTaskTools`、`getDispatchEnabled` 保留（`getRegistry` 只用来取工具名，给过滤器用）。
  - `INTERACTION_MAX_STEPS = 2`（从 3 改小）。

**新提示词的全文**（`buildInteractionPrompt` 的产物，逐字照抄）：

```
你是「{name}」，一只住在用户桌面上的 Live2D 桌宠。
性格：{style}
关于你：{backstory}

说话规则：
- 中文口语，1~3 句，不超过 80 字（报清单、报进展可以到 300 字）。
- 不要复述用户的问题，不要 Markdown，不要表情符号。
- 只说你自己：不要提任何工具名、函数名、插件名，也不要说「后台任务」「派单」「派发」「工具」这类词——用户只看得见你这个人。
{<<META 契约：沿用 chat/prompt.js 的 metaContractLines()>>}

你记得的事：
- {facts 每条一行}

现在是 {YYYY} 年 {M} 月 {D} 日 {HH}:{mm}。

你手头在做的事：
- {title}（{taskId}，{状态}，刚做完 {lastStepLabel}，用了 {elapsed}）
- …
（没有事做时这一段写「现在没有别的事在忙」。）

你能做的：
- 直接答：聊天、回答你知道的事、报上面那些事的状态。
- 其它一切（查文件、跑命令、用插件、上网找东西）都交给手头去做，你只说一声「我去」。

规矩：
- 先自己答一次：能答就别交出去。
- 要交出去的时候，调用「把一件事交出去」那个工具：要什么结果、什么算完成，写进 brief；你要说的话写进 reply。
- 交出去之后，做完了它会自己回来告诉你，你不用转述结果。
- 同一个要求别交两遍：上面写着的事、还有刚才交过的，都别重复。
- 用户问「某某怎么样了」：看「你手头在做的事」那一段直接答，别去调工具。
```

约束：

- **提示词里不许出现任何工具名**（连 `task.submit` 都不许）——工具名在工具表里，模型自己会看。
- 「你手头在做的事」最多列 5 条；超出的写「还有 N 件在排队」。
- 状态用中文短句：`进行中` / `排队中` / `等你点头`（沿用 `agent/record.js` 的 `TASK_STATUS_TEXT`）。
- 用时只在「进行中」「等你点头」时显示，格式沿用旧的 `formatElapsed`：`不到 1 秒` / `12 秒` / `3 分钟`（搬进 `layer/prompt.js`）。
- 「我能：」那行：`- 你能：{pluginNames 用、分隔}。`（`pluginNames` 为空就不写这一行）。

- [ ] **Step 1: 写失败测试**

重写 `test/unit/agent-interaction.test.js`（保留文件里「取消」「不是只读的工具当场报错」「没配 maxTokens」这几条与本任务无关的，其余换掉）：

```js
test('工具表：只有四个动作类工具，没有快工具也没有能力清单', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
    getTaskTools: () => [],
  });
  await backend.chat({ messages: [{ role: 'user', content: '你好' }], config: CONFIG });
  const names = calls[0].body.tools.map((t) => t.function.name);
  assert.deepEqual(names, []);
});

test('派单只走一次模型往返：工具带回的 reply 就是答复', async () => {
  const { calls, fetchImpl } = fakeFetch([
    toolCall('task.submit', { title: '查天气', brief: '查一下', reply: '我去看看' }),
  ]);
  const submitted = [];
  const backend = createInteractionBackend({
    fetchImpl,
    getTaskTools: () => [
      {
        name: 'task.submit',
        label: '开始做一件事',
        description: '把一件事交出去做',
        parameters: { type: 'object', properties: {} },
        risk: TOOL_RISK.READ,
        run: async (args) => {
          submitted.push(args);
          return { text: '派了', data: { answer: String(args.reply || '').trim() } };
        },
      },
    ],
  });
  const result = await backend.chat({
    messages: [{ role: 'user', content: '今天天气怎么样' }],
    config: CONFIG,
    turn: { userText: '今天天气怎么样', history: [] },
  });
  assert.equal(calls.length, 1, '派单不该问模型第二遍');
  assert.equal(result.text, '我去看看');
  assert.equal(submitted.length, 1);
});

test('reply 里带 META：正文剥掉 META，情绪与记忆留下', async () => {
  // reply = '我去看看<<META>>{"emotion":"happy","mood":5,"memories":[]}'
  // → result.text === '我去看看'，result.emotion === 'happy'
});

test('模型没写 reply：退回第二轮，让模型自己说', async () => {
  // 工具回的 data.answer 是空串 → 不短路 → 模型第二轮给答案。
  // 断言 calls.length === 2，且 result.text 是模型第二轮说的那句。
});

test('提示词：写着我手头在做的事，且没有工具名', async () => {
  const { calls, fetchImpl } = fakeFetch([say('你好。')]);
  const backend = createInteractionBackend({
    fetchImpl,
    getRegistry: () => fakeRegistry([listTool()]),
    getTaskStates: () => [
      {
        taskId: 't-1',
        title: '找 F 盘里的视频',
        status: 'running',
        lastStepLabel: '列目录',
        elapsedMs: 12000,
      },
    ],
  });
  await backend.chat({ messages: [{ role: 'user', content: '那个视频怎么样了' }], config: CONFIG });
  const system = calls[0].body.messages[0].content;
  assert.ok(system.includes('你手头在做的事'), system);
  assert.ok(system.includes('找 F 盘里的视频'), system);
  assert.ok(system.includes('列目录'), system);
  assert.ok(system.includes('t-1'), '任务号要留着，停任务时要用');
  assert.ok(!system.includes('fs.list'), '提示词里不许出现工具名');
  assert.ok(!system.includes('task.submit'), '提示词里不许出现工具名');
});

test('提示词：没有在做的事时写「现在没有别的事在忙」', async () => {
  // getTaskStates 返回 [] → 提示词里有这句。
});

test('话术：答复里的「后台任务」被过滤掉', async () => {
  // 模型说「我派了个后台任务去查」→ result.text 里没有「后台任务」「派单」。
});

test('maxTokens：交互层用下限 1024（工具参数不能被截断）', async () => {
  // config.maxTokens = 800 → 请求里的 max_tokens === 1024。
  // config.maxTokens = 4000 → 请求里的 max_tokens === 4000。
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/agent-interaction.test.js`
Expected: FAIL（工具表还是 10 个、派单还是两次往返、提示词还是旧的）

- [ ] **Step 3: 实现提示词**

重写 `src/main/assistant/layer/prompt.js`：

- 保留 `buildSystemPrompt` 里人设与 `metaContractLines()` 的用法：`metaContractLines` 从 `'../chat/prompt.js'` 导入，**格式不许另写一份**。
- 删掉现在整段「这活儿该你自己答，还是派后台任务」的分派规则、工具清单、插件清单、`capability.list` 的说明。
- 加上「你手头在做的事」「你能做的」「规矩」三段（照上面的全文）。
- 「你手头在做的事」的渲染：

```js
function taskLines(states) {
  const list = Array.isArray(states) ? states.filter(Boolean) : [];
  if (!list.length) return '现在没有别的事在忙。';
  const shown = list.slice(0, 5).map((t) => {
    const status = TASK_STATUS_TEXT[t.status] || '';
    const bits = [String(t.taskId || ''), status];
    if (t.lastStepLabel) bits.push(`刚做完 ${t.lastStepLabel}`);
    if (t.status === 'running' || t.status === 'waiting_approval') {
      bits.push(`用了 ${formatElapsed(t.elapsedMs)}`);
    }
    return `- ${t.title}（${bits.filter(Boolean).join('，')}）`;
  });
  const rest = list.length - shown.length;
  if (rest > 0) shown.push(`- 还有 ${rest} 件在排队`);
  return shown.join('\n');
}
```

（`TASK_STATUS_TEXT` 从 `'../agent/record.js'` 导入；`formatElapsed` 搬进这个文件。）

- [ ] **Step 4: 实现交互层**

改 `src/main/assistant/layer/interaction.js`：

1. `INTERACTION_MAX_STEPS` 改成 `2`。
2. 删掉 `createFastToolSet` 与 `createCapabilityTool` 的引入与用法；**删掉这两个文件**（`layer/fastTools.js`、`layer/capabilityTool.js`）。
3. 工具表只剩 `getTaskTools(turn)`（`dispatchEnabled` 为假时一个都不给）。
4. 循环加 `answerFromTool: true`。
5. 模型调用加下限：

```js
const callModel = createModelCaller({ fetchImpl, minMaxTokens: INTERACTION_MIN_MAX_TOKENS });
```

并在 `src/main/assistant/layer/interaction.js` 里定义 `export const INTERACTION_MIN_MAX_TOKENS = 1024;`（注释写清为什么是下限不是上限）。

6. 接过滤器：

```js
const speech = createSpeechFilter({ toolNames: toolNamesForFilter });
```

`toolNamesForFilter` = 这一轮四个工具的名字 + `registry?.list?.().map(t => t.name)`。
流式那段变成：

```js
onDelta: (delta) => {
  const out = splitter.push(delta);
  if (!out) return;
  const safe = speech.push(out);
  if (safe) onDelta(safe);
},
```

循环结束后 `const tail = splitter.finish(); if (tail) { const safe = speech.push(tail); if (safe) onDelta(safe); }`，再 `const tailSafe = speech.finish(); if (tailSafe) onDelta(tailSafe);`——**顺序不能错**，否则会漏掉最后一段。

7. 最终答复也要过滤：`const parsed = parseReply(run.text || '')` 之后，正文过一遍 `sanitizeSpeech(parsed.text, {toolNames})`；情绪/心情/记忆照旧从 `parsed` 取（`parseReply` 已经把 `<<META>>` 剥了）。
8. **META 的两级来源**：先看 `reply` 里带的 `<<META>>`（`parseReply(run.text)` 已经拆出来了）；没有就退回读**那一轮模型正文的 META**（模型调工具时常会顺带说一句「好的，我这就去」——那一轮的 `round.text` 里可能就带着 META）。两处都没有 → 情绪中性、不记记忆。实现上：循环的 `onRound` 回调拿到的 `round.text` 里若含 `<<META>>`，用 `parseReply` 拆出情绪/心情/记忆备着；`run.text` 里拆出来的优先。
8. 兜底路径 `rescueWithoutAnswer` 保留：它替用户派单时，调用 `submit.run({title, brief, reply: '我去查一下，结果出来告诉你。'})`——**新契约要求带 `reply`**。返回的答复用工具给的 `data.answer`。
9. 删掉 `getTaskCounts` 的用法，换成 `getTaskStates()`：

```js
const taskStates = getTaskStates() || [];
```

传给 `buildInteractionPrompt`。

- [ ] **Step 5: 接线**

改 `src/main/assistant/index.js` 里 `createInteractionBackend({...})` 的调用：

- `getTaskCounts: () => agentTasks.counts()` → `getTaskStates: () => agentTasks.list()`。
- 删掉 `getSkills: () => skillRegistry.list()`（能力清单工具没了）。
- `getPlugins` 改成只给**开着且接给后台任务**的插件，并且只取 `name`：

```js
getPlugins: () =>
  (getPlugins?.() || [])
    .filter((p) => p && p.enabled !== false && p.agentEnabled !== false)
    .map((p) => p.name),
```

（提示词要的是「名字」，不是整条插件记录。）

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test test/unit/agent-interaction.test.js test/unit/agent-two-layers.test.js`
Expected: PASS

（`agent-two-layers.test.js` 里若有依赖旧工具的断言，照新契约改。）

- [ ] **Step 7: 跑全套单元测试**

Run: `npm run test:unit`
Expected: 全部通过（若有旧断言失败，按新契约改测试，不要改回代码）

- [ ] **Step 8: 提交**

```bash
git add -A src/main/assistant/layer src/main/assistant/index.js test/unit/agent-interaction.test.js test/unit/agent-capability-tool.test.js
git commit -m "refactor(layer): 交互层只留四个动作工具，派单压到一次往返，状态写进提示词"
```

---

### Task 6: 派单记录与聊天记录页的文案

聊天记录页现在写的是「派了个后台任务：xxx」——这是 G3 的漏眼：用户在界面上看见了内部话术。

**Files:**
- Modify: `src/main/assistant/agent/record.js`（`dispatchRecord`）
- Modify: `plugins/chat-history/pages/format.js`（`dispatchLabel`）
- Test: `test/unit/agent-dispatch-record.test.js`、`test/unit/chat-history-format.test.js`

**Interfaces:**
- Consumes: `dispatchRecord({tool, taskId, title, action, brief, at})`。
- Produces: `dispatchRecord` 的 `text`（给人看的那行）格式：

```
开始做：{title} {taskId}
```

（`title` 为空时只留任务号；工具名**不进 text**，只留在 `meta.tool`。）

- [ ] **Step 1: 写失败测试**

`test/unit/agent-dispatch-record.test.js` 加：

```js
test('派单记录：可见文字是宠物的说法，工具名只留在 meta 里', () => {
  const rec = dispatchRecord({ tool: 'task.submit', taskId: 't-1', title: '找视频', action: '开始做：找视频' });
  assert.ok(!rec.text.includes('task.submit'), `工具名漏到界面上了：${rec.text}`);
  assert.ok(!/后台任务|派单|派发/.test(rec.text), `内部话术漏到界面上了：${rec.text}`);
  assert.ok(rec.text.includes('t-1'), '任务号要留着');
  assert.equal(rec.meta.tool, 'task.submit');
});
```

`test/unit/chat-history-format.test.js` 加：

```js
test('dispatchLabel：说的是宠物的说法', () => {
  assert.equal(dispatchLabel({ tool: 'task.submit', title: '找视频' }), '开始做：找视频');
  assert.equal(dispatchLabel({ tool: 'task.cancel', title: '找视频' }), '停掉了：找视频');
  assert.equal(dispatchLabel({ tool: 'task.delete', title: '找视频' }), '收起来了：找视频');
  assert.equal(dispatchLabel({ tool: 'task.steer', title: '找视频' }), '给那件事补了一句要求');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/agent-dispatch-record.test.js test/unit/chat-history-format.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

1. `src/main/assistant/agent/record.js` 的 `dispatchRecord`：`parts` 不再放工具名，改成 `[action, id]`：

```js
const parts = [String(action || '')];
if (id) parts.push(id);
```

`action` 由调用方（`layer/taskTools.js` 的 `record()`）给成宠物的说法：`开始做：{title}` / `停掉了：{title}` / `收起来了：{title}` / `给那件事补了一句要求`。**Task 2 已经在改 taskTools.js**，所以 `record()` 里的 `action` 字符串要一起改掉。

2. `plugins/chat-history/pages/format.js` 的 `dispatchLabel`：按上表改（`task.list` / `task.status` 的分支删掉——工具没了）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/agent-dispatch-record.test.js test/unit/chat-history-format.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/assistant/agent/record.js src/main/assistant/layer/taskTools.js plugins/chat-history/pages/format.js test/unit/agent-dispatch-record.test.js test/unit/chat-history-format.test.js
git commit -m "refactor: 派单记录改用宠物的说法，工具名不进界面"
```

---

### Task 7: 任务看板继续显示工具名

看板是排查用的调试面板，工具名要留着；人话标签改成悬停提示。

**Files:**
- Modify: `plugins/tasks/pages/board.js`（步骤时间线的渲染）
- Test: `test/e2e/tasks-plugin.spec.js`

**Interfaces:**
- Consumes: 步骤节点 `{tool, label, args, result}`（`label` 是 Task 3 加上去的友好标签）。
- Produces: 时间线上那格显示 **`tool`（工具名）**，并把 `label` 放进元素的 `title` 属性（悬停可见）。

- [ ] **Step 1: 写失败测试**

在 `test/e2e/tasks-plugin.spec.js` 里加一条：跑一个任务（用桩接口让后台任务调一次 `fs.list`），然后断言看板的时间线上**出现工具名 `fs.list`**，且那格的 `title` 是人话标签。

（这个 e2e 文件里已经有跑任务与看时间线的现成写法，照着加一条即可。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test test/e2e/tasks-plugin.spec.js`
Expected: FAIL（现在显示的是 label，Task 3 之后 label 有值了）

- [ ] **Step 3: 实现**

`plugins/tasks/pages/board.js` 里那行（现在是 `view.tool.textContent = node.label || node.tool;`）改成：

```js
view.tool.textContent = node.tool || node.label || '';
view.tool.title = String(node.label || '');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test test/e2e/tasks-plugin.spec.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add plugins/tasks/pages/board.js test/e2e/tasks-plugin.spec.js
git commit -m "feat(tasks): 看板步骤显示工具名，人话标签改成悬停提示"
```

---

### Task 8: 后台任务层的答复按桌宠口吻 + 情绪/记忆回传

后台任务的最终答复**就是桌宠回过来说的那句话**。现在它按 agent 的口径写，还会提工具名；而且它答复里的情绪与记忆被 `parseReply` 拆出来之后就扔掉了。

**Files:**
- Modify: `src/main/assistant/agent/prompt.js`（执行层系统提示词的「回答规则」）
- Modify: `src/main/assistant/agent/tasks.js`（完成回调把情绪与记忆交给通知路径）
- Modify: `src/main/assistant/index.js`（通知路径：情绪驱动表情、记忆并进长期记忆、文字过过滤器）
- Test: `test/unit/agent-prompt.test.js`

**Interfaces:**
- Consumes: `agentBackend.chat()` 返回的 `{text, emotion, mood, memories, ...}`（`chat/agent.js` 已经 `parseReply` 过了）。
- Produces: `agentTasks.submit()` 的完成回调调 `notify({title, text, ok, taskId, emotion, mood, memories})`——多了三个字段。

**执行层提示词里的「回答规则」整段换成**：

```
回答规则：
- 这是桌宠回给用户的一句话：中文口语，1~3 句，不超过 80 字。
- 只说结果和要点（「找到了，F 盘里有 3 个视频」），不要复述过程。
- 不要提任何工具名、函数名、插件名，也不要说「后台任务」「派单」「派发」这类词。
- 拿不准就照实说，别编。
```

- [ ] **Step 1: 写失败测试**

`test/unit/agent-prompt.test.js` 加：

```js
test('执行层提示词：答复按桌宠口吻，不许提工具名', () => {
  const sys = buildAgentSystemPrompt({ persona: {}, tools: [], skills: [] });
  assert.ok(sys.includes('这是桌宠回给用户的一句话'), sys);
  assert.ok(sys.includes('不要提任何工具名'), sys);
});

test('执行层提示词：用插件的工具之前要先读技能的说明书', () => {
  const sys = buildAgentSystemPrompt({ persona: {}, tools: [], skills: [{name:'weather',description:'问天气时用'}] });
  assert.ok(sys.includes('先读'), sys);
  assert.ok(sys.includes('skill.read'), sys);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/agent-prompt.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

1. `src/main/assistant/agent/prompt.js`：替换「回答规则」那一段（现在写的是「用中文口语回答，1~3 句，不超过 120 字：做了什么事、结果如何，一句带过。」）；把技能那句写硬：

```
要用某个技能时，先用 skill.read 读它的说明书，再动手——没读过就不许调这个插件的工具。
```

2. `src/main/assistant/agent/tasks.js`：`submit()` 里完成回调的两处 `notify({...})` 都带上 `emotion: result?.emotion || ''`、`mood: Number(result?.mood) || 0`、`memories: Array.isArray(result?.memories) ? result.memories : []`。

3. `src/main/assistant/index.js` 的 `notify`：
   - 文字过过滤器：`const text = sanitizeSpeech(String(text || ''), { toolNames })`（`toolNames` = `toolRegistry.list().map(t => t.name)`）。
   - 情绪：`onEmotion?.(emotion, mood)`（**注意**：`say()` 也会施加情绪，这里只能施加一次——`say()` 里传 `emotion: ''` 就好，情绪由这里单独施加）。
   - 记忆：`const picked = pickMemories(memories, { userText: '' }); if (picked.length) state.chat.facts = mergeFacts(state.chat.facts, picked);`
   - 写进聊天记录的文字用**过滤后**的那份（模型下一轮会读到自己说过的话）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/unit/agent-prompt.test.js test/unit/agent-tasks.test.js test/unit/agent-runtime-tasks.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/assistant/agent/prompt.js src/main/assistant/agent/tasks.js src/main/assistant/index.js test/unit/agent-prompt.test.js
git commit -m "feat(agent): 后台任务的答复按桌宠口吻，情绪与记忆回传给桌宠"
```

---

### Task 9: 切「只聊天」——先确认，再停掉在跑的任务

**Files:**
- Modify: `src/shared/assistant.js`（`DISPATCH_MODE_INFO.off.hint`）
- Modify: `src/main/assistant/agent/tasks.js`（新增 `cancelAll()`）
- Modify: `src/main/assistant/index.js`（`update()` 里停任务）
- Modify: `src/main/ipc.js`（新增 `pet:confirmDispatchOff` 通道）
- Modify: `src/main/index.js`（确认框的实现与注册）
- Modify: `src/preload/index.cjs`（暴露 `confirmDispatchOff`）
- Modify: `src/settings/main.js`（切过去之前先问）
- Test: `test/unit/agent-tasks.test.js`、`test/e2e/agent-settings.spec.js`

**Interfaces:**
- Produces:
  - `agentTasks.cancelAll() → {stopped: number}`：把所有**未结束**的任务（`running` / `queued` / `waiting_approval`）停掉，返回停掉几个。**已经结束的任务不动。**
    （放在任务中枢里而不是 `assistant/index.js`：`agent/tasks.js` 不引 electron，能单测；`index.js` 引了 `powerMonitor`，单测碰不到。）
  - `createAssistant(...).update(patch)`：当 `agent.dispatch` 从非 `off` 变成 `off` 时调一次 `agentTasks.cancelAll()`。返回的 state 不变。
  - IPC `pet:confirmDispatchOff` → 返回 `{ok: true, confirmed: boolean}`（用户点「确定」为 `true`）。
  - preload 的 `window.pet.confirmDispatchOff()` → 返回 `{ok, confirmed}`。

**确认框文案**（`dialog.showMessageBox`）：

```js
{
  type: 'warning',
  title: '切到只聊天',
  message: '切到「只聊天」后，桌宠不再接新活，正在做的事也会停下来。',
  detail: '已经派出去的事会被停掉。',
  buttons: ['取消', '切到只聊天'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
}
```

**设置页文案**（`DISPATCH_MODE_INFO.off.hint`）换成：

```
'桌宠只跟你聊天：不查本机、不翻文件、不跑命令，什么都不替你做。'
```

- [ ] **Step 1: 写失败测试**

在 `test/unit/agent-tasks.test.js` 里加（这个文件已经有造任务中枢的现成写法，照它写）：

```js
test('cancelAll：未结束的任务全被停掉', async () => {
  // 造三个任务：一个 running、一个 queued、一个 done。
  // 调 cancelAll() → 返回 {stopped: 2}；
  // 那两个未结束的任务状态变成 'cancelled'，那个 done 的仍然是 'done'。
});

test('cancelAll：没有任务时返回 stopped: 0', () => {
  // 空的任务中枢 → {stopped: 0}，不抛错。
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/unit/agent-tasks.test.js`
Expected: FAIL（`cancelAll` 不存在）

- [ ] **Step 3: 实现主进程那半**

1. `src/main/assistant/agent/tasks.js`：在返回的对象里加 `cancelAll()`——遍历 `runtime.list()`，跳过终态（`done` / `failed` / `cancelled` / `interrupted`），其余调 `runtime.cancel(task.id)`，返回 `{stopped: n}`。

2. `src/main/assistant/index.js` 的 `update(patch)`：在算出 `next` 之后、`state = sanitizeAssistant(next)` 之前，加：

```js
// 切到「只聊天」：手上有活就停掉。
// 这是唯一的收口——不管这个改动从哪条路来（设置页、插件、代码），都会停。
const wasDispatch = state?.agent?.dispatch;
if (wasDispatch !== 'off' && next?.agent?.dispatch === 'off') {
  agentTasks.cancelAll();
}
```

2. `src/main/ipc.js`：在 `registerIpc({...})` 的参数表里加 `confirmDispatchOff`，并注册：

```js
ipcMain.handle('pet:confirmDispatchOff', (event) => confirmDispatchOff(event));
```

3. `src/main/index.js`：写 `confirmDispatchOff(event)`——**照 `deleteModel` 的写法**（校验发起方是不是设置窗口、`dialog.showMessageBox` 用设置窗口当父窗口、返回 `{ok, confirmed}`）。确认框文案照上面的。

4. `src/main/index.js` 的 `registerIpc({...})` 里加 `confirmDispatchOff: (event) => confirmDispatchOff(event),`。

5. `src/preload/index.cjs` 加：

```js
// 切到「只聊天」前问一句：正在做的事会被停掉。
confirmDispatchOff: () => ipcRenderer.invoke('pet:confirmDispatchOff'),
```

- [ ] **Step 4: 实现设置页那半**

`src/settings/main.js`：

- 记下上一个值：`let dispatchModeValue = llmDispatchSelect.value;`（init 时同步）。
- 改 `change` 处理器：

```js
llmDispatchSelect.addEventListener('change', async () => {
  const next = llmDispatchSelect.value;
  if (next === 'off') {
    const res = await window.pet.confirmDispatchOff?.();
    if (!res?.confirmed) {
      // 用户不点头：下拉框退回原来的值，什么都不改。
      llmDispatchSelect.value = dispatchModeValue;
      updateDispatchHint();
      return;
    }
  }
  dispatchModeValue = next;
  updateDispatchHint();
  persistAssistantPrefs();
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/unit/agent-tasks.test.js` → PASS
Run: `npm run test:unit` → 全部通过

- [ ] **Step 6: 端到端**

在 `test/e2e/agent-settings.spec.js` 里加一条：把派单模式下拉框切到「只聊天」→ 断言原生确认框出现（`electronApp` 的 `window` 上能看到对话框；这个 e2e 文件里已有弹原生框的写法就照它写，没有就只断言「切过去之后设置里存的是 off」）。

Run: `npx playwright test test/e2e/agent-settings.spec.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/shared/assistant.js src/main/assistant/agent/tasks.js src/main/assistant/index.js src/main/ipc.js src/main/index.js src/preload/index.cjs src/settings/main.js test/unit/agent-tasks.test.js test/e2e/agent-settings.spec.js
git commit -m "feat(settings): 切到只聊天先确认，确认后停掉在跑的任务"
```

---

### Task 10: 插件技能说明改成「什么时候用」

技能的三级渐进披露结构不动，改的是**第一级**：说明要写成「什么时候该用它」，模型据此判断要不要读正文。

**Files:**
- Modify: `plugins/weather/plugin.json`、`plugins/todos/plugin.json`、`plugins/reminders/plugin.json`、`plugins/pomodoro/plugin.json`、`plugins/system/plugin.json`（`skill.description`）
- Modify: 上面五个插件的 `skill.md`（补一句「什么时候用」）
- Modify: `docs/开发说明/插件开发指南.md`（`skill` 段补约定）
- Test: `test/e2e/plugin-agent.spec.js`

**五个技能的新说明**（照抄）：

| 插件 | `skill.description` |
|---|---|
| weather | `用户问天气、气温、要不要下雨、下不下雪、热不热的时候用它` |
| todos | `用户要记待办、要买菜、要列自己还有什么没做的时候用它` |
| reminders | `用户要设提醒、闹钟、别忘了某件事的时候用它` |
| pomodoro | `用户要专注、要休息、要开始或结束一段计时的时候用它` |
| system | `用户问电脑状态、CPU、内存、温度、GPU、磁盘的时候用它` |

**`skill.md` 补的那一句**（每个插件开头加一行「## 什么时候用」）：照上表的说明写成一两句人话。

**开发者指南**（`docs/开发说明/插件开发指南.md` 的 `skill` 段）在 `description` 那一行的说明里补一句：

> `description` 写**什么时候该用它**，不是「它是什么」——模型只看这一行决定要不要读正文。

并补一句：

> 模型要用你这个插件的工具之前，会先读 `skill.md`。所以正文里要写清楚**用法与顺序**，不写「这个工具干什么」（那是工具 `description` 的活）。

- [ ] **Step 1: 端到端断言**

在 `test/e2e/plugin-agent.spec.js` 里加一条断言：后台任务的系统提示词里，技能的说明是「什么时候用」那一类（不含「查当前天气，以及设置默认城市」这种功能描述）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test test/e2e/plugin-agent.spec.js`
Expected: FAIL

- [ ] **Step 3: 实现**

改五个 `plugin.json` 的 `skill.description`、五个 `skill.md` 的开头、开发者指南那一段。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test test/e2e/plugin-agent.spec.js` → PASS
Run: `npm run test:unit` → 全部通过

- [ ] **Step 5: 提交**

```bash
git add plugins/weather plugins/todos plugins/reminders plugins/pomodoro plugins/system "docs/开发说明/插件开发指南.md" test/e2e/plugin-agent.spec.js
git commit -m "docs(plugin): 技能说明改成「什么时候用」"
```

---

### Task 11: 端到端测试对齐 + 全套跑通

前面的任务各自带走了自己的 e2e；这一条收尾：把两个受影响的 e2e 对齐到新契约，然后跑全套。

**Files:**
- Modify: `test/e2e/plugin-agent.spec.js`（断言里有 `capability.list` 与「你装着的插件：」——工具删了必然失败）
- Modify: `test/e2e/two-layer-agent.spec.js`（派单路径与提示词断言）
- Test: 全部

**Interfaces:**
- Consumes: Task 1~10 的全部改动。
- Produces: 无新接口。

- [ ] **Step 1: 跑端到端，看哪些挂了**

Run: `npx playwright test`
Expected: FAIL，失败集中在 `plugin-agent.spec.js` 与 `two-layer-agent.spec.js`

- [ ] **Step 2: 对齐断言**

1. `plugin-agent.spec.js`：删掉「交互层工具表里有 `capability.list`」与「提示词里含 `capability.list` /『你装着的插件：』」两条断言；改成断言交互层的工具表**只有**四个 `task.*`，且提示词里有「你手头在做的事」段。
2. `two-layer-agent.spec.js`：
   - 派单那条：现在只发一次模型请求（桩接口按 `task.submit` 的工具表分辨前后台，那套机制不变），断言前台那句就是工具给的 `reply`。
   - 提示词断言：改成新提示词里的句子。

- [ ] **Step 3: 跑端到端确认通过**

Run: `npx playwright test`
Expected: PASS

- [ ] **Step 4: 跑全套**

Run: `npm test`
Expected: 单元与端到端全过

- [ ] **Step 5: 提交**

```bash
git add test/e2e/plugin-agent.spec.js test/e2e/two-layer-agent.spec.js
git commit -m "test(e2e): 对齐交互层的新工具集与一次往返"
```

---

## 附：全流程自查表

实现完按这个走一遍，对着真机点一遍：

| # | 做什么 | 期望看到 |
|---|---|---|
| 1 | 对桌宠说「你好」 | 一句话，没有工具名、没有「后台任务」 |
| 2 | 对桌宠说「今天天气怎么样」 | 桌宠说「我去看看」类的过渡句；**只发一次模型请求**（看主进程日志） |
| 3 | 等后台任务做完 | 桌宠自己开口汇报结果，短、像人话、不提工具名 |
| 4 | 问「刚才那个怎么样了」 | 立刻答，**没有工具调用** |
| 5 | 问「你能干什么」 | 答得出（提示词里的「我能：……」那行） |
| 6 | 让它读一个文件 | 走后台任务，前台只回一句话 |
| 7 | 在设置里切到「只聊天」 | 弹确认框；点取消则下拉框退回原值；点确定则在跑的任务变成「已取消」 |
| 8 | 翻聊天记录页 | 派单那几行写的是「开始做：xxx」，步骤写的是人话（不是 `fs.list`） |
| 9 | 看任务看板 | 时间线上显示的是工具名（`fs.list`），悬停能看到人话 |
