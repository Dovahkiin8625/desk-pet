import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchApp,
  collectErrors,
  tapPet,
  waitForWindow,
  pageFor,
  PANEL_URL,
} from './helpers.js';

/**
 * 插件面板。
 *
 * 面板是**独立窗口**（不是桌宠窗口里的 DOM）：
 * 桌宠窗口 300×560 被角色占满，面板画在它上面就是盖住角色的脸。
 *
 * 它也是**懒创建**的：启动时并不存在——E2E 的 app.firstWindow() 认的是
 * 「第一个窗口」，面板若先于桌宠出现，整个套件都会超时。
 */

/** 读 userData 里的 assistant.json（可能还不存在）。 */
async function readAssistant(userDataDir) {
  try {
    return JSON.parse(await readFile(join(userDataDir, 'assistant.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 打开面板（点一下桌宠）并拿到它的页面。 */
async function openPanel(ctx) {
  await tapPet(ctx);
  const win = await waitForWindow(ctx, PANEL_URL);
  expect(win, '点一下桌宠应当弹出插件面板').toBeTruthy();
  const page = pageFor(ctx, PANEL_URL);
  expect(page, '面板应当有一个对应的页面').toBeTruthy();
  // 等插件清单到齐（搜索要用它）。
  await page.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, {
    timeout: 10000,
  });
  return { win, page };
}

test('面板是懒创建的：应用启动时并不存在', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const urls = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
    );
    expect(urls.filter((u) => u.includes(PANEL_URL))).toEqual([]);
    expect(urls.some((u) => u.includes('/src/renderer/index.html'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('左键点桌宠 → 面板弹出来，输入框自动聚焦', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { win, page } = await openPanel(ctx);
    expect(win.visible, '面板应当是可见的').toBe(true);

    // 输入框要能立刻打字：用户点完桌宠就该直接敲关键词。
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused, '焦点应当在搜索框上').toBe('query');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('面板摆在桌宠旁边，不盖住角色', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { win } = await openPanel(ctx);

    const pet = await ctx.app.evaluate(({ BrowserWindow }, petUrl) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(petUrl));
      return w ? w.getBounds() : null;
    }, '/src/renderer/index.html');

    // 面板与桌宠窗口**不该重叠**：盖住角色的脸是最糟的结果。
    const overlaps =
      win.bounds.x < pet.x + pet.width &&
      win.bounds.x + win.bounds.width > pet.x &&
      win.bounds.y < pet.y + pet.height &&
      win.bounds.y + win.bounds.height > pet.y;
    expect(overlaps, '面板与桌宠窗口重叠了').toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('模糊搜索：输入关键词后只剩匹配的插件', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    await page.fill('#query', '待办');
    await page.waitForFunction(
      () => window.__panel?.resultIds?.length === 1 && window.__panel.resultIds[0] === 'todos',
      null,
      { timeout: 5000 }
    );
    const ids = await page.evaluate(() => window.__panel.resultIds);
    expect(ids, '「待办」应当只匹配到待办插件').toEqual(['todos']);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('模糊搜索：英文与拼音也认', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);
    for (const q of ['todo', 'daiban']) {
      await page.fill('#query', q);
      await page.waitForFunction(
        (query) => window.__panel?.resultIds?.[0] === 'todos',
        q,
        { timeout: 5000 }
      );
    }
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('回车打开插件界面', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    await page.fill('#query', '待办');
    await page.waitForFunction(() => window.__panel?.resultIds?.[0] === 'todos', null, {
      timeout: 5000,
    });
    await page.press('#query', 'Enter');

    // 同一个窗口换成插件界面。
    await page.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 5000 });
    const title = await page.evaluate(() => document.getElementById('plugin-title').textContent);
    expect(title).toBe('待办');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('点结果也能打开插件界面', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    await page.fill('#query', '番茄');
    await page.waitForFunction(() => window.__panel?.resultIds?.[0] === 'pomodoro', null, {
      timeout: 5000,
    });
    await page.click('#results li.active');

    await page.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 5000 });
    const title = await page.evaluate(() => document.getElementById('plugin-title').textContent);
    expect(title).toBe('番茄钟');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('在待办插件里加一条，待办真的落盘了', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    await page.fill('#query', '待办');
    await page.waitForFunction(() => window.__panel?.resultIds?.[0] === 'todos', null, {
      timeout: 5000,
    });
    await page.press('#query', 'Enter');
    await page.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 5000 });

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

    // 界面上也要能看到它。
    await page.waitForFunction(
      () => document.getElementById('plugin-body')?.textContent?.includes('买菜'),
      null,
      { timeout: 5000 }
    );
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('点待办条目能勾选完成', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    await page.fill('#query', '待办');
    await page.waitForFunction(() => window.__panel?.resultIds?.[0] === 'todos', null, {
      timeout: 5000,
    });
    await page.press('#query', 'Enter');
    await page.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 5000 });

    // 先加一条，才有东西可点。
    await page.fill('#plugin-body input[type="text"]', '写周报');
    await page.press('#plugin-body input[type="text"]', 'Enter');
    await page.waitForFunction(
      () => document.getElementById('plugin-body')?.textContent?.includes('写周报'),
      null,
      { timeout: 5000 }
    );

    await page.click('#plugin-body .block-list li');
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      saved = await readAssistant(ctx.userDataDir);
      if (saved?.todos?.[0]?.done) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.todos?.[0]?.done, '待办应当被标记为完成').toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('Esc 从插件界面回到搜索，再按一次关掉面板', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    await page.fill('#query', '待办');
    await page.waitForFunction(() => window.__panel?.resultIds?.[0] === 'todos', null, {
      timeout: 5000,
    });
    await page.press('#query', 'Enter');
    await page.waitForFunction(() => window.__panel?.view === 'plugin', null, { timeout: 5000 });

    await page.press('#query', 'Escape');
    await page.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 5000 });

    await page.press('#query', 'Escape');
    const hidden = await ctx.app.evaluate(({ BrowserWindow }, url) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(url));
      return w ? w.isVisible() : null;
    }, PANEL_URL);
    expect(hidden, 'Esc 应当把面板收起来').toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('右键菜单里已经没有「小工具」了', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    // 右键 → 菜单模板（走真实的 contextmenu 事件路径）。
    await ctx.win.evaluate(async () => {
      const canvas = window.__pet.stage.app.view;
      const b = window.__pet.model.getBounds();
      canvas.dispatchEvent(
        new MouseEvent('contextmenu', {
          clientX: b.x + b.width / 2,
          clientY: b.y + b.height * 0.15,
          bubbles: true,
          cancelable: true,
        })
      );
      await new Promise((r) => setTimeout(r, 300));
    });
    // 菜单是原生弹窗，自动化里弹不出来——但它不会出现在面板上。
    // 这里断言的是「面板没有被右键打开」：功能入口只有左键那一条。
    const panelVisible = await ctx.app.evaluate(({ BrowserWindow }, url) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(url));
      return w ? w.isVisible() : false;
    }, PANEL_URL);
    expect(panelVisible, '右键不该打开插件面板').toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 程序搜索（uTools 那一套）
// ---------------------------------------------------------------------------

test('搜索框能搜到本机程序', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    // 记事本在 C:\Windows\System32 里，是 PATH 上的系统工具——
    // 索引里一定有它（系统目录里只收那张单子上的工具，notepad 在单子上）。
    await page.fill('#query', 'notepad');
    await page.waitForFunction(() => (window.__panel?.appIds || []).length > 0, null, {
      timeout: 20000,
    });
    const ids = await page.evaluate(() => window.__panel.appIds);
    expect(
      ids.some((id) => id.includes('notepad')),
      `结果里应当有记事本，实际是：${ids.join('、')}`
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('搜索框空着的时候只列插件，不列程序', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);
    // 等索引到齐（清单到了才知道有多少程序）。
    await page.waitForFunction(() => (window.__panel?.appCount || 0) > 0, null, { timeout: 20000 });
    const appIds = await page.evaluate(() => window.__panel.appIds);
    expect(appIds, '空查询时不该列程序').toEqual([]);
    const pluginIds = await page.evaluate(() => window.__panel.resultIds);
    expect(pluginIds.length, '空查询时插件清单照旧').toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('回车能启动本机程序', async () => {
  // **不去真的启动本机的程序**：那会在测试机上弹出窗口。
  // 改用覆盖口（DESK_PET_E2E_APPS）塞一个假程序——
  // 它是个 .cmd，跑起来会写一个标记文件，测试就查那个文件。
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-apps-'));
  const marker = join(dir, 'marker.txt');
  const script = join(dir, 'hello.cmd');
  await writeFile(script, `@echo off\r\necho hi > "${marker}"\r\n`, 'utf8');
  const listFile = join(dir, 'apps.json');
  await writeFile(
    listFile,
    JSON.stringify([
      { id: 'app:hello', name: '测试程序', target: script, kind: 'path', hint: '测试' },
    ]),
    'utf8'
  );

  const ctx = await launchApp({ env: { DESK_PET_E2E_APPS: listFile } });
  const errors = collectErrors(ctx.win);
  try {
    const { page } = await openPanel(ctx);

    await page.fill('#query', '测试');
    await page.waitForFunction(() => (window.__panel?.appIds || []).length > 0, null, {
      timeout: 20000,
    });
    await page.press('#query', 'Enter');

    // 程序真的被启动了（那个 .cmd 跑起来写了标记文件）。
    let ran = false;
    for (let i = 0; i < 60; i += 1) {
      ran = await readFile(marker, 'utf8')
        .then(() => true)
        .catch(() => false);
      if (ran) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ran, '回车之后那个程序应当真的被启动了').toBe(true);

    // 界面上也要看得见结果。
    await page.waitForFunction(
      () => (document.getElementById('search-status')?.textContent || '').includes('已打开'),
      null,
      { timeout: 5000 }
    );
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  }
});
