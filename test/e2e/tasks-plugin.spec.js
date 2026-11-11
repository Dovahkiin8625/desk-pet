// 后台任务插件的端到端验证（规格 §5 T3/T4、§6）。
//
// 验的是**用户在任务界面上真能办的事**：
// - 看板上看得见派出去的任务与它的状态；
// - 在看板上答「允许」→ 工具真的执行了（文件写出来了）；
// - 在看板上把任务停掉；
// - 归档后任务从板上消失，但记录还留着；
// - 小部件窗口能开出来，显示同一份数据。
//
// 桩模型照 approval-bubble.spec.js 那一套：
// 靠**请求里的工具表**分辨交互层与执行层（交互层带 task.submit）。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-tasks');
/** 工作区：审批放行之后，文件写到这里。 */
const WORKSPACE = join(ROOT, '.tmp-e2e-tasks-workspace');

/**
 * 桩接口。
 *
 * @param {object} options
 * @param {Function} options.interaction 交互层（带着 task.submit 的那一层）
 * @param {Function} options.execution 执行层
 * @param {number} [options.executionDelayMs] 执行层慢一拍
 */
async function startStubLlm({ interaction, execution, executionDelayMs = 1500 }) {
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
      // 执行层可以「不吭声」：任务就一直跑着，够我们点「停掉」。
      if (isExecution && execution === null) return;
      const reply = isExecution ? execution(body) : interaction(body);
      const wait = isExecution ? executionDelayMs : 50;
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

/** 摆一份助理状态：对话开着、语音关着、能派单、工作区指着临时目录。 */
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
        // 审批策略是 graded：只读放行，写入要问——
        // 所以执行层写文件时一定会弹审批。
        agent: { dispatch: 'auto', workspace: WORKSPACE },
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
      try {
        if (w.url().includes(part)) return w;
      } catch {
        /* 窗口刚关掉 */
      }
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

/** 在面板里搜到「后台任务」并打开它，返回装着插件页面的 iframe。 */
async function openTasksPlugin(panel) {
  await panel.fill('#query', '后台任务');
  await panel.waitForFunction(() => window.__panel?.resultIds?.includes('tasks'), null, {
    timeout: 10000,
  });
  await panel.click('#results li:has-text("后台任务")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'tasks', null, { timeout: 10000 });
  return panel.frameLocator('#plugin-frame');
}

/** 读工作区里的文件（没有就返回 null）。 */
async function readWorkspaceFile(name) {
  try {
    return await readFile(join(WORKSPACE, name), 'utf8');
  } catch {
    return null;
  }
}

/** 读助理状态文件。 */
async function readState() {
  try {
    return JSON.parse(await readFile(join(USER_DATA, 'assistant.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 等工作区里出现某个文件（最多等这么久）。 */
async function waitForFile(name, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readWorkspaceFile(name);
    if (content !== null) return content;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

test.describe('后台任务插件', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  test('在任务界面上答「允许」：工具真的执行了', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '写个文件', brief: '在工作区写一个 note.txt' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('写好了。');
        return toolCall('fs.write', { path: 'note.txt', content: '任务界面放行的内容' });
      },
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '在工作区写个 note.txt');
      await panel.press('#query', 'Control+Enter');

      // 任务界面里看得见这个任务：状态是「等你点头」。
      const frame = await openTasksPlugin(panel);
      const row = frame.locator('#running .row[data-task]').first();
      await expect(row).toBeVisible({ timeout: 30000 });
      await expect(row.locator('.row-status')).toHaveText('等你点头');

      // 待答的审批也在看板上（它与桌宠气泡是同一份队列）。
      const card = frame.locator('#pending .card').first();
      await expect(card).toBeVisible();
      await expect(card.locator('.card-text')).toContainText('写文件');

      // 在**任务界面**上点「允许」。
      await card.locator('button[data-decision="allow"]').click();

      // 文件真的写了。
      const content = await waitForFile('note.txt');
      expect(content, '在任务界面上点了「允许」但文件没有写').toBe('任务界面放行的内容');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('在任务界面上把任务停掉', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '慢慢查', brief: '慢慢查点东西' });
      },
      // 执行层不吭声：任务一直跑着，够我们点「停掉」。
      execution: null,
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '慢慢查点东西');
      await panel.press('#query', 'Control+Enter');

      const frame = await openTasksPlugin(panel);
      const row = frame.locator('#running .row[data-task]').first();
      await expect(row).toBeVisible({ timeout: 30000 });

      await row.locator('button[data-act="cancel"]').click();
      await expect(frame.locator('#message')).toHaveText('停掉了');

      // 停掉的任务落到「已结束」那一栏。
      const finished = frame.locator('#finished .row[data-task]').first();
      await expect(finished).toBeVisible({ timeout: 10000 });
      await expect(finished.locator('.row-status')).toHaveText('已取消');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('归档后任务从板上消失，记录还留着', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '查完了', brief: '查点东西' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('查完了。');
        return say('查完了。');
      },
      executionDelayMs: 300,
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '查点东西');
      await panel.press('#query', 'Control+Enter');

      const frame = await openTasksPlugin(panel);
      const finished = frame.locator('#finished .row[data-task]').first();
      await expect(finished).toBeVisible({ timeout: 30000 });
      const taskId = await finished.getAttribute('data-task');

      await finished.locator('button[data-act="archive"]').click();
      await expect(frame.locator('#message')).toHaveText('归档了');
      await expect(frame.locator('#finished .row[data-task]')).toHaveCount(0);

      // 记录还留着（归档只是把它从列表里收起来）。
      await new Promise((r) => setTimeout(r, 1000));
      const state = await readState();
      const records = (state?.chat?.messages || []).filter(
        (m) => m.kind === 'task' && m.meta?.taskId === taskId
      );
      expect(records.length, '归档后记录不见了').toBeGreaterThan(0);
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('小部件窗口能开出来，显示同一份数据', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '慢慢查', brief: '慢慢查点东西' });
      },
      execution: null,
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '慢慢查点东西');
      await panel.press('#query', 'Control+Enter');

      const frame = await openTasksPlugin(panel);
      await expect(frame.locator('#running .row[data-task]').first()).toBeVisible({ timeout: 30000 });

      // 变成桌面小部件：页面原样加载，壳不参与。
      await panel.evaluate(() => document.querySelector('#widget')?.click());
      const widget = await findWindow(app, 'plugins/tasks/pages/board.html');
      expect(widget, '小部件窗口没有出现').toBeTruthy();
      await widget.waitForLoadState('domcontentloaded');

      await expect(widget.locator('#running .row[data-task]').first()).toBeVisible({ timeout: 30000 });
      // 小部件是紧凑版：按钮那些不画。
      await expect(widget.locator('#running .row-actions')).toBeHidden();

      // 小部件自己能收起：头上那个 ✕ 就是干这个的。
      const close = widget.locator('#widget-close');
      await expect(close).toBeVisible();
      await close.click();
      await expect.poll(() => widget.isClosed(), { timeout: 10000 }).toBe(true);
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
