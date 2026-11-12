// 后台任务设置的端到端验证（规格 §10 的 agent 段、T18）。
//
// 钉三件事：
//   1. 每个控件改完**立刻落盘**，重启后还在；
//   2. 审批档位不是只存了个值——切到「每件事都问」，写文件真的会问一声；
//   3. 勾了「以后都不问」的工具，同名工具真的不再弹审批。
//
// 第 2、3 条走**执行层**：交互层没有审批通道，
// 只有后台任务调写类工具时才会弹气泡。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-agent-settings');
const WORKSPACE = join(ROOT, '.tmp-e2e-agent-settings-workspace');

/**
 * 桩接口。
 *
 * 靠**请求里的工具表**分辨是哪一层：
 * 交互层带着 task.submit，执行层不带。
 * 执行层慢一拍：前台那句「我去看看」先说完，执行层才来要授权。
 */
async function startStubLlm({ interaction, execution, executionDelayMs = 1200 }) {
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

/** 摆一份助理状态：能派单、工作区指着临时目录、审批档位由参数定。 */
async function writeAssistantState(dir, { policy = 'auto', allowAlways = [] } = {}) {
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
          approval: { policy, allowAlways },
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
  // 后台任务的设置在「对话」这一节的「后台任务」分组里。
  await settings.click('#chat-tab-agent');
  await settings.waitForSelector('#chat-sub-agent:not([hidden])', { timeout: 10000 });
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
 * 审批气泡与聊天气泡**是同一个窗口**——
 * 所以不能只看「窗口在不在」，得看窗口里有没有审批按钮。
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

/** 等审批按钮出现。 */
async function waitForApproval(app, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await findApproval(app);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 读工作区里的文件（没有就返回 null）。 */
async function readWorkspaceFile(name) {
  try {
    return await readFile(join(WORKSPACE, name), 'utf8');
  } catch {
    return null;
  }
}

/** 读磁盘上的助理状态。 */
async function readStoredState() {
  try {
    return JSON.parse(await readFile(join(USER_DATA, 'assistant.json'), 'utf8'));
  } catch {
    return null;
  }
}

test.describe('后台任务的设置', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  test('每个控件改完立刻落盘，重启后还在', async () => {
    const stub = await startStubLlm({
      interaction: () => say('好。'),
      execution: () => say('好。'),
    });
    await writeAssistantState(USER_DATA, { policy: 'auto' });
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const settings = await openSettings(app);

      await settings.fill('#agentMaxConcurrent', '3');
      await settings.fill('#agentMaxSteps', '25');
      await settings.selectOption('#agentTimeout', '300000');
      await settings.fill('#agentWorkspace', WORKSPACE);
      await settings.selectOption('#agentPolicy', 'manual');

      // 落盘是**立刻**的：不重启就该读到新值。
      const stored = await waitUntil(async () => {
        const s = await readStoredState();
        return s?.agent?.maxConcurrent === 3 ? s : null;
      });
      expect(stored, '改了并发数但没落盘').toBeTruthy();
      expect(stored.agent.maxSteps).toBe(25);
      expect(stored.agent.timeoutMs).toBe(300000);
      expect(stored.agent.workspace).toBe(WORKSPACE);
      expect(stored.agent.approval.policy).toBe('manual');
      // 派单模式没被动过。
      expect(stored.agent.dispatch).toBe('auto');
    } finally {
      await app.close();
      await stub.close();
    }

    // 重启：值还在，界面上也还显示着。
    const stub2 = await startStubLlm({
      interaction: () => say('好。'),
      execution: () => say('好。'),
    });
    const app2 = await launch(USER_DATA, stub2.baseUrl);
    try {
      const settings = await openSettings(app2);
      expect(await settings.inputValue('#agentMaxConcurrent')).toBe('3');
      expect(await settings.inputValue('#agentMaxSteps')).toBe('25');
      expect(await settings.inputValue('#agentTimeout')).toBe('300000');
      expect(await settings.inputValue('#agentWorkspace')).toBe(WORKSPACE);
      expect(await settings.inputValue('#agentPolicy')).toBe('manual');
    } finally {
      await app2.close();
      await stub2.close();
    }
  });

  test('审批档位不是只存了个值：切到「每件事都问」，写文件真的会问一声', async () => {
    let writes = 0;
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '写个文件', brief: '在工作区写一个 note.txt' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('写好了。');
        writes += 1;
        return toolCall('fs.write', { path: `note-${writes}.txt`, content: `第 ${writes} 个文件` });
      },
    });
    // 一开始是「都不问」：写文件不该有人管。
    await writeAssistantState(USER_DATA, { policy: 'auto' });
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const settings = await openSettings(app);
      const panel = await openPanel(app);

      await panel.fill('#query', '在工作区写个 note.txt');
      await panel.press('#query', 'Control+Enter');

      // 「都不问」：没人问，文件照样写出来。
      const wrote = await waitUntil(async () => (await readWorkspaceFile('note-1.txt')) !== null, 20000);
      expect(wrote, '「都不问」时文件没有写出来').toBeTruthy();
      expect(await findApproval(app), '「都不问」时却弹了审批').toBeNull();

      // 切到「每件事都问」——改的是**设置界面**，不是磁盘上的文件。
      await settings.selectOption('#agentPolicy', 'manual');
      await waitUntil(async () => (await readStoredState())?.agent?.approval?.policy === 'manual');

      await panel.fill('#query', '再写一个');
      await panel.press('#query', 'Control+Enter');

      // 这一次要问一声：审批气泡真的出现了。
      const approval = await waitForApproval(app, 30000);
      expect(approval, '切到「每件事都问」后没有弹审批').toBeTruthy();
      expect(
        [...approval.buttons].sort(),
        `审批按钮不是四个：${JSON.stringify(approval.buttons)}`
      ).toEqual(['allow', 'always', 'cancel', 'deny']);

      await approval.win.click('#actions button[data-decision="allow"]');

      const second = await waitUntil(
        async () => (await readWorkspaceFile('note-2.txt')) !== null,
        20000
      );
      expect(second, '点了「允许」但文件没有写').toBeTruthy();
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('勾了「以后都不问」的工具，同名工具不再弹审批', async () => {
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '写个文件', brief: '在工作区写一个 note.txt' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('写好了。');
        return toolCall('fs.write', { path: 'note.txt', content: '不用问的内容' });
      },
    });
    // 「每件事都问」：不勾名单的话，写文件一定有人管。
    await writeAssistantState(USER_DATA, { policy: 'manual' });
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const settings = await openSettings(app);
      const panel = await openPanel(app);

      // 在设置界面的「工具」页里把「写文件」勾成以后都不问。
      await settings.click('#chat-tab-tools');
      const row = settings.locator('#toolGroups li[data-tool-name="fs.write"]');
      await expect(row, '工具清单里没有 fs.write').toHaveCount(1);
      // 点开抽屉，在抽屉里把它设成「以后不问」。
      await row.click();
      await settings.waitForSelector('#toolDrawer:not([hidden])', { timeout: 10000 });
      await settings.selectOption('#toolDrawerApproval', 'always');

      const stored = await waitUntil(async () => {
        const s = await readStoredState();
        return s?.agent?.approval?.allowAlways?.includes('fs.write') ? s : null;
      });
      expect(stored, '勾了工具但没落盘').toBeTruthy();

      await panel.fill('#query', '在工作区写个 note.txt');
      await panel.press('#query', 'Control+Enter');

      // 文件写了，**没有**审批气泡。
      const wrote = await waitUntil(async () => (await readWorkspaceFile('note.txt')) !== null, 20000);
      expect(wrote, '永久放行之后文件没有写出来').toBeTruthy();
      expect(await findApproval(app), '永久放行的工具还是弹了审批').toBeNull();
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('关掉的工具不进模型的工具表：它看不见，也调不到', async () => {
    // 记下执行层每次请求里带过去的工具名。
    const seen = [];
    const stub = await startStubLlm({
      interaction: (body) => {
        const last = (body.messages || []).at(-1) || {};
        if (last.role === 'tool') return say('我去看看。');
        return toolCall('task.submit', { title: '写个文件', brief: '在工作区写一个 note.txt' });
      },
      execution: (body) => {
        const last = (body.messages || []).at(-1) || {};
        seen.push((body.tools || []).map((t) => t?.function?.name || ''));
        if (last.role === 'tool') return say('写好了。');
        return toolCall('fs.write', { path: 'note.txt', content: '不该写出来' });
      },
    });
    await writeAssistantState(USER_DATA, { policy: 'auto' });
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const settings = await openSettings(app);
      const panel = await openPanel(app);

      await settings.click('#chat-tab-tools');
      await settings.waitForSelector('#chat-sub-tools:not([hidden])', { timeout: 10000 });
      const row = settings.locator('#toolGroups li[data-tool-name="fs.write"]');
      await expect(row, '工具清单里没有 fs.write').toHaveCount(1);

      // 关掉它：抽屉里的「启用」。
      await row.click();
      await settings.waitForSelector('#toolDrawer:not([hidden])', { timeout: 10000 });
      await settings.uncheck('#toolDrawerEnabled');

      const stored = await waitUntil(async () => {
        const s = await readStoredState();
        return s?.agent?.tools?.disabled?.includes('fs.write') ? s : null;
      });
      expect(stored, '关掉工具但没落盘').toBeTruthy();

      await panel.fill('#query', '在工作区写个 note.txt');
      await panel.press('#query', 'Control+Enter');

      // 执行层的工具表里没有 fs.write 了：模型看不见它。
      const sawIt = await waitUntil(() => (seen.length ? seen[seen.length - 1] : null), 20000);
      expect(sawIt, '执行层没有发请求').toBeTruthy();
      expect(sawIt, '关掉的工具还在模型的工具表里').not.toContain('fs.write');

      // 硬调它也调不到：文件不会写出来。
      await new Promise((r) => setTimeout(r, 2000));
      expect(await readWorkspaceFile('note.txt'), '关掉的工具还是写出了文件').toBeNull();
    } finally {
      await app.close();
      await stub.close();
    }
  });
});

test.describe('切到「只聊天」', () => {
  test('用户不点头就不切：下拉框退回原值，磁盘上还是能派活', async () => {
    const stub = await startStubLlm({
      interaction: () => say('好。'),
      execution: () => say('好。'),
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      // **原生对话框不在测试范围里**（Playwright 不拦它）：把它桩掉，
      // 记下问没问、问的是什么。
      await app.evaluate(({ dialog }) => {
        globalThis.__asked = [];
        dialog.showMessageBox = (...args) => {
          const opt = args.length > 1 ? args[1] : args[0];
          globalThis.__asked.push(String(opt?.message || ''));
          // 0 = 第一个按钮 =「取消」。
          return Promise.resolve({ response: 0, checkboxChecked: false });
        };
      });
      const settings = await openSettings(app);
      // 「桌宠能做什么」在「模型」这一页里（openSettings 默认停在「后台任务」）。
      await settings.click('#chat-tab-model');
      await settings.waitForSelector('#chat-sub-model:not([hidden])', { timeout: 10000 });
      await settings.selectOption('#llmDispatch', 'off');

      const asked = await waitUntil(async () => {
        const list = await app.evaluate(() => globalThis.__asked || []);
        return list.length ? list : null;
      });
      expect(asked[0], '切之前没有问').toContain('只聊天');

      // 用户不点头：下拉框退回原值，磁盘上什么都没改。
      await waitUntil(async () => (await settings.inputValue('#llmDispatch')) === 'auto');
      const stored = await readStoredState();
      expect(stored.agent.dispatch, '用户没点头就切了').toBe('auto');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('用户点头才切：磁盘上存的是 off', async () => {
    const stub = await startStubLlm({
      interaction: () => say('好。'),
      execution: () => say('好。'),
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = () =>
          // 1 = 第二个按钮 =「切到只聊天」。
          Promise.resolve({ response: 1, checkboxChecked: false });
      });
      const settings = await openSettings(app);
      // 「桌宠能做什么」在「模型」这一页里（openSettings 默认停在「后台任务」）。
      await settings.click('#chat-tab-model');
      await settings.waitForSelector('#chat-sub-model:not([hidden])', { timeout: 10000 });
      await settings.selectOption('#llmDispatch', 'off');

      const stored = await waitUntil(async () => {
        const s = await readStoredState();
        return s?.agent?.dispatch === 'off' ? s : null;
      });
      expect(stored.agent.dispatch).toBe('off');
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
