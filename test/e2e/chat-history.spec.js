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

/**
 * 摆一份「用户问了一句、桌宠答了、过一会儿又主动搭话」的记录。
 *
 * 主动搭话不写用户那句话：它的模型原话与工具调用都夹在前一次答复之后，
 * 那些过程记录要归**主动搭话自己那一块**。
 */
async function seedChatProactive() {
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
          {
            kind: 'model',
            role: 'assistant',
            text: '我先看看',
            at: base + 1000,
            meta: { layer: 'interaction', index: 1, model: 'MiniMax-M2' },
          },
          { kind: 'reply', role: 'assistant', text: '在呢', at: base + 2000 },
          {
            kind: 'model',
            role: 'assistant',
            text: '我看下时间',
            at: base + 3000,
            meta: { layer: 'interaction', index: 2, model: 'MiniMax-M2' },
          },
          {
            kind: 'step',
            role: 'assistant',
            text: 'clock.now',
            at: base + 4000,
            meta: { layer: 'interaction', tool: 'clock.now' },
          },
          {
            kind: 'reply',
            role: 'assistant',
            text: '早上好',
            at: base + 5000,
            proactive: true,
          },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

/**
 * 摆一份「退回普通对话」的记录：只有答复，没有模型记录。
 *
 * 模型不认工具时走普通对话，那一轮没记模型原话——
 * 但答复上带着轮数与模型名，页面上要看得见「问过模型」。
 */
async function seedChatPlain() {
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
          {
            kind: 'reply',
            role: 'assistant',
            text: '在呢',
            at: base + 1000,
            meta: { rounds: 1, model: 'MiniMax-M2' },
          },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

/**
 * 摆一份「单轮对话」的记录：模型那一轮说的就是答复正文。
 *
 * 这一轮点开是空的——页面上该只留「问模型 X · N 轮」那一句。
 */
async function seedChatSingleRound() {
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
          {
            kind: 'model',
            role: 'assistant',
            text: '在呢',
            at: base + 1000,
            meta: { layer: 'interaction', index: 1, model: 'MiniMax-M2' },
          },
          {
            kind: 'reply',
            role: 'assistant',
            text: '在呢',
            at: base + 2000,
            meta: { rounds: 1, model: 'MiniMax-M2' },
          },
        ],
        facts: [],
      },
    }),
    'utf8'
  );
}

/**
 * 摆一份长一点的记录：页面要长到能滚动。
 *
 * 停在最上面时新记录进来，新块直接出现在眼前——它得在视口里才看得见。
 */
async function seedChatTall() {
  const base = todayBase();
  const messages = [];
  for (let i = 0; i < 25; i += 1) {
    messages.push({ kind: 'user', role: 'user', text: `第${i + 1}句`, at: base + i * 2000 });
    messages.push({
      kind: 'reply',
      role: 'assistant',
      text: `答${i + 1}`,
      at: base + i * 2000 + 1000,
      meta: { rounds: 1, model: 'MiniMax-M2' },
    });
  }
  await mkdir(USER_DATA, { recursive: true });
  await writeFile(
    join(USER_DATA, 'assistant.json'),
    JSON.stringify({
      version: 1,
      llm: { enabled: true, ackEnabled: false },
      chat: { messages, facts: [] },
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
      // 旧记录既没有模型记录，答复上也没带轮数与模型名——不画「问过模型」那一行。
      await expect(frame.locator('#list')).not.toContainText('问模型');
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

  test('主动搭话的过程归它自己那一块', async () => {
    await seedChatProactive();
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

      // 用户问了一句、桌宠答了；过一会儿桌宠主动搭话 → 两块。
      await expect(frame.locator('.turn')).toHaveCount(2);

      // 主动搭话那块：它自己的模型原话与工具调用都在里面。
      const petTurn = frame.locator('.turn').first();
      await expect(petTurn.locator('.turn-flag')).toHaveText('桌宠自己起的头');
      await expect(petTurn.locator('.turn-title')).toHaveText('早上好');
      await expect(petTurn.locator('.lane-front')).toContainText('我看下时间');
      await expect(petTurn.locator('.lane-front')).toContainText('问了时间');
      await expect(petTurn.locator('.lane-front')).not.toContainText('我先看看');

      // 用户那块：它自己的模型原话还在自己这里。
      const user = frame.locator('.turn').nth(1);
      await expect(user.locator('.turn-title')).toHaveText('在吗');
      await expect(user.locator('.lane-front')).toContainText('我先看看');
      await expect(user.locator('.lane-front')).not.toContainText('我看下时间');
    } finally {
      await app.close();
    }
  });

  test('退回普通对话的那一轮：看得见「问过模型」', async () => {
    await seedChatPlain();
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
      await expect(frame.locator('.lane-front')).toContainText('问模型 MiniMax-M2 · 1 轮');
    } finally {
      await app.close();
    }
  });

  test('单轮对话：模型那一行不是个点开是空的盒子', async () => {
    await seedChatSingleRound();
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
      await expect(frame.locator('.detail[data-detail="model"]')).toHaveCount(0);
      await expect(frame.locator('.lane-front')).toContainText('问模型 MiniMax-M2 · 1 轮');
    } finally {
      await app.close();
    }
  });

  test('停在最新的时候：新记录看得见', async () => {
    await seedChatTall();
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
      await expect(winFrame.locator('.turn')).toHaveCount(25);

      // 停在最上面（正在看最新那条）。
      await winFrame.locator('#list').evaluate((node) => {
        node.ownerDocument.scrollingElement.scrollTop = 0;
      });

      // 回到面板说一句话。
      await pet.evaluate(() => window.pet.openPanel?.());
      await panel.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 10000 });
      await panel.fill('#query', '你好呀');
      await panel.press('#query', 'Control+Enter');

      await expect(winFrame.locator('.turn')).toHaveCount(26);
      const newest = winFrame.locator('.turn').first();
      await expect(newest.locator('.turn-title')).toHaveText('你好呀');

      // 新块就在眼前，不该被顶到视口外面去。
      await expect(newest).toBeInViewport();

      // 视口也没跳：他本来就停在最上面，新记录进来时该原地不动。
      const top = await winFrame
        .locator('#list')
        .evaluate((node) => node.ownerDocument.scrollingElement.scrollTop);
      expect(top).toBe(0);
    } finally {
      await app.close();
    }
  });
});
