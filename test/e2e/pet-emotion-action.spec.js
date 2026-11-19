// 模型在 <<META>> 里点名的动作（action: <clip id>）：真的播出对应的 clip；
// 没点名就不该切走待机。
//
// 这条链路跨三层：
//   提示词列出 clip —— agent 的 <<META>> 吐 action —— 渲染层点播。
// 只测单测不够：clip 清单要走「渲染层上报 → 主进程 → agent 提示词」这一圈，
// 任何一环掉了，模型都不会知道该叫什么编号。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-emotion-action');

/** 桩接口：对任何请求都回同一句话；`seen` 记下每一次请求体。 */
async function startStubLlm(reply) {
  const timers = new Set();
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}'));
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ choices: [{ message: { content: reply } }] })
        );
      }, 50);
      timers.add(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    seen,
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

/** 摆一份助理状态：对话开着、语音关着、问候关着。 */
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

/** 切到 miya 并等它真的挂上。 */
async function switchToMiya(pet) {
  const ok = await pet.evaluate(async () => window.__pet.switchModel('miya'));
  expect(ok, 'miya 挂不上').toBe(true);
  await pet.waitForFunction(() => window.__pet?.modelId === 'miya', null, { timeout: 30000 });
}

test.describe('模型点名的动作', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await writeAssistantState(USER_DATA);
  });

  test.afterEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('action: dance-bounce → 视频形象播 dance-bounce', async () => {
    const stub = await startStubLlm('哈哈哈哈哈<<META>>{"emotion":"happy","mood":5,"action":"dance-bounce","memories":[]}');
    let app = null;

    try {
      app = await launch(USER_DATA, stub.baseUrl);
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      await switchToMiya(pet);

      const panel = await openPanel(app, pet);
      await panel.fill('#query', '笑一个');
      await panel.press('#query', 'Control+Enter');

      await pet.waitForFunction(
        () => window.__pet?.model?.__currentClip?.clip?.id === 'dance-bounce',
        null,
        { timeout: 15000 }
      );
      expect(await pet.evaluate(() => window.__pet.emotion)).toBe('happy');

      // 模型真的看见了「你能做出的动作」这张表（含 dance-bounce）。
      const system = String(stub.seen[0]?.messages?.find((m) => m.role === 'system')?.content || '');
      expect(system).toContain('你能做出的动作');
      expect(system).toContain('dance-bounce=弹跳律动');
    } finally {
      if (app) await app.close();
      await stub.close();
    }
  });

  test('没有 action → 待机不切走', async () => {
    const stub = await startStubLlm('好，我记住了<<META>>{"emotion":"neutral","mood":0,"memories":[]}');
    let app = null;

    try {
      app = await launch(USER_DATA, stub.baseUrl);
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      await switchToMiya(pet);

      const panel = await openPanel(app, pet);
      await panel.fill('#query', '随便聊聊');
      await panel.press('#query', 'Control+Enter');

      // 等一轮对话走完：情绪落地（neutral），而 clip 仍是待机那条。
      await pet.waitForFunction(() => window.__pet?.emotion === 'neutral', null, { timeout: 15000 });
      const current = await pet.evaluate(() => ({
        id: window.__pet?.model?.__currentClip?.clip?.id,
        semantic: window.__pet?.model?.__currentClip?.clip?.semantic || '',
      }));
      expect(current.semantic).toBe('idle');
    } finally {
      if (app) await app.close();
      await stub.close();
    }
  });
});
