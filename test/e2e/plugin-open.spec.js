// 「发一句话打开某个插件面板」的端到端验证。
//
// 盯的是**整条链**：用户发一句「帮我打开系统状态插件」→
// 交互层派单 → 后台任务调打开插件界面的那个工具 →
// 那个插件的界面窗口真的出现在桌面上。
//
// 桩接口靠**请求里的工具表**分辨是哪一层：
// 前台带着 task.run，后台不带。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-plugin-open');

/** 桩接口：交互层派单，执行层开插件界面。 */
async function startStubLlm({ interaction, execution }) {
  const timers = new Set();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const names = (body.tools || []).map((t) => t?.function?.name || '');
      const isExecution = !names.includes('task.run');
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

test.describe('发一句话打开插件界面', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('「帮我打开系统状态插件」：那个插件的界面窗口真的出现了', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('好啦。');
        return toolCall('task.run', {
          goal: '打开系统状态',
          done_when: '系统状态的界面开好了',
        });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('系统状态的界面开好了。');
        return toolCall('plugin.open', { name: '系统状态' });
      },
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '帮我打开系统状态插件');
      await panel.press('#query', 'Control+Enter');

      // 插件界面是**独立窗口**：按 URL 找，不是面板里的元素。
      const win = await findWindow(app, '/src/renderer/plugin-window/index.html', 20000);
      expect(win, '插件界面窗口没有出现').toBeTruthy();
      expect(win.url(), '开的不是系统状态那个窗口').toContain('plugin=system');
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
