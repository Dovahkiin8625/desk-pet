// 外部助手（claude code）的接线验证（规格 §9）。
//
// 这里**一个真的 CLI 都不起**：起一个要联网、要几分钟，
// 放进 e2e 会让它变成一个又慢又不稳的用例。
// 这里钉的是接线本身：
//   1. `harness.run` 在工具清单里（用户看得见、能永久放行）；
//   2. 执行层拿到的工具表里确实有它（模型调得到）；
//   3. 它是执行级的——「每件事都问」时它真的会有人管。
//
// **不起 CLI 的办法**：调它时 prompt 给空串——
// 工具在起进程之前就会说「要交给它什么活儿」，于是流程照样走完，
// 只是没真的把 claude code 拉起来。
//
// CLI 本身的行为（JSONL 解析、进程树、日志落盘）在
// `test/unit/agent-harness.test.js` 与 `test/unit/agent-harness-tool.test.js` 里单测。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-harness');
const WORKSPACE = join(ROOT, '.tmp-e2e-harness-workspace');

/**
 * 桩接口。
 *
 * 顺手记下每一层收到的**工具表**——接线对不对，看这个就够。
 */
async function startStubLlm({ interaction, execution }) {
  const timers = new Set();
  const seen = { interaction: [], execution: [] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const names = (body.tools || []).map((t) => t?.function?.name || '');
      const isExecution = !names.includes('task.submit');
      seen[isExecution ? 'execution' : 'interaction'].push(names);
      const reply = isExecution ? execution(body) : interaction(body);
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }, isExecution ? 800 : 50);
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

/** 摆一份助理状态。 */
async function writeAssistantState(dir, { policy = 'auto' } = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
        llm: { enabled: true, model: 'stub-model', temperature: 0.7, maxTokens: 800 },
        agent: {
          dispatch: 'auto',
          workspace: WORKSPACE,
          approval: { policy, allowAlways: [] },
        },
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

/** 等某个条件成立。 */
async function waitUntil(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** 打开设置窗口并切到「对话」分区。 */
async function openSettings(app) {
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  await settings.click('#tab-chat');
  await settings.waitForSelector('#panel-chat:not([hidden])', { timeout: 10000 });
  return settings;
}

/** 打开面板。 */
async function openPanel(app) {
  const pet = await app.firstWindow();
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  return panel;
}

/**
 * 当前有没有审批按钮。
 *
 * 审批气泡与聊天气泡**是同一个窗口**——得看窗口里有没有审批按钮。
 */
async function findApproval(app) {
  for (const w of app.windows()) {
    if (!w.url().includes('/src/renderer/bubble/index.html')) continue;
    const buttons = await w
      .evaluate(() =>
        Array.from(document.querySelectorAll('#actions button[data-decision]')).map(
          (b) => b.dataset.decision
        )
      )
      .catch(() => []);
    if (buttons.length) return { win: w, buttons };
  }
  return null;
}

test.describe('外部助手', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  test('工具清单里有它，执行层也拿得到', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '跑外部助手', brief: '让 claude code 回答 1+1' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('好了。');
        // prompt 给空串：工具会在起进程之前就拒绝——**真的 CLI 不会被拉起来**。
        return toolCall('harness.run', { prompt: '' });
      },
    });
    await writeAssistantState(USER_DATA, { policy: 'auto' });
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const settings = await openSettings(app);
      const panel = await openPanel(app);

      // 工具清单里能看见它（用户能永久放行）。
      const tools = await settings.evaluate(() => window.pet.listAgentTools());
      const names = tools.map((t) => t.name);
      expect(names, '工具清单里没有 harness.run').toContain('harness.run');

      // 执行层的工具表里也有它。
      await panel.fill('#query', '让 claude code 回答 1+1');
      await panel.press('#query', 'Control+Enter');

      const got = await waitUntil(
        () => (stub.seen.execution[0] || []).includes('harness.run') || null,
        20000
      );
      expect(got, '执行层的工具表里没有 harness.run').toBeTruthy();
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('它是执行级的：「每件事都问」时它真的会有人管', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '跑外部助手', brief: '让 claude code 回答 1+1' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('好了。');
        return toolCall('harness.run', { prompt: '' });
      },
    });
    await writeAssistantState(USER_DATA, { policy: 'manual' });
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const panel = await openPanel(app);

      await panel.fill('#query', '让 claude code 回答 1+1');
      await panel.press('#query', 'Control+Enter');

      // 有人管：审批气泡出现了。
      const deadline = Date.now() + 30000;
      let approval = null;
      while (Date.now() < deadline && !approval) {
        approval = await findApproval(app);
        if (!approval) await new Promise((r) => setTimeout(r, 100));
      }
      expect(approval, '外部助手没有弹审批').toBeTruthy();

      // 拒绝：不许它跑。
      await approval.win.click('#actions button[data-decision="deny"]');
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
