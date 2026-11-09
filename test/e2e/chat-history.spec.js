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
 * 一个「今天之内、离现在不太远」的时刻。
 *
 * 记录的时刻用它——这样它们跟新来的记录落在同一天里，
 * 「组内新的在前」才测得到（跨了午夜就分到两组去了）。
 */
function todayBase() {
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const room = now - midnight.getTime();
  return room > 60000 ? now - 60000 : midnight.getTime() + 1000;
}

/**
 * 摆一份聊天记录。
 *
 * 摆在 userData 的 assistant.json 里——助理启动时读它。
 * 任务的状态给「完成」：还在跑的任务在启动时会被补记一条「已中断」。
 *
 * 对话开关是**打开**的：用户说的话是「先记下、再去问模型」，
 * 开关关着时那句话根本不会被记下来（也就没有实时更新可看）。
 * 没配 API Key 不碍事——问模型那一步会失败，记录已经落下去了。
 *
 * 时刻用「现在往前推」——这样它们落在同一天里，
 * 「组内新的在前」才测得到。
 */
async function seedChat() {
  const base = todayBase();
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
          { kind: 'user', role: 'user', text: '在吗', at: base },
          { kind: 'reply', role: 'assistant', text: '在呢', at: base + 1000 },
          {
            kind: 'model',
            role: 'assistant',
            text: '我先看看剪贴板',
            at: base + 2000,
            meta: { layer: 'interaction', index: 1, model: 'MiniMax-M2' },
          },
          {
            kind: 'dispatch',
            role: 'assistant',
            text: '派了个后台任务：查视频',
            at: base + 3000,
            meta: {
              tool: 'task.submit',
              taskId: 't-1',
              title: '查视频',
              brief: '看看 F 盘 video 下有什么',
              layer: 'interaction',
            },
          },
          {
            kind: 'task',
            role: 'assistant',
            text: '完成 · 查视频',
            at: base + 4000,
            meta: { taskId: 't-1', status: 'done', title: '查视频' },
          },
          {
            kind: 'step',
            role: 'assistant',
            text: 'fs.list',
            at: base + 5000,
            meta: { taskId: 't-1', tool: 'fs.list' },
          },
          {
            kind: 'reply',
            role: 'assistant',
            text: '有 12 个视频',
            at: base + 6000,
            meta: { taskId: 't-1', layer: 'execution' },
          },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

/**
 * 摆一份「只有一句话」的记录：没有后台任务。
 *
 * 用来验「空的那一段不画」——「后台那边」整段都不该出现。
 */
async function seedChatSimple() {
  const base = todayBase();
  await mkdir(USER_DATA, { recursive: true });
  await writeFile(
    join(USER_DATA, 'assistant.json'),
    JSON.stringify({
      version: 1,
      llm: { enabled: true, ackEnabled: false },
      chat: {
        messages: [
          { kind: 'user', role: 'user', text: '在吗', at: base },
          { kind: 'reply', role: 'assistant', text: '在呢', at: base + 1000 },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

/**
 * 摆一份「只有后台任务」的记录：桌宠这边一行都没有。
 *
 * 用来验「桌宠这边」那一段空的时候也不画。
 */
async function seedChatBackOnly() {
  const base = todayBase();
  await mkdir(USER_DATA, { recursive: true });
  await writeFile(
    join(USER_DATA, 'assistant.json'),
    JSON.stringify({
      version: 1,
      llm: { enabled: true, ackEnabled: false },
      chat: {
        messages: [
          {
            kind: 'task',
            role: 'assistant',
            text: '完成 · 查视频',
            at: base,
            meta: { taskId: 't-9', status: 'done', title: '查视频' },
          },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

/**
 * 摆一份「无锚点的派单」。
 *
 * 派单记录没有配对的用户那句话 → 一块「没有对应的那句话」。
 * 它的标题要说的是那件事（派了个后台任务：查视频），
 * 不是记录原文（「task.submit 派了个任务：查视频 （任务 t-1）」）。
 */
async function seedChatOrphanDispatch() {
  const base = todayBase();
  await mkdir(USER_DATA, { recursive: true });
  await writeFile(
    join(USER_DATA, 'assistant.json'),
    JSON.stringify({
      version: 1,
      llm: { enabled: true, ackEnabled: false },
      chat: {
        messages: [
          {
            kind: 'dispatch',
            role: 'assistant',
            text: 'task.submit 派了个任务：查视频 （任务 t-1）',
            at: base,
            meta: {
              tool: 'task.submit',
              taskId: 't-1',
              title: '查视频',
              action: '派了个任务：查视频',
              brief: '看看 F 盘 video 下有什么',
              layer: 'interaction',
            },
          },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

/**
 * 摆一份带「没有对应的那句话」的块与桌宠自己起头的块。
 *
 * - 开头那条模型记录没有用户的话接着它 → 一块「没有对应的那句话」；
 * - 最后那条是桌宠主动搭话 → 一块「桌宠自己起的头」。
 */
async function seedChatFlags() {
  const base = todayBase();
  await mkdir(USER_DATA, { recursive: true });
  await writeFile(
    join(USER_DATA, 'assistant.json'),
    JSON.stringify({
      version: 1,
      llm: { enabled: true, ackEnabled: false },
      chat: {
        messages: [
          {
            kind: 'model',
            role: 'assistant',
            text: '（没人跟我说话，我自己嘀咕一句）',
            at: base,
            meta: { layer: 'interaction', index: 1, model: 'MiniMax-M2' },
          },
          { kind: 'user', role: 'user', text: '在吗', at: base + 1000 },
          {
            kind: 'reply',
            role: 'assistant',
            text: '我先歇会儿',
            at: base + 2000,
            proactive: true,
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

  test('面板里能打开：一次发话一块，块里分两段', async () => {
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

      // 一次发话 = 一块
      await expect(frame.locator('.turn')).toHaveCount(1);
      await expect(frame.locator('.turn-title')).toHaveText('在吗');

      // 块里分两段
      await expect(frame.locator('.lane-front .lane-title')).toHaveText('桌宠这边');
      await expect(frame.locator('.lane-back .lane-title')).toHaveText('后台那边');

      // 交底默认折起，展开看得到原文
      await frame.locator('.turn > summary').click();
      await frame.locator('.detail[data-detail="dispatch:t-1"] > summary').click();
      const brief = frame.locator('.detail[data-detail="brief:t-1"]');
      await expect(brief).not.toHaveAttribute('open', '');
      await brief.locator('summary').click();
      await expect(brief).toHaveAttribute('open', '');
      await expect(brief.locator('.detail-pre')).toHaveText('看看 F 盘 video 下有什么');

      // 后台任务的答复折在一条明细里，摘要写「结果」。
      const result = frame.locator('.lane-back .detail[data-detail="result"]');
      await expect(result.locator('summary')).toHaveText('结果');
      await expect(result.locator('.task-result')).toHaveText('有 12 个视频');

      // 清空：动作走 iframe → 壳 → IPC → 插件 → 助理，回来后页面自己重取一份。
      await frame.locator('#clear').click();
      await expect(frame.locator('#empty')).toBeVisible();
      await expect(frame.locator('#count')).toHaveText('0 块');
    } finally {
      await app.close();
    }
  });

  test('一次发话的事：过程与结果都在同一块里', async () => {
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

      const turn = winFrame.locator('.turn').first();
      await expect(turn.locator('.lane-front')).toContainText('派了个后台任务');
      await expect(turn.locator('.lane-back .task .task-title')).toContainText('查视频');

      // 结果回到**这一块**里：它是执行层的一条可折叠明细，摘要写「结果」。
      const result = turn.locator('.detail[data-detail="result"]');
      await expect(result.locator('summary')).toHaveText('结果');
      await expect(result).toContainText('有 12 个视频');

      // 只有一块：一次发话就是一块。
      await expect(winFrame.locator('.turn')).toHaveCount(1);

      // 界面上没有内部标识。
      const visible = await winFrame.locator('#list').textContent();
      for (const word of ['kind', 'taskId', 'layer', 'dispatch']) {
        expect(visible, `界面上出现了内部标识：${word}`).not.toContain(word);
      }
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
      await expect(winFrame.locator('.turn-title')).toHaveText('在吗');
      await expect(winFrame.locator('.lane-front .lane-title')).toHaveText('桌宠这边');
      await expect(winFrame.locator('.lane-back .lane-title')).toHaveText('后台那边');
    } finally {
      await app.close();
    }
  });

  test('没有后台任务的时候：「后台那边」那一段整个不画', async () => {
    await seedChatSimple();
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

      const frame = panel.frameLocator('#plugin-frame');
      await expect(frame.locator('.lane-front .lane-title')).toHaveText('桌宠这边');
      await expect(frame.locator('.lane-back')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('只有后台任务的时候：「桌宠这边」那一段整个不画', async () => {
    await seedChatBackOnly();
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

      const frame = panel.frameLocator('#plugin-frame');
      await expect(frame.locator('.lane-front')).toHaveCount(0);
      await expect(frame.locator('.lane-back .lane-title')).toHaveText('后台那边');
    } finally {
      await app.close();
    }
  });

  test('没有对应的那句话的块：标题说人话，不露工具名与内部编号', async () => {
    await seedChatOrphanDispatch();
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

      const frame = panel.frameLocator('#plugin-frame');
      const title = frame.locator('.turn-title');
      await expect(title).toHaveCount(1);
      await expect(title).not.toContainText('task.submit');
      await expect(title).not.toContainText('t-1');
      await expect(title).toContainText('查视频');
    } finally {
      await app.close();
    }
  });

  test('块上标着它的来路：没有对应的那句话 / 桌宠自己起的头', async () => {
    await seedChatFlags();
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

      const frame = panel.frameLocator('#plugin-frame');
      const flags = frame.locator('.turn-flag');
      await expect(flags).toHaveCount(2);
      await expect(flags).toHaveText(['桌宠自己起的头', '没有对应的那句话']);
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
      await expect(winFrame.locator('.turn-title')).toHaveText('在吗');

      // 先把后台任务的步骤展开：用户正在看的东西不该被新记录挤掉。
      await winFrame.locator('.turn > summary').first().click();
      await winFrame.locator('.detail[data-detail="steps:t-1"] summary').click();
      await expect(winFrame.locator('.detail[data-detail="steps:t-1"]')).toHaveAttribute('open', '');

      // 重新打开面板（回到搜索视图），说一句话。
      await pet.evaluate(() => window.pet.openPanel?.());
      await panel.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 10000 });
      await panel.fill('#query', '你好呀');
      await panel.press('#query', 'Control+Enter');

      // 这句话被记下来了 → 开着的页面自己就更新了，不用重开。
      await expect(winFrame.locator('.turn')).toHaveCount(2);

      // 新块排在前头，内容看得见。
      await expect(winFrame.locator('.turn').first().locator('.turn-title')).toHaveText('你好呀');

      // 更新不能把用户正在看的东西收起来。
      await expect(winFrame.locator('.detail[data-detail="steps:t-1"]')).toHaveAttribute('open', '');
      await expect(winFrame.locator('.detail[data-detail="steps:t-1"] .step-list li')).toHaveText('fs.list');
    } finally {
      await app.close();
    }
  });
});
