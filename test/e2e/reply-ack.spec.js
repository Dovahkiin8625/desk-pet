// 「先应一声」的端到端验证。
//
// 这个功能解决的是用户的真实抱怨：问一句之后要等好几秒，
// 那几秒里桌宠一声不吭，像是坏了。
//
// 所以这里盯住一件事：**用户先看到的必须是那声应答，不是答案**。
// 单元测试盯的是应答控制器自己的时序；这里盯的是整条链路
// （面板发话 → 桩接口慢吞吞地回话 → 气泡窗口里先冒出应答）。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ACK_LINES } from '../../src/main/assistant/chat/ack.js';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-reply-ack');

/** 桩接口：慢吞吞地回话，模拟「模型要想一会儿」。 */
async function startStubLlm({ delayMs = 3000, reply = 'video 下面有 3 个视频。' } = {}) {
  const server = createServer((req, res) => {
    // 把请求体读完再回：不然客户端那边连接还没结束。
    req.on('data', () => {});
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 摆一份助理状态：对话开着、语音关着（省掉语音桩服务）。 */
async function writeAssistantState(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
        llm: { enabled: true, backend: 'chat', model: 'stub-model', temperature: 0.7, maxTokens: 800 },
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
      // 桩接口：绝不会打到真实接口上去。
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

test.describe('先应一声', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('模型还在想的时候，先应一句；答案随后才来', async () => {
    const stub = await startStubLlm({ delayMs: 3000 });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      // 发一句话：Ctrl+Enter 永远是「发给桌宠」。
      await panel.fill('#query', 'F 盘 video 下有什么');
      await panel.press('#query', 'Control+Enter');

      // 气泡窗口在**应答**时才冒出来（此前没有任何气泡）。
      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 10000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');

      // 记下气泡里**依次**出现过哪些字。
      await bubble.evaluate(() => {
        window.__seen = [];
        const el = document.getElementById('text');
        const record = () => {
          const t = (el?.textContent || '').trim();
          if (t && window.__seen.at(-1) !== t) window.__seen.push(t);
        };
        record();
        window.__recorder = setInterval(record, 30);
      });

      // 等答案出现。
      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('3 个视频')),
        null,
        { timeout: 20000 }
      );
      const seen = await bubble.evaluate(() => window.__seen);

      // **第一句**必须是应答：用户等的时候看到的是「我看一下哦～」这类短句，
      // 不是一只空着的空气泡。
      expect(ACK_LINES, '应答短句池读不到').toContain(seen[0]);
      // 答案排在应答后面。
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[seen.length - 1]).toContain('3 个视频');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('模型答得快：不啰嗦，直接给答案', async () => {
    const stub = await startStubLlm({ delayMs: 200, reply: 'video 下面有 3 个视频。' });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', 'F 盘 video 下有什么');
      await panel.press('#query', 'Control+Enter');

      const bubble = await findWindow(app, '/src/renderer/bubble/index.html', 10000);
      expect(bubble, '气泡窗口没有出现').toBeTruthy();
      await bubble.waitForLoadState('domcontentloaded');
      await bubble.evaluate(() => {
        window.__seen = [];
        const el = document.getElementById('text');
        const record = () => {
          const t = (el?.textContent || '').trim();
          if (t && window.__seen.at(-1) !== t) window.__seen.push(t);
        };
        record();
        window.__recorder = setInterval(record, 30);
      });

      await bubble.waitForFunction(
        () => (window.__seen || []).some((t) => t.includes('3 个视频')),
        null,
        { timeout: 20000 }
      );
      const seen = await bubble.evaluate(() => window.__seen);

      // 答得快还多嘴，比慢更要紧：不该有那声应答。
      expect(seen, '模型答得快还应了一声').not.toContain(ACK_LINES[0]);
      expect(seen.some((t) => ACK_LINES.includes(t)), '不该有应答').toBe(false);
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
