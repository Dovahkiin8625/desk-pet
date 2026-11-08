// 聊天记录插件的端到端验证。
//
// 它曾经是面板里的一个内置功能（用声明式积木画，只能显示「谁说了什么」）。
// 现在它是**真插件**：自带页面、能分类显示、能实时更新、能分离成独立窗口。
//
// 这里验的是**页面真的跑起来了**：模块能加载（import 不炸）、
// 记录按分类画出来（对话一句一条、任务的过程合成一块）。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-chat-history');

/**
 * 摆一份聊天记录。
 *
 * 摆在 userData 的 assistant.json 里——助理启动时读它。
 * 任务的状态给「完成」：还在跑的任务在启动时会被补记一条「已中断」。
 *
 * 对话开关是**打开**的：用户说的话是「先记下、再去问模型」，
 * 开关关着时那句话根本不会被记下来（也就没有实时更新可看）。
 * 没配 API Key 不碍事——问模型那一步会失败，记录已经落下去了。
 */
async function seedChat() {
  await mkdir(USER_DATA, { recursive: true });
  await writeFile(
    join(USER_DATA, 'assistant.json'),
    JSON.stringify({
      version: 1,
      llm: {
        enabled: true,
        // 别让桌宠「先应一声」：那句话会多出一条记录，干扰断言。
        ackEnabled: false,
      },
      chat: {
        messages: [
          { kind: 'user', role: 'user', text: '在吗', at: 1 },
          { kind: 'reply', role: 'assistant', text: '在呢', at: 2 },
          {
            kind: 'task',
            role: 'assistant',
            text: '完成 · 查视频',
            at: 3,
            meta: { taskId: 't-1', status: 'done', title: '查视频' },
          },
          {
            kind: 'step',
            role: 'assistant',
            text: 'fs.list',
            at: 4,
            meta: { taskId: 't-1', tool: 'fs.list' },
          },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

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

/** 打开面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel?.());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes('/renderer/panel/index.html')) {
          await win.waitForLoadState('domcontentloaded');
          return win;
        }
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('面板没有出现');
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes(part)) return win;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

test.describe('聊天记录插件', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await seedChat();
  });

  test('面板里能打开：对话一句一条，任务的过程合成一块', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);

      // 它现在是个插件：搜得到，id 是 chat-history。
      await panel.fill('#query', '聊天记录');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('chat-history'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("聊天记录")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'chat-history', null, {
        timeout: 10000,
      });

      // 插件自己的页面装在 iframe 里。
      const frame = panel.frameLocator('#plugin-frame');

      // 对话：用户一句、桌宠一句，各一个气泡。
      await expect(frame.locator('.chat.user')).toHaveText('在吗');
      await expect(frame.locator('.chat.reply')).toHaveText('在呢');

      // 任务：状态、标题、步骤合成一块（步骤默认折起来）。
      await expect(frame.locator('.task')).toHaveCount(1);
      await expect(frame.locator('.task .title')).toHaveText('查视频');
      await expect(frame.locator('.task .status')).toHaveText('完成 · 查视频');
      await expect(frame.locator('.task details')).toBeVisible();
      await expect(frame.locator('.task ol li')).toHaveText('fs.list');

      // 清空：动作走 iframe → 壳 → IPC → 插件 → 助理，回来后页面自己重取一份。
      await frame.locator('#clear').click();
      await expect(frame.locator('#empty')).toBeVisible();
      await expect(frame.locator('#count')).toHaveText('0 条');
    } finally {
      await app.close();
    }
  });

  test('能分离成独立窗口：里面装的是同一份页面', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', '聊天记录');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('chat-history'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("聊天记录")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'chat-history', null, {
        timeout: 10000,
      });

      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');

      const winFrame = pluginWin.frameLocator('#plugin-frame');
      await expect(winFrame.locator('.chat.user')).toHaveText('在吗');
      await expect(winFrame.locator('.task .title')).toHaveText('查视频');
    } finally {
      await app.close();
    }
  });

  test('页面开着的时候：新记录不用重开就出现', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', '聊天记录');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('chat-history'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("聊天记录")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'chat-history', null, {
        timeout: 10000,
      });

      // 分离成独立窗口：面板要收起来去说话，窗口留着。
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');

      const winFrame = pluginWin.frameLocator('#plugin-frame');
      await expect(winFrame.locator('.chat.user')).toHaveText('在吗');

      // 先把任务的步骤展开：用户正在看的东西不该被新记录挤掉。
      await winFrame.locator('.task details summary').click();
      await expect(winFrame.locator('.task details')).toHaveAttribute('open', '');

      // 重新打开面板（回到搜索视图），说一句话。
      await pet.evaluate(() => window.pet.openPanel?.());
      await panel.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 10000 });
      await panel.fill('#query', '你好呀');
      await panel.press('#query', 'Control+Enter');

      // 这句话被记下来了 → 开着的页面自己就更新了，不用重开。
      await expect(winFrame.locator('.chat.user')).toHaveCount(2);
      await expect(winFrame.locator('.chat.user').nth(1)).toHaveText('你好呀');

      // 更新不能把用户正在看的东西收起来。
      await expect(winFrame.locator('.task details')).toHaveAttribute('open', '');
      await expect(winFrame.locator('.task ol li')).toHaveText('fs.list');

    } finally {
      await app.close();
    }
  });
});
