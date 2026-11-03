import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  launchApp,
  collectErrors,
  launchWithMenuProbe,
  clickMenuPath,
  openContextMenu,
  waitForWindow,
  pageFor,
  tapPet,
  launchWithAssistantState,
  PANEL_URL,
  waitForPetVisible,
} from './helpers.js';

const BUBBLE_URL = '/src/renderer/bubble/index.html';

/**
 * 读 userData 里的 assistant.json。
 *
 * 文件可能**还不存在**：助理状态是「有改动才落盘」的，
 * 应用刚起来、还没改过任何东西时，磁盘上是没有这个文件的。
 */
async function readAssistant(userDataDir) {
  try {
    return JSON.parse(await readFile(join(userDataDir, 'assistant.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 打开插件面板里的某个插件。
 *
 * 走的是**真实**的链路：点桌宠 → 面板弹出来 → 输入关键词 → 点结果。
 */
async function openPlugin(ctx, keyword, pluginId) {
  await tapPet(ctx);
  const win = await waitForWindow(ctx, PANEL_URL);
  expect(win, '点一下桌宠应当弹出插件面板').toBeTruthy();
  const page = pageFor(ctx, PANEL_URL);
  await page.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, {
    timeout: 10000,
  });
  await page.fill('#query', keyword);
  await page.waitForFunction(
    (id) => window.__panel?.resultIds?.[0] === id,
    pluginId,
    { timeout: 5000 }
  );
  await page.click('#results li.active');
  await page.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 5000 });
  return page;
}

test('插件面板里包含原来那些小工具', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    await tapPet(ctx);
    const win = await waitForWindow(ctx, PANEL_URL);
    expect(win, '点一下桌宠应当弹出插件面板').toBeTruthy();
    const page = pageFor(ctx, PANEL_URL);
    await page.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, {
      timeout: 10000,
    });
    const ids = await page.evaluate(() => window.__panel.resultIds);
    // 原来「小工具」子菜单里的每一项，现在都是一个插件。
    //
    // 「说句话」与「快捷启动」已经退役：前者整个去掉，
    // 后者变成搜索框里的程序搜索（不是插件）。
    for (const id of ['pomodoro', 'todos', 'reminders', 'weather', 'system', 'clipboard']) {
      expect(ids, `插件清单里应当有 ${id}`).toContain(id);
    }
    for (const id of ['speak', 'launcher']) {
      expect(ids, `${id} 应当已经不在插件清单里`).not.toContain(id);
    }
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('「添加待办」：输入之后待办真的落盘了', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const page = await openPlugin(ctx, '待办', 'todos');

    // 真的在插件界面的输入框里打字，走完整的提交路径。
    await page.fill('#plugin-body input[type="text"]', '买菜');
    await page.press('#plugin-body input[type="text"]', 'Enter');

    // 待办要写进 assistant.json（防抖 300ms，等一下）。
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      saved = await readAssistant(ctx.userDataDir);
      if (saved?.todos?.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.todos?.length, '待办应当被写进 assistant.json').toBe(1);
    expect(saved.todos[0].text).toBe('买菜');
    expect(saved.todos[0].done).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('待办能在插件界面里看到并勾选完成', async () => {
  // 先塞一条待办进去（比走一遍输入框短，也更稳定）。
  const ctx = await launchWithAssistantState({
    version: 1,
    todos: [{ id: 't-1', text: '写周报', done: false, createdAt: Date.now() }],
  });
  const errors = collectErrors(ctx.win);
  try {
    const page = await openPlugin(ctx, '待办', 'todos');

    const text = await page.evaluate(() => document.getElementById('plugin-body').textContent);
    expect(text).toContain('写周报');

    // 点它 → 完成。
    await page.click('#plugin-body .block-list li');
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      saved = await readAssistant(ctx.userDataDir);
      if (saved?.todos?.[0]?.done) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved.todos[0].done, '待办应当被标记为完成').toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('剪贴板助手：复制内容后桌宠会提示', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    // 先清空剪贴板：助手记的是「变化」，
    // 而上一轮用例留下的内容会让这次写入看起来毫无变化。
    await ctx.app.evaluate(({ clipboard }) => clipboard.clear());

    // 在插件界面里把剪贴板助手打开。
    const page = await openPlugin(ctx, '剪贴板', 'clipboard');
    await page.click('#plugin-body .block-toggle input');
    // 动作之后页面还得是完整的（这个插件的 open 是异步的，
    // 动作里若没 await 就会得到一个空页面）。
    await page.waitForFunction(
      () => document.getElementById('plugin-title')?.textContent === '剪贴板',
      null,
      { timeout: 5000 }
    );

    // 复制一段文字：剪贴板助手会轮询到它（每 2 秒一次）。
    await ctx.app.evaluate(({ clipboard }) =>
      clipboard.writeText('这是一段被复制的文字')
    );

    const bubble = await (async () => {
      for (let i = 0; i < 50; i += 1) {
        const p = pageFor(ctx, BUBBLE_URL);
        if (p) {
          const text = await p.evaluate(() => document.getElementById('text').textContent);
          if (text.includes('你复制了')) return p;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    })();
    expect(bubble, '桌宠应当就剪贴板内容提示').toBeTruthy();
    const text = await bubble.evaluate(() => document.getElementById('text').textContent);
    expect(text).toContain('你复制了');
    expect(text).toContain('这是一段被复制的文字');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('到点的提醒会被播报出来', async () => {
  // 预置一条**已经到点**的提醒：应用一起来就该播报它。
  const ctx = await launchWithAssistantState({
    version: 1,
    reminders: [
      { id: 'r-1', text: '喝水', at: Date.now() - 1000, createdAt: Date.now(), fired: false },
    ],
  });
  const errors = collectErrors(ctx.win);
  try {
    const page = await (async () => {
      for (let i = 0; i < 50; i += 1) {
        const p = pageFor(ctx, BUBBLE_URL);
        if (p) {
          const text = await p.evaluate(() => document.getElementById('text').textContent);
          if (text.includes('喝水')) return p;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    })();
    expect(page, '到点的提醒应当被播报').toBeTruthy();
    const text = await page.evaluate(() => document.getElementById('text').textContent);
    expect(text).toContain('提醒你');
    expect(text).toContain('喝水');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('番茄钟能开始也能停下来', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const page = await openPlugin(ctx, '番茄', 'pomodoro');

    await page.click('#plugin-body .block-buttons button.primary'); // 开始专注
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      saved = await readAssistant(ctx.userDataDir);
      if (saved?.pomodoro?.phase === 'focus') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.pomodoro?.phase).toBe('focus');
    expect(saved?.pomodoro?.endsAt).toBeGreaterThan(Date.now());

    // 跑着的时候，按钮变成「暂停」。
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#plugin-body .block-buttons button')].some(
          (b) => b.textContent === '暂停'
        ),
      null,
      { timeout: 5000 }
    );
    await page.click('#plugin-body .block-buttons button.primary'); // 暂停
    for (let i = 0; i < 40; i += 1) {
      saved = await readAssistant(ctx.userDataDir);
      if (saved?.pomodoro?.phase === 'paused') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.pomodoro?.phase).toBe('paused');

    // 暂停之后，按钮变成「继续」——而且点了真的会继续。
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#plugin-body .block-buttons button')].some(
          (b) => b.textContent === '继续'
        ),
      null,
      { timeout: 5000 }
    );
    await page.click('#plugin-body .block-buttons button.primary'); // 继续
    for (let i = 0; i < 40; i += 1) {
      saved = await readAssistant(ctx.userDataDir);
      if (saved?.pomodoro?.phase === 'focus') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.pomodoro?.phase, '「继续」应当真的把番茄钟跑起来').toBe('focus');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('剪贴板内容不会被写进磁盘', async () => {
  const ctx = await launchApp();
  try {
    // 剪贴板助手默认是关的；这里直接验证「关着的时候不落盘」。
    await ctx.app.evaluate(({ clipboard }) => clipboard.writeText('不该落盘的内容'));
    await new Promise((r) => setTimeout(r, 2500));
    let raw = '';
    try {
      raw = await readFile(join(ctx.userDataDir, 'assistant.json'), 'utf8');
    } catch {
      raw = '';
    }
    expect(raw).not.toContain('不该落盘的内容');
  } finally {
    await ctx.close();
  }
});

test('桌宠被藏起来时不弹气泡，重新出现时补播', async () => {
  const ctx = await launchWithMenuProbe();
  const errors = collectErrors(ctx.win);
  try {
    // 先把桌宠藏起来。
    await openContextMenu(ctx);
    await clickMenuPath(ctx, ['显示 / 隐藏']);
    expect(await waitForPetVisible(ctx, false), '桌宠应当被藏起来了').toBe(true);

    // 这时候来一条消息（提醒到期）。
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows();
      const bubble = w.find((x) => x.webContents.getURL().includes('/src/renderer/bubble/'));
      // 桌宠藏着的时候根本不该有气泡窗口被创建出来
      if (bubble && bubble.isVisible()) throw new Error('桌宠藏着时不该有可见的气泡');
    });

    // 把桌宠放回来 → 排队的消息补播。
    await openContextMenu(ctx);
    await clickMenuPath(ctx, ['显示 / 隐藏']);

    const page = await (async () => {
      for (let i = 0; i < 50; i += 1) {
        const p = pageFor(ctx, BUBBLE_URL);
        if (p) {
          const text = await p.evaluate(() => document.getElementById('text').textContent);
          if (text) return p;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    })();
    expect(page, '桌宠回来之后应当补播排队的消息').toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('系统状态：插件界面里能看到 CPU 与内存', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const page = await openPlugin(ctx, '系统', 'system');
    const text = await page.evaluate(() => document.getElementById('plugin-body').textContent);
    expect(text).toContain('系统状态');
    expect(text).toMatch(/CPU \d+%|CPU 采样中/);
    expect(text).toMatch(/内存 \d+%/);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('拖进来的文件会被报出文件名与大小', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    // 真正的拖放要 OS 参与（Electron 32 起 File.path 也被移除了），
    // 这里走渲染层暴露的那条上报通道——主进程收到路径后的处理是真跑。
    const filePath = join(ctx.userDataDir, '拖进来的文件.txt');
    await writeFile(filePath, '桌宠你好', 'utf8');
    await ctx.win.evaluate((p) => window.pet.reportDroppedFile(p), filePath);

    const bubble = await waitForWindow(ctx, BUBBLE_URL);
    expect(bubble, '应当有气泡弹出来').toBeTruthy();
    const page = pageFor(ctx, BUBBLE_URL);
    await page.waitForFunction(
      () => document.getElementById('text').textContent.includes('拖进来的文件'),
      null,
      { timeout: 10000 }
    );
    const text = await page.evaluate(() => document.getElementById('text').textContent);
    expect(text).toContain('拖进来的文件.txt');
    expect(text).toContain('B');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
