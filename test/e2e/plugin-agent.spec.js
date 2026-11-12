// 插件接给后台任务的 agent。
//
// 盯的是两件事：
//   1. **插件的工具进执行层的工具表**——后台任务能调它们；
//   2. **技能的说明书不进提示词**——提示词里只有「名字：说明」，
//      正文等模型调 `skill.read` 才给（渐进式披露）。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-plugin-agent');

/** 桩接口：把请求体记下来，交互层与执行层各回一句话。 */
async function startStubLlm({ interaction, execution }) {
  const timers = new Set();
  const seen = [];
  // 交互层的请求也记一份：有的测试要盯它给的工具表。
  const interactionSeen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const names = (body.tools || []).map((t) => t?.function?.name || '');
      // 交互层带着 task.submit，执行层不带。
      const isExecution = !names.includes('task.submit');
      if (isExecution) seen.push(body);
      else interactionSeen.push(body);
      const reply = isExecution ? execution(body) : interaction(body);
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      }, 30);
      timers.add(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    interactionSeen,
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

async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  return panel;
}

test.describe('插件接给后台任务的 agent', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('执行层的工具表里有插件的工具；技能的正文不进提示词', async () => {
    const stub = await startStubLlm({
      // 交互层：第一轮派单，第二轮给答复。
      interaction: (body) => {
        const already = (body.messages || []).some((m) => m.role === 'tool');
        return already
          ? { choices: [{ message: { content: '我去看看。' } }] }
          : toolCall('task.submit', { title: '看待办', brief: '看看待办清单' });
      },
      execution: (body) => {
        // 第二轮（工具结果回来了）给个答复。
        const last = body.messages?.at(-1) || {};
        if (last.role === 'tool') {
          return { choices: [{ message: { content: '待办我看了。' } }] };
        }
        return toolCall('skill.read', { skill: 'todos' });
      },
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '我有什么待办');
      await panel.press('#query', 'Control+Enter');

      // 等执行层真的发过一次请求。
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !stub.seen.length) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(stub.seen.length, '执行层一次请求都没发').toBeGreaterThan(0);

      const first = stub.seen[0];
      const names = (first.tools || []).map((t) => t?.function?.name || '');
      expect(names, '插件的工具没进执行层的工具表').toContain('todos.add');
      expect(names, '内置的读技能工具不在工具表里').toContain('skill.read');

      // 技能清单进提示词，但**只有名字与说明**。
      const system = first.messages?.[0]?.content || '';
      expect(system, '提示词里没有技能清单').toContain('todos');
      expect(system, '提示词里没有提醒插件的技能').toContain('reminders');
      // 技能正文里的那句话不该出现在提示词里（只该有「名字：说明」那一行）。
      expect(system, '技能正文漏进提示词了').not.toContain('一次只处理一条');
      // 技能的说明写的是**什么时候用**，不是「它是什么」——
      // 模型只看这一行决定要不要读正文。
      expect(system, '技能说明还在写功能描述').not.toContain('管理待办清单：添加、列出、勾选完成、清理已完成');
      expect(system, '技能说明没写什么时候用').toContain('用户要记待办');

      // 模型调 skill.read 之后，正文才给出来——得等带着工具结果的那次请求。
      const readDeadline = Date.now() + 30000;
      let toolMsg = null;
      while (Date.now() < readDeadline && !toolMsg) {
        for (const req of stub.seen) {
          const msg = (req.messages || []).find((m) => m.role === 'tool');
          if (msg) toolMsg = msg;
        }
        if (!toolMsg) await new Promise((r) => setTimeout(r, 100));
      }
      expect(toolMsg, 'skill.read 的结果没回来').toBeTruthy();
      expect(String(toolMsg.content || '')).toContain('一次只处理一条');
    } finally {
      await app.close();
      await stub.close();
    }
  });

  test('交互层：问「你有哪些插件」，它查能力清单再答', async () => {
    const stub = await startStubLlm({
      // 交互层：第一轮查能力清单，第二轮给答复。
      interaction: (body) => {
        const already = (body.messages || []).some((m) => m.role === 'tool');
        return already
          ? { choices: [{ message: { content: '我装了待办、提醒这些。' } }] }
          : toolCall('capability.list', {});
      },
      execution: () => ({ choices: [{ message: { content: '（不该被叫到）' } }] }),
    });
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA, stub.baseUrl);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const panel = await openPanel(app, pet);

      await panel.fill('#query', '你有哪些插件');
      await panel.press('#query', 'Control+Enter');

      // 等交互层真的查过一次清单。
      const deadline = Date.now() + 30000;
      let toolMsg = null;
      while (Date.now() < deadline && !toolMsg) {
        for (const req of stub.interactionSeen) {
          const msg = (req.messages || []).find((m) => m.role === 'tool');
          if (msg) toolMsg = msg;
        }
        if (!toolMsg) await new Promise((r) => setTimeout(r, 100));
      }
      expect(toolMsg, '交互层没查能力清单').toBeTruthy();

      const first = stub.interactionSeen[0];
      const names = (first.tools || []).map((t) => t?.function?.name || '');
      expect(names, '交互层的工具表里没有 capability.list').toContain('capability.list');

      // 提示词里写着插件名与「别凭印象说」。
      const system = first.messages?.[0]?.content || '';
      expect(system, '提示词里没有插件名').toContain('你装着的插件：');
      expect(system, '提示词里没说要查清单').toContain('capability.list');

      // 清单里有装着的插件，也有工具名。
      const text = String(toolMsg.content || '');
      expect(text, '清单里没有待办插件').toContain('待办');
      expect(text, '清单里没有工具').toContain('todos.add');
    } finally {
      await app.close();
      await stub.close();
    }
  });
});
