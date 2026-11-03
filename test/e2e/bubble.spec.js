import { test, expect } from '@playwright/test';
import {
  launchApp,
  collectErrors,
  launchWithAssistantState,
  waitForWindow,
  pageFor,
} from './helpers.js';

/**
 * 桌宠的「说话气泡」。
 *
 * 气泡是**独立窗口**，不是画在桌宠窗口里的 DOM：
 * 桌宠窗口 300×560 被角色占满，气泡画在它上面就是盖住角色的脸。
 *
 * 气泡现在只负责「桌宠说了句什么」——输入框那种形态已经下线了，
 * 输入统一由插件面板负责（见 src/main/bubble.js）。
 */
const BUBBLE_URL = '/src/renderer/bubble/index.html';

/** 预置一条已经到点的提醒：应用一起来就该播报它（于是弹一个气泡）。 */
function launchWithDueReminder(text = '喝水') {
  return launchWithAssistantState({
    version: 1,
    reminders: [
      { id: 'r-1', text, at: Date.now() - 1000, createdAt: Date.now(), fired: false },
    ],
  });
}

test('气泡窗口是懒创建的：应用启动时并不存在', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    // 启动时只有宠物窗口。气泡在第一次有消息时才建——
    // 这不只是性能问题：E2E 的 app.firstWindow() 认的是「第一个窗口」，
    // 气泡若先于宠物窗口出现，整个套件都会超时。
    const urls = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
    );
    expect(urls.filter((u) => u.includes(BUBBLE_URL))).toEqual([]);
    expect(urls.some((u) => u.includes('/src/renderer/index.html'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('桌宠说话时气泡窗口出现，并显示内容', async () => {
  const ctx = await launchWithDueReminder();
  const errors = collectErrors(ctx.win);
  try {
    const win = await waitForWindow(ctx, BUBBLE_URL);
    expect(win, '气泡窗口应当被创建出来').toBeTruthy();
    expect(win.visible).toBe(true);

    const bubblePage = pageFor(ctx, BUBBLE_URL);
    expect(bubblePage, '气泡窗口应当有一个对应的页面').toBeTruthy();
    await bubblePage.waitForFunction(
      () => document.getElementById('text')?.textContent.includes('喝水'),
      null,
      { timeout: 10000 }
    );
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('气泡点击穿透，不挡桌面的点击', async () => {
  const ctx = await launchWithDueReminder();
  const errors = collectErrors(ctx.win);
  try {
    const win = await waitForWindow(ctx, BUBBLE_URL);
    expect(win, '气泡窗口应当被创建出来').toBeTruthy();
    // 气泡不接收鼠标事件：
    // Windows 没有逐像素命中测试，整个窗口矩形都是热区——
    // 气泡要是吃掉了桌面的点击，用户会以为桌面坏了。
    const bubblePage = pageFor(ctx, BUBBLE_URL);
    const state = await bubblePage.evaluate(() => window.bubble.getState());
    expect(state.interactive, '气泡应当是点击穿透的').toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('气泡贴在桌宠旁边，不盖住角色', async () => {
  const ctx = await launchWithDueReminder();
  const errors = collectErrors(ctx.win);
  try {
    const bubble = await waitForWindow(ctx, BUBBLE_URL);
    expect(bubble).toBeTruthy();

    const pet = await ctx.app.evaluate(({ BrowserWindow }, petUrl) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(petUrl));
      return w ? w.getBounds() : null;
    }, '/src/renderer/index.html');

    // 气泡与桌宠窗口**不该重叠**：盖住角色的脸是最糟的结果。
    const overlaps =
      bubble.bounds.x < pet.x + pet.width &&
      bubble.bounds.x + bubble.bounds.width > pet.x &&
      bubble.bounds.y < pet.y + pet.height &&
      bubble.bounds.y + bubble.bounds.height > pet.y;
    expect(overlaps, '气泡与桌宠窗口重叠了').toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
