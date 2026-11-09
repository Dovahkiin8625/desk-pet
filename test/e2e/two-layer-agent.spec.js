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
        { timeout: 30000 }
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
        { timeout: 30000 }
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
        { timeout: 30000 }
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
