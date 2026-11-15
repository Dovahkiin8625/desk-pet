// 翻译插件的端到端验证。
//
// 覆盖两件事：
//   1. 面板打开时，输入框里已经填好了剪贴板里最近的文字；
//   2. 结果列表里有一行「翻译「xxx」」，按下去就把那段文字交给翻译插件。
//
// 译文本身不在这里验：翻译要么要 API Key、要么要连外网，
// 那两样都不该由端到端测试来假定（见 test/unit/translate-plugin.test.js）。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

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
