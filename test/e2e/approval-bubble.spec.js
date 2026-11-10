// 审批气泡的端到端验证（规格 §8.2、§14 T20）。
//
// 盯的是**用户点得到**这件事：
// 审批气泡是**独立窗口**，按钮是动态生成的四个——
// 允许 / 拒绝 / 自动 / 取消任务。
//
// **按实现的四个写**，别照着规格 §8.2 的表格只测三个：
// 第四个「取消任务」是规格正文提到、表格漏掉的。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-approval');
/** 工作区：审批放行之后，文件写到这里。 */
const WORKSPACE = join(ROOT, '.tmp-e2e-approval-workspace');

/**
 * 桩接口。
 *
 * 靠**请求里的工具表**分辨是哪一层：
 * 交互层带着 task.submit，执行层不带。
 *
 * **执行层慢一拍**（`executionDelayMs`）：前台那句「我去看看」先说完，
 * 执行层才来要授权。
 * 这是**真实世界的顺序**——执行层要先跑一轮模型才决定调哪个工具，
 * 而前台答复在派单那一刻就说了。
 * 顺序反过来会踩到一个坑：开流会作废挂着的审批（见 bubble.js 的 openStream），
 * 那是气泡的既定规矩，不是这里要测的东西。
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
        // **审批策略是 graded**：只读放行，写入要问——
        // 所以执行层写文件时一定会弹审批气泡。
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

/** 等气泡里出现审批按钮。 */
async function waitForApprovalButtons(bubble, timeoutMs = 30000) {
  await bubble.waitForSelector('#actions button[data-decision]', { timeout: timeoutMs });
  return bubble.evaluate(() =>
    Array.from(document.querySelectorAll('#actions button')).map((b) => ({
      decision: b.dataset.decision,
      text: b.textContent.trim(),
    }))
  );
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

test.describe('审批气泡', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  test('四个按钮都在，点「允许」之后文件真的写了', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '写个文件', brief: '在工作区写一个 note.txt' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        // 工具结果回来了：说明审批放行了，文件写完了。
        if (last.role === 'tool') return say('写好了。');
        return toolCall('fs.write', { path: 'note.txt', content: '审批放行的内容' });
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

      // 审批气泡是**独立窗口**：按 URL 找，不是主窗口里的元素。
      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 20000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');

      const buttons = await waitForApprovalButtons(bubble);
      // **四个按钮**：允许 / 拒绝 / 自动 / 取消任务。
      expect(
        buttons.map((b) => b.decision).sort(),
        `审批按钮不是四个：${JSON.stringify(buttons)}`
      ).toEqual(['allow', 'always', 'cancel', 'deny']);
      // 说明文字要说清要干什么（用户得知道自己在批准什么）。
      const text = await bubble.textContent('#text');
      expect(text, '审批气泡没写清要干什么').toContain('写文件');

      // 点「允许」：这一次放行。
      await bubble.click('#actions button[data-decision="allow"]');

      // **文件真的写了**：放行之后工具才跑。
      const deadline = Date.now() + 20000;
      let content = null;
      while (Date.now() < deadline) {
        content = await readWorkspaceFile('note.txt');
        if (content !== null) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(content, '点了「允许」但文件没有写').toBe('审批放行的内容');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('点「拒绝」：文件不写，模型收到「不给」', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '写个文件', brief: '在工作区写一个 note.txt' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('没写成。');
        return toolCall('fs.write', { path: 'note.txt', content: '不该写进去的内容' });
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

      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 20000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');
      await waitForApprovalButtons(bubble);

      await bubble.click('#actions button[data-decision="deny"]');

      // 等任务走完（拒绝之后模型会收到「不给」，然后收尾）。
      await new Promise((r) => setTimeout(r, 3000));
      expect(await readWorkspaceFile('note.txt'), '拒绝了却还是写了文件').toBeNull();

      // **「拒绝」要喂回模型**：模型才知道换个参数再试，
      // 而不是任务直接死掉（规格 §8）。
      const state = await readState();
      const step = (state?.chat?.messages || []).find(
        (m) => m.kind === 'step' && m.meta?.tool === 'fs.write'
      );
      expect(step, '状态文件里没有 fs.write 这一步').toBeTruthy();
      expect(step.meta.error, '拒绝没有喂回模型').toContain('拒绝');
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
