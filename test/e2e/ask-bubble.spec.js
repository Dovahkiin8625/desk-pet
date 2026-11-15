// 「后台任务向用户确认」的端到端验证。
//
// 盯的是**整条链**：后台任务拿不准 → 调问用户那个工具 →
// 桌宠旁边的气泡弹出一张选择卡 → 用户点一个 →
// 那个选择**回到模型手里**（模型才知道该往哪走）。
//
// 桩接口靠**请求里的工具表**分辨是哪一层：
// 前台带着 task.run，后台不带。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-ask-bubble');

/** 桩接口：记下每一次请求，断言「模型收到什么」要看它们。 */
async function startStubLlm({ interaction, execution }) {
  const timers = new Set();
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const names = (body.tools || []).map((t) => t?.function?.name || '');
      const isExecution = !names.includes('task.run');
      seen.push({ isExecution, body });
      const reply = isExecution ? execution(body) : interaction(body);
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }, 50);
      timers.add(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
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

/** 等气泡里出现选择卡的选项。 */
async function waitForOptions(bubble, timeoutMs = 30000) {
  await bubble.waitForSelector('#actions button[data-choice]', { timeout: timeoutMs });
  return bubble.evaluate(() =>
    Array.from(document.querySelectorAll('#actions button[data-choice]')).map((b) => ({
      choice: b.dataset.choice,
      text: b.textContent.trim(),
    })),
  );
}

test.describe('后台任务向用户确认', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('拿不准就问一句：气泡里选的那个回到模型手里', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.run', {
          goal: '打开音乐播放器',
          done_when: '音乐播放器的界面打开了',
        });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('好嘞。');
        return toolCall('ask.user', {
          question: '你是要打开音乐播放器的面板，还是要放首歌？',
          options: ['打开面板', '放首歌'],
        });
      },
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '帮我打开音乐播放器');
      await panel.press('#query', 'Control+Enter');

      // 选择卡在**独立的气泡窗口**里：按 URL 找，不是主窗口里的元素。
      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 20000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');

      const options = await waitForOptions(bubble);
      // 按代码点排（不是拼音）：「打」在「放」前面。
      expect(
        options.map((o) => o.choice).sort(),
        `选项不是两个：${JSON.stringify(options)}`
      ).toEqual(['打开面板', '放首歌']);
      // 问题要摆出来：用户得知道自己在选什么。
      expect(await bubble.textContent('#text')).toContain('音乐播放器');

      // 用户点一个。
      await bubble.click('#actions button[data-choice="放首歌"]');

      // **那个选择回到模型手里**：模型才知道该往哪走。
      const deadline = Date.now() + 15000;
      let toolText = '';
      while (Date.now() < deadline) {
        const round = stub.seen.filter((s) => s.isExecution).at(-1);
        const msg = (round?.body?.messages || []).find((m) => m.role === 'tool');
        if (msg) {
          toolText = String(msg.content || '');
          if (toolText.includes('放首歌')) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(toolText, '模型没有收到用户的选择').toContain('放首歌');
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
