import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  launchApp,
  collectErrors,
  launchWithAssistantState,
  waitForWindow,
  pageFor,
  tapPet,
  PANEL_URL,
} from './helpers.js';

/**
 * AI 对话。
 *
 * 走的是**本地桩服务**（讲 OpenAI 兼容协议、吐 SSE），
 * 绝不打到真实接口——真实接口只人工验一次。
 *
 * 关键路径：面板输入框 → 回车 → 桌宠旁边的气泡里**流式**出现回复。
 */

const BUBBLE_URL = '/src/renderer/bubble/index.html';

/**
 * 讲 OpenAI 兼容协议的 SSE 桩服务。
 *
 * 每一帧之间停 30ms：真的流式才有「逐字冒出来」的样子，
 * 一次性吐完的话测不出流式。
 */
async function startStubLlm({
  reply = '你好呀，我在这儿呢',
  emotion = 'happy',
  memory = '用户叫小明',
  status = 200,
  delayMs = 30,
} = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '接口不认你', code: 'invalid_api_key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(0, 3) } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(3) } }] })}\n\n`,
        // 只有 role 没有 content 的帧：必须被跳过，不能当成乱码。
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: `\n<<META>>${JSON.stringify({ emotion, mood: 5, memories: [memory] })}`,
              },
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ];
      let index = 0;
      const writeNext = () => {
        if (index < frames.length) {
          res.write(frames[index]);
          index += 1;
          setTimeout(writeNext, delayMs);
          return;
        }
        res.end();
      };
      writeNext();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 读 userData 里的 assistant.json（可能还不存在）。 */
async function readAssistant(userDataDir) {
  try {
    return JSON.parse(await readFile(join(userDataDir, 'assistant.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 起一个配好了对话的应用。 */
async function launchChatApp(stub, extra = {}) {
  return launchWithAssistantState(
    {
      version: 1,
      llm: {
        enabled: true,
        baseUrl: stub.url,
        model: 'stub-model',
        temperature: 0.7,
      },
    },
    { env: { MINIMAX_API_KEY: 'sk-test-local-stub' }, ...extra }
  );
}

test('聊天：回复在桌宠旁边的气泡里流式出现，消息与记忆都落盘', async () => {
  const stub = await startStubLlm();
  const ctx = await launchChatApp(stub);
  const errors = collectErrors(ctx.win);
  try {
    // 点桌宠 → 面板弹出来。
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    expect(panel, '面板应当弹出来').toBeTruthy();
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });

    // 「在吗」匹配不到任何插件 → 回车就是发给桌宠。
    await panel.fill('#query', '在吗');
    await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 5000 });
    await panel.press('#query', 'Enter');

    // 面板让位给气泡（气泡会正好落在面板上，把它盖住）。
    await panel.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 5000 });

    // 气泡出现了。
    const bubbleWin = await waitForWindow(ctx, BUBBLE_URL);
    expect(bubbleWin, '应当弹出气泡').toBeTruthy();
    const bubble = pageFor(ctx, BUBBLE_URL);
    await bubble.waitForFunction(
      () => (document.getElementById('text')?.textContent || '').includes('你好呀'),
      null,
      { timeout: 15000 }
    );

    // **元数据不能漏进气泡**。
    const text = await bubble.evaluate(() => document.getElementById('text').textContent);
    expect(text).toContain('你好呀');
    expect(text, '元数据不能显示给用户').not.toContain('META');

    // 请求确实打到了接口，形状也对。
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0].url).toContain('/v1/chat/completions');
    expect(stub.requests[0].auth).toBe('Bearer sk-test-local-stub');
    const body = JSON.parse(stub.requests[0].body);
    expect(body.model).toBe('stub-model');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: '在吗' });

    // 消息与记忆都落盘（防抖 300ms，等一下）。
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      saved = await readAssistant(ctx.userDataDir);
      if (saved?.chat?.messages?.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.chat?.messages?.length, '一问一答两条消息').toBe(2);
    expect(saved.chat.messages[0].role).toBe('user');
    expect(saved.chat.messages[0].text).toBe('在吗');
    expect(saved.chat.messages[1].role).toBe('assistant');
    expect(saved.chat.messages[1].text).toContain('你好呀');
    expect(saved.chat.facts, '模型记下的事要落盘').toContain('用户叫小明');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('聊天：回复的情绪会反映到桌宠表情上', async () => {
  const stub = await startStubLlm({ emotion: 'shy' });
  const ctx = await launchChatApp(stub);
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });
    await panel.fill('#query', '在吗');
    await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 5000 });
    await panel.press('#query', 'Enter');

    // 桌宠的表情变了（渲染层的诊断面）。
    await ctx.win.waitForFunction(() => window.__pet.emotion === 'shy', null, { timeout: 15000 });
    expect(await ctx.win.evaluate(() => window.__pet.emotion)).toBe('shy');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('聊天：Ctrl+Enter 永远发给桌宠（哪怕能匹配到插件）', async () => {
  const stub = await startStubLlm();
  const ctx = await launchChatApp(stub);
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });
    // 「待办」能匹配到插件：普通回车会打开插件，Ctrl+Enter 要发给桌宠。
    await panel.fill('#query', '待办');
    await panel.waitForFunction(
      () => (window.__panel?.resultIds || []).includes('todos'),
      null,
      { timeout: 5000 }
    );
    await panel.press('#query', 'Control+Enter');

    // 插件**没有**被打开。
    await panel.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 5000 });
    expect(await panel.evaluate(() => window.__panel.pluginId), '待办插件不该被打开').toBe('');

    // 但消息确实发给了桌宠。
    const bubbleWin = await waitForWindow(ctx, BUBBLE_URL);
    expect(bubbleWin).toBeTruthy();
    expect(stub.requests.length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('聊天：对话没打开时就不该请求接口', async () => {
  const stub = await startStubLlm();
  // 对话默认是关的（要花钱、要联网）：关着的时候不该打接口。
  const ctx = await launchWithAssistantState({
    version: 1,
    llm: { enabled: false, baseUrl: stub.url, model: 'stub-model' },
  });
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });
    await panel.fill('#query', '在吗');
    await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 5000 });
    await panel.press('#query', 'Enter');

    await new Promise((r) => setTimeout(r, 1500));
    expect(stub.requests.length, '对话没开就不该打接口').toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('聊天：接口报错时应用不崩，气泡给出提示', async () => {
  const stub = await startStubLlm({ status: 401 });
  const ctx = await launchChatApp(stub);
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });
    await panel.fill('#query', '在吗');
    await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 5000 });
    await panel.press('#query', 'Enter');

    const bubbleWin = await waitForWindow(ctx, BUBBLE_URL);
    expect(bubbleWin, '出错也要给用户一个说法').toBeTruthy();
    const bubble = pageFor(ctx, BUBBLE_URL);
    await bubble.waitForFunction(
      () => (document.getElementById('text')?.textContent || '').length > 0,
      null,
      { timeout: 15000 }
    );
    const text = await bubble.evaluate(() => document.getElementById('text').textContent);
    expect(text).toContain('401');
    expect(errors, '渲染层不能有未捕获错误').toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('聊天记录插件能看到刚才说过的话', async () => {
  const stub = await startStubLlm();
  const ctx = await launchChatApp(stub);
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });
    await panel.fill('#query', '在吗');
    await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 5000 });
    await panel.press('#query', 'Enter');
    await waitForWindow(ctx, BUBBLE_URL);

    // 等消息落盘。
    for (let i = 0; i < 40; i += 1) {
      const saved = await readAssistant(ctx.userDataDir);
      if (saved?.chat?.messages?.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // 再打开面板 → 找「聊天记录」插件。
    await tapPet(ctx);
    const panel2 = pageFor(ctx, PANEL_URL);
    await panel2.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, {
      timeout: 10000,
    });
    await panel2.fill('#query', '聊天记录');
    await panel2.waitForFunction(
      () => (window.__panel?.resultIds || []).includes('history'),
      null,
      { timeout: 5000 }
    );
    await panel2.press('#query', 'Enter');
    await panel2.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 5000 });

    const body = await panel2.evaluate(() => document.getElementById('plugin-body').textContent);
    expect(body).toContain('在吗');
    expect(body).toContain('你好呀');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('聊天：发给模型的消息里，用户的话只出现一次', async () => {
  const stub = await startStubLlm();
  const ctx = await launchChatApp(stub);
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });
    await panel.fill('#query', '在吗');
    await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 5000 });
    await panel.press('#query', 'Enter');
    await waitForWindow(ctx, BUBBLE_URL);

    // 等请求发出。
    for (let i = 0; i < 40; i += 1) {
      if (stub.requests.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const body = JSON.parse(stub.requests[0].body);
    const userLines = body.messages.filter((m) => m.role === 'user' && m.content === '在吗');
    expect(userLines.length, '用户的话不该在上下文里出现两次').toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('聊天：接口比气泡页加载还快时，回复也不会丢', async () => {
  // 桩服务一口气把回复吐完：模型的回复会在气泡页就绪**之前**到达。
  // 那些 `webContents.send` 是被丢弃而不是排队的——
  // 不攒着的话，用户看到的是一只空的气泡，回复正文不见了。
  const stub = await startStubLlm({ delayMs: 0 });
  const ctx = await launchChatApp(stub);
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const panel = pageFor(ctx, PANEL_URL);
    await panel.waitForFunction(() => (window.__panel?.resultIds || []).length >= 0, null, {
      timeout: 10000,
    });
    await panel.fill('#query', '在吗');
    await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 5000 });
    await panel.press('#query', 'Enter');

    const bubble = await waitForWindow(ctx, BUBBLE_URL);
    expect(bubble, '应当弹出气泡').toBeTruthy();
    const page = pageFor(ctx, BUBBLE_URL);
    await page.waitForFunction(
      () => (document.getElementById('text')?.textContent || '').includes('你好呀'),
      null,
      { timeout: 15000 }
    );
    const text = await page.evaluate(() => document.getElementById('text').textContent);
    expect(text).toContain('你好呀');
    expect(text).not.toContain('META');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
  }
});
