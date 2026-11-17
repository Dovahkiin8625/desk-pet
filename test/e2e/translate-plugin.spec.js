// 翻译插件的端到端验证。
//
// 覆盖三件事：
//   1. 面板打开时，输入框里已经填好了剪贴板里最近的文字；
//   2. 结果列表里有一行「翻译「xxx」」，按下去就把那段文字交给翻译插件；
//   3. 接上一个假的 OpenAI 兼容接口后，译文照常出来、变量名照给、点一下就复制。
//
// 译文本身不依赖真的 API：假接口回的就是「user name」（见最后一个测试）。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-translate');

/** 启动应用（E2E 模式：不抢单实例锁，用临时 userData）。 */
async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开插件面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  if (!panel) throw new Error('面板窗口没有出现');
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => window.__panel?.ready === true, null, {
    timeout: 15000,
  });
  return panel;
}

test.beforeEach(async () => {
  await rm(USER_DATA, { recursive: true, force: true });
});

test.afterEach(async () => {
  await rm(USER_DATA, { recursive: true, force: true });
});

test('面板打开时，输入框里填着剪贴板里最近的文字', async () => {
  const { app, pet } = await launch();
  try {
    // 先把剪贴板放上「最近复制的那段话」。
    await app.evaluate(({ clipboard }) => clipboard.writeText('hello world'));

    const panel = await openPanel(app, pet);

    await panel.waitForFunction(() => window.__panel?.query === 'hello world', null, {
      timeout: 10000,
    });
  } finally {
    await app.close();
  }
});

test('同一段剪贴板文字只自动填一次', async () => {
  const { app, pet } = await launch();
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('hello world'));

    const panel = await openPanel(app, pet);
    await panel.waitForFunction(() => window.__panel?.query === 'hello world', null, {
      timeout: 10000,
    });

    // 收起来再打开：剪贴板没换内容，不该再塞一遍同样的字。
    await panel.evaluate(() => window.panel.close());
    await new Promise((r) => setTimeout(r, 500));
    await pet.evaluate(() => window.pet.openPanel());
    await panel.waitForFunction(() => window.__panel?.query === '', null, { timeout: 10000 });

    // 剪贴板换了内容：那是新的一段，照填不误。
    await app.evaluate(({ clipboard }) => clipboard.writeText('another text'));
    await panel.evaluate(() => window.panel.close());
    await new Promise((r) => setTimeout(r, 500));
    await pet.evaluate(() => window.pet.openPanel());
    await panel.waitForFunction(() => window.__panel?.query === 'another text', null, {
      timeout: 10000,
    });
  } finally {
    await app.close();
  }
});

test('设置抽屉里有「自动变量命名」开关，拨动后回写', async () => {
  const { app, pet } = await launch();
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('hello world'));
    const panel = await openPanel(app, pet);
    await panel.waitForFunction(() => window.__panel?.query === 'hello world', null, {
      timeout: 10000,
    });

    // 打开「翻译」那一行，进到插件的页面。
    await panel.evaluate(() => {
      const row = [...document.querySelectorAll('#results li')].find((li) =>
        li.textContent.includes('翻译「hello world」')
      );
      if (!row) throw new Error('找不到「翻译」那一行');
      row.click();
    });
    await panel.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 10000 });

    const frame = () => panel.frameLocator('#plugin-frame');

    // 变量名那一块一开始是藏着的（开关默认关、译文也没译完）。
    await frame().locator('#varsBox').waitFor({ state: 'attached' });
    expect(await frame().locator('#varsBox').isHidden()).toBe(true);

    // 打开设置抽屉：里面得有「自动变量命名」这个开关。
    await frame().locator('#gearBtn').click();
    const toggle = frame().locator('input[aria-label="自动变量命名"]');
    await toggle.waitFor({ state: 'visible' });
    expect(await toggle.isChecked()).toBe(false);

    // 拨开：等宿主把新设置回写到界面（往返一圈）。
    await toggle.check();
    await panel.waitForFunction(
      () => {
        const doc = document.getElementById('plugin-frame')?.contentDocument;
        return doc?.querySelector('input[aria-label="自动变量命名"]')?.checked === true;
      },
      null,
      { timeout: 10000 }
    );

    // 拨回去，别把用户的偏好弄脏（E2E 用的是临时 userData，但还是干净点）。
    await frame().locator('input[aria-label="自动变量命名"]').uncheck();
  } finally {
    await app.close();
  }
});

test('接上假的大模型接口：译文出来、变量名照给、点一下复制到剪贴板', async () => {
  // 假的 OpenAI 兼容接口：无论问什么，都回「user name」（SSE 流式）。
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"user name"}}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // 种好 userData：假接口地址 + 假 key + 把「自动变量命名」开着。
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await writeFile(
      join(USER_DATA, 'assistant.json'),
      JSON.stringify({
        llm: {
          enabled: true,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: 'e2e-mock',
          temperature: 0.2,
          maxTokens: 800,
          maxTokensField: 'max_tokens',
        },
      })
    );
    await writeFile(join(USER_DATA, 'credentials.json'), JSON.stringify({ llmApiKey: 'e2e-test-key' }));
    await writeFile(
      join(USER_DATA, 'plugins.json'),
      JSON.stringify({ disabled: [], config: { translate: { autoVariableName: true } } })
    );

    const { app, pet } = await launch();
    try {
      await app.evaluate(({ clipboard }) => clipboard.writeText('用户名'));
      const panel = await openPanel(app, pet);
      await panel.waitForFunction(() => window.__panel?.query === '用户名', null, {
        timeout: 10000,
      });

      // 进到「翻译」那一行。
      await panel.evaluate(() => {
        const row = [...document.querySelectorAll('#results li')].find((li) =>
          li.textContent.includes('翻译「用户名」')
        );
        if (!row) throw new Error('找不到「翻译」那一行');
        row.click();
      });
      await panel.waitForFunction(() => window.__panel?.view === 'plugin', null, {
        timeout: 10000,
      });

      const frame = panel.frameLocator('#plugin-frame');

      // 译文出来了：假接口回的就是「user name」。
      await panel.waitForFunction(
        () =>
          document.getElementById('plugin-frame')?.contentDocument?.querySelector('#result')
            ?.value === 'user name',
        null,
        { timeout: 15000 }
      );

      // 自动变量命名：小驼峰 / 大驼峰两种写法都在。
      expect(await frame.locator('#varsBox').isHidden()).toBe(false);
      expect((await frame.locator('#varLowerText').textContent())?.trim()).toBe('userName');
      expect((await frame.locator('#varUpperText').textContent())?.trim()).toBe('UserName');

      // 点译文 → 整段译文复制到剪贴板，浮一句提示。
      await frame.locator('#result').click();
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5000 })
        .toBe('user name');
      expect(await frame.locator('#toast').isHidden()).toBe(false);
      expect(await frame.locator('#toast').textContent()).toContain('已复制到剪贴板');

      // 点大驼峰 → 大驼峰复制到剪贴板。
      await frame.locator('#varUpper').click();
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5000 })
        .toBe('UserName');

      // 点小驼峰 → 小驼峰复制到剪贴板。
      await frame.locator('#varLower').click();
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5000 })
        .toBe('userName');
    } finally {
      await app.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('结果列表里有「翻译「xxx」」那一行，按下去打开翻译插件', async () => {
  const { app, pet } = await launch();
  try {
    await app.evaluate(({ clipboard }) => clipboard.writeText('hello world'));
    const panel = await openPanel(app, pet);
    await panel.waitForFunction(() => window.__panel?.query === 'hello world', null, {
      timeout: 10000,
    });

    // 那一行在列表里。
    await panel.waitForFunction(
      () =>
        [...document.querySelectorAll('#results li')].some((li) =>
          li.textContent.includes('翻译「hello world」')
        ),
      null,
      { timeout: 10000 }
    );

    // 点它（不用 Playwright 的 click：插件一打开，面板就换视图了）。
    await panel.evaluate(() => {
      const row = [...document.querySelectorAll('#results li')].find((li) =>
        li.textContent.includes('翻译「hello world」')
      );
      if (!row) throw new Error('找不到「翻译」那一行');
      row.click();
    });

    await panel.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 10000 });
    expect(await panel.evaluate(() => window.__panel.pluginId)).toBe('translate');

    // 插件的页面里，原文已经摆好了。
    await panel.waitForFunction(
      () => {
        const frame = document.getElementById('plugin-frame');
        const doc = frame?.contentDocument;
        return doc?.querySelector('#source')?.value === 'hello world';
      },
      null,
      { timeout: 15000 }
    );

    // 底下那行字总得有话可说：翻完了、翻不动了、或者没配 Key——
    // 总之不能是空的（空着用户就不知道发生了什么）。
    await panel.waitForFunction(
      () => {
        const doc = document.getElementById('plugin-frame')?.contentDocument;
        return Boolean(doc?.querySelector('#statusText')?.textContent?.trim());
      },
      null,
      { timeout: 20000 }
    );
  } finally {
    await app.close();
  }
});
