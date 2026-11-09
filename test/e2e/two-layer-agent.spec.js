// 双层 agent 的端到端验证。
//
// 盯的是四件事（规格 §11.2）：
//   1. **派单 → 完成通知**：用户发一句要动手的话，桌宠先应一句，
//      做完再冒出一条结果；
//   2. **中途搭话不丢结果**：任务跑着的时候用户又说话，
//      两句答复都要在（这是旧版最硬的那条 bug）；
//   3. **说「停掉刚才那个」**：任务真的停了；
//   4. **模型不认工具**：退回普通对话，而且把这件事告诉用户。
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

// 退回普通对话时要对用户说的那句话（规格 §10.4）。
//
// **从源码里取**，不在这儿抄一份：抄的那份会跟改坏的那份一起悄悄过期。
import { FALLBACK_NOTICE } from '../../src/main/assistant/layer/foreground.js';

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
 *
 * **处理器可以回「出错」**：回 `{ status, body }` 就按那个状态码与原文回，
 * 不用回正常响应。用来造「模型不认工具调用」那种 400（规格 §10.4 的退路）。
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
      // 回 `{ status, body }` = 这个请求要出错。
      const isError = Boolean(reply) && typeof reply === 'object' && 'status' in reply;
      const wait = isExecution ? executionDelayMs : delayMs;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (isError) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(String(reply.body ?? ''));
          return;
        }
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

      // **这一轮是两轮**：派单占一轮、答复占一轮。
      //
      // **按分类挑记录，不按文案挑**：文案一改，断言就变成「找不到记录」，
      // 报错指错方向。前台答复是唯一「kind 为 reply 且没有任务号」的那条。
      const reply = await waitForState((s) => {
        const list = (s?.chat?.messages || []).filter(
          (m) => m.kind === 'reply' && !m.meta?.taskId
        );
        return list[list.length - 1] || null;
      });
      expect(reply, '状态文件里没有前台答复的记录').toBeTruthy();
      expect(reply.meta.rounds, `轮数不对：${JSON.stringify(reply.meta)}`).toBe(2);
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('任务跑着的时候用户又说话：两句答复都在', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const msgs = body.messages || [];
        const last = msgs.at(-1) || {};
        // 轮内的后续调用（工具结果刚回来）：给个答复。
        if (last.role === 'tool') return say('我去看看。');
        // **按用户那句话分辨**：插话那句直接答，其余派单。
        //
        // 以前这里是「请求里有没有 role:'tool' 的消息」——
        // 可历史里根本没有 tool 消息（只有 user/assistant），
        // 于是插话那句也被当成派单，派出第二个任务：
        // 「查完了」就不知道是哪个任务的结果，这条用例也白写了。
        const asked = String(last.content || '');
        if (asked.includes('顺便')) return say('顺便说一句。');
        return toolCall('task.submit', { title: '查视频', brief: '看看' });
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
        () => (window.__seen || []).some((t) => t.includes('顺便说一句')),
        null,
        { timeout: 30000 }
      );
      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('查完了')),
        null,
        { timeout: 30000 }
      );
      const seen = await bubble.evaluate(() => window.__seen);

      // **三句都在**：派单的答复、插话的答复、任务的结果。
      expect(seen.some((t) => t.includes('我去看看')), `派单的答复丢了：${JSON.stringify(seen)}`).toBe(true);
      expect(seen.some((t) => t.includes('顺便说一句')), `插话的答复丢了：${JSON.stringify(seen)}`).toBe(true);
      expect(seen.some((t) => t.includes('查完了')), `任务的结果丢了：${JSON.stringify(seen)}`).toBe(true);

      // **只派了一个任务**：插话那句不该再派一个单。
      // 不钉住这个，「查完了」就不知道是哪个任务的结果，
      // 上面的断言也就跟着含糊了。
      const state = await readState();
      const dispatches = (state?.chat?.messages || []).filter((m) => m.kind === 'dispatch');
      expect(dispatches.length, `不该派出第二个任务：${JSON.stringify(dispatches)}`).toBe(1);
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
      //
      // **查记录，不查气泡**：失败通知要是真来了，会排在 15 秒的
      // 聊天回复后面（气泡一次只显示一条）——那时候它还没上屏，
      // 断言气泡等于什么都没断言。记录才是证据：通知是**先写记录、
      // 再说话**的，所以记录里有就说明它说过了。
      // 落盘有 300ms 的防抖，给它一点时间。
      await new Promise((r) => setTimeout(r, 1500));
      const state = await readState();
      const failures = (state?.chat?.messages || []).filter((m) =>
        String(m.text || '').includes('没做成')
      );
      expect(
        failures.map((m) => m.text),
        '取消的任务不该记一条「没做成」'
      ).toHaveLength(0);
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('前台答复的记录：带轮数与模型名', async () => {
    const stub = await startStubLlm({
      interaction: () => say('这条答复带了轮数。'),
      execution: () => say('不该走到的执行层。'),
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '记录一下');
      await panel.press('#query', 'Control+Enter');

      // **只挑前台答复那一条**：状态文件里还有别的 assistant 记录
      // （派单、任务状态、完成通知、模型原话），它们不是这一轮。
      // 前台答复是唯一「kind 为 reply 且没有任务号」的那条——
      // **不按文案挑**：桩文案一改，断言就变成「找不到记录」，报错指错方向。
      const reply = await waitForState((s) => {
        const list = (s?.chat?.messages || []).filter(
          (m) => m.kind === 'reply' && !m.meta?.taskId
        );
        return list[list.length - 1] || null;
      });
      expect(reply, '状态文件里没有前台答复的记录').toBeTruthy();

      expect(reply.meta.rounds, `轮数不对：${JSON.stringify(reply.meta)}`).toBe(1);
      expect(reply.meta.model, `模型名不对：${JSON.stringify(reply.meta)}`).toBe('stub-model');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('模型不认工具：退回普通对话，而且告诉用户', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const asked = String(body.messages?.at(-1)?.content || '');
        // 这个模型不认工具调用：回 400，**原文里提到工具**。
        // （要提到工具，主进程才认得出这是「不支持工具」而不是别的错——
        //  上下文超长、key 不对也都是 400。）
        if (asked.includes('工具')) {
          return {
            status: 400,
            body: '{"error":{"message":"tools are not supported by this model"}}',
          };
        }
        return say('你好。');
      },
      // 退回之后走的是**普通对话**（请求里不带 tools），
      // 桩接口把它当执行层那支处理，回一句普通答复。
      execution: () => say('普通对话的答复。'),
      executionDelayMs: 1500,
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      // **先来一句普通的**：把气泡窗口开出来、等它就绪。
      // 不然那句「退回」的话可能赶上气泡页还没加载完，
      // 跟答案挤在同一次补发里——它一闪就没了，压根测不出来。
      await panel.fill('#query', '你好');
      await panel.press('#query', 'Control+Enter');

      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 10000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');
      await recordBubble(bubble);
      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('你好')),
        null,
        { timeout: 30000 }
      );

      // 这一句模型不认工具：接口回 400。
      await panel.fill('#query', '你支持工具调用吗');
      await panel.press('#query', 'Control+Enter');

      await bubble.waitForFunction(
        (notice) => (window.__seen || []).some((t) => t.includes(notice)),
        FALLBACK_NOTICE,
        { timeout: 30000 }
      );
      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('普通对话的答复')),
        null,
        { timeout: 30000 }
      );
      const seen = await bubble.evaluate(() => window.__seen);

      // **气泡上真的出现了那句退回的话**（规格 §10.4：用户被告知）。
      expect(
        seen.some((t) => t.includes(FALLBACK_NOTICE)),
        `气泡上没有那句退回的话：${JSON.stringify(seen)}`
      ).toBe(true);
      // 也真的按普通对话答了。
      expect(
        seen.some((t) => t.includes('普通对话的答复')),
        `没有普通对话的答复：${JSON.stringify(seen)}`
      ).toBe(true);
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
