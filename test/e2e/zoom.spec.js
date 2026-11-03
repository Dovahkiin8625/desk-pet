import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, collectErrors } from './helpers.js';

/**
 * 在画布上派发一次滚轮事件。
 *
 * deltaY > 0 是向下滚（缩小），< 0 是向上滚（放大）。
 * ctrl 决定这是不是「调整大小」的手势。
 */
const wheel = (win, { deltaY, ctrl = true }) =>
  win.evaluate(
    ({ deltaY, ctrl }) => {
      const canvas = window.__pet.stage.app.view;
      canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY, ctrlKey: ctrl, bubbles: true, cancelable: true }),
      );
    },
    { deltaY, ctrl },
  );

/** 宠物窗口当前的尺寸与画布尺寸。 */
const sizes = (ctx) =>
  ctx.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes('/src/renderer/index.html'),
    );
    const [width, height] = w.getSize();
    const [contentWidth, contentHeight] = w.getContentSize();
    return { width, height, contentWidth, contentHeight };
  });

/**
 * 模型在画布里的包围盒，以及它是否完整落在画布内。
 *
 * 「完整落在画布内」是本文件的核心断言：
 * 放大之后模型还必须整个在窗口里，否则上半身会被窗口边界切掉。
 */
const modelBounds = (ctx) =>
  ctx.win.evaluate(() => {
    const app = window.__pet.stage.app;
    const b = window.__pet.model.getBounds();
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      canvasWidth: app.screen.width,
      canvasHeight: app.screen.height,
      scale: window.__pet.model.scale.x,
    };
  });

test('Ctrl+滚轮放大桌宠：缩放变大、窗口跟着变大、设置被持久化', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    const before = await ctx.win.evaluate(() => ({
      scale: window.__pet.scale,
      canvasWidth: window.__pet.stage.app.screen.width,
      canvasHeight: window.__pet.stage.app.screen.height,
    }));
    const sizeBefore = await sizes(ctx);

    // 向上滚 = 放大
    await wheel(ctx.win, { deltaY: -100 });
    await ctx.win.waitForFunction(() => window.__pet.scale > 1, null, { timeout: 10000 });

    // 窗口与画布都要跟着变大：桌宠窗口是无边框的，
    // 窗口不变而模型变大，模型的上半身就被窗口切掉了。
    await ctx.win.waitForFunction(
      (h) => window.__pet.stage.app.screen.height > h,
      before.canvasHeight,
      { timeout: 10000 },
    );
    const sizeAfter = await sizes(ctx);
    expect(sizeAfter.height).toBeGreaterThan(sizeBefore.height);

    // 画布尺寸必须等于窗口的内容区尺寸：渲染层是按画布适配模型的，
    // 两者对不上，模型与窗口的边界就对不上。
    const after = await ctx.win.evaluate(() => ({
      scale: window.__pet.scale,
      canvasWidth: window.__pet.stage.app.screen.width,
      canvasHeight: window.__pet.stage.app.screen.height,
    }));
    expect(after.scale).toBeGreaterThan(before.scale);
    // 缩放要对齐到设置窗口滑块的刻度（0.05），
    // 否则滑块会把显示出来的数字吸附到别的刻度上。
    expect(Math.abs(after.scale / 0.05 - Math.round(after.scale / 0.05))).toBeLessThan(1e-9);
    expect(after.canvasWidth).toBeGreaterThan(before.canvasWidth);
    expect(after.canvasHeight).toBeGreaterThan(before.canvasHeight);
    expect(sizeAfter.contentWidth).toBe(after.canvasWidth);
    expect(sizeAfter.contentHeight).toBe(after.canvasHeight);

    // 浏览器页面缩放不能被这个手势劫持：
    // Chromium 里 Ctrl+滚轮默认是缩放网页，不拦住的话整个窗口会被放大。
    const zoomFactor = await ctx.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().includes('/src/renderer/index.html'),
      );
      return w.webContents.getZoomFactor();
    });
    expect(zoomFactor).toBe(1);

    // 缩放要落盘：滚动一下就退出的话，设置不能丢。
    await new Promise((r) => setTimeout(r, 600));
    const saved = JSON.parse(await readFile(join(ctx.userDataDir, 'settings.json'), 'utf8'));
    expect(saved.scale).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('不按 Ctrl 的滚轮不改变大小', async () => {
  const ctx = await launchApp();
  try {
    const before = await ctx.win.evaluate(() => window.__pet.scale);
    await wheel(ctx.win, { deltaY: -100, ctrl: false });
    await new Promise((r) => setTimeout(r, 500));
    expect(await ctx.win.evaluate(() => window.__pet.scale)).toBe(before);
  } finally {
    await ctx.close();
  }
});

test('向下滚轮缩小，缩放有下限', async () => {
  const ctx = await launchApp();
  try {
    const before = await ctx.win.evaluate(() => window.__pet.scale);
    await wheel(ctx.win, { deltaY: 100 });
    await ctx.win.waitForFunction((s) => window.__pet.scale < s, before, { timeout: 10000 });

    // 一直往下滚也不能低于下限。
    for (let i = 0; i < 40; i++) await wheel(ctx.win, { deltaY: 100 });
    await new Promise((r) => setTimeout(r, 500));
    expect(await ctx.win.evaluate(() => window.__pet.scale)).toBeGreaterThanOrEqual(0.5);
  } finally {
    await ctx.close();
  }
});

test('放大到最大时模型仍完整落在画布内（不再被上边缘截断）', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    // 直接把缩放推到上限（走的是设置窗口那条同样的链路）。
    await ctx.win.evaluate(async () => {
      await window.pet.saveSettings({ scale: 2 });
    });
    await ctx.win.waitForFunction(() => window.__pet.scale === 2, null, { timeout: 10000 });
    // 等窗口尺寸与画布适配稳定下来。
    await ctx.win.waitForFunction(
      () => window.__pet.stage.app.screen.height > 560,
      null,
      { timeout: 10000 },
    );

    const b = await modelBounds(ctx);
    // 画布必须比基准视口大：窗口确实跟着放大了。
    expect(b.canvasHeight).toBeGreaterThan(560);
    // 模型必须整个落在画布里——这是「上方不被截断」的直接断言。
    // 修复前窗口是固定尺寸而模型按缩放放大，包围盒会超出画布上边缘。
    expect(b.y).toBeGreaterThanOrEqual(-0.5);
    expect(b.y + b.height).toBeLessThanOrEqual(b.canvasHeight + 0.5);
    expect(b.x).toBeGreaterThanOrEqual(-0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(b.canvasWidth + 0.5);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('放大后窗口仍完整落在可见工作区内，且保存的位置与窗口一致', async () => {
  const ctx = await launchApp();
  try {
    // 桌宠默认就在主显示器右下角——那是最容易顶出屏幕的位置。
    await ctx.win.evaluate(async () => {
      await window.pet.saveSettings({ scale: 2 });
    });
    await ctx.win.waitForFunction(() => window.__pet.scale === 2, null, { timeout: 10000 });
    await ctx.win.waitForFunction(
      () => window.__pet.stage.app.screen.height > 560,
      null,
      { timeout: 10000 },
    );

    const state = await ctx.app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().includes('/src/renderer/index.html'),
      );
      const [x, y] = w.getPosition();
      const [width, height] = w.getSize();
      const wa = screen.getPrimaryDisplay().workArea;
      return { x, y, width, height, wa };
    });
    // 窗口必须完整落在可见工作区内：角色的头不能跑到屏幕外面去。
    expect(state.x).toBeGreaterThanOrEqual(state.wa.x);
    expect(state.y).toBeGreaterThanOrEqual(state.wa.y);
    expect(state.x + state.width).toBeLessThanOrEqual(state.wa.x + state.wa.width);
    expect(state.y + state.height).toBeLessThanOrEqual(state.wa.y + state.wa.height);

    // 保存的位置必须与窗口现在的实际位置一致：
    // 尺寸变了之后，左上角坐标不再指向同一个锚点，不跟着更新就会跳位。
    await new Promise((r) => setTimeout(r, 600));
    const saved = JSON.parse(await readFile(join(ctx.userDataDir, 'settings.json'), 'utf8'));
    expect(saved.position).toEqual({ x: state.x, y: state.y });
  } finally {
    await ctx.close();
  }
});

test('逐级放大过程中模型始终完整落在画布内', async () => {
  const ctx = await launchApp();
  try {
    for (const scale of [1.25, 1.5, 1.75, 2]) {
      await ctx.win.evaluate(async (s) => {
        await window.pet.saveSettings({ scale: s });
      }, scale);
      await ctx.win.waitForFunction((s) => window.__pet.scale === s, scale, { timeout: 10000 });
      // 等这一级的窗口尺寸落地。
      await ctx.win.waitForFunction(
        (s) => {
          const app = window.__pet.stage.app;
          return Math.abs(app.screen.height - Math.round(560 * s)) <= 2;
        },
        scale,
        { timeout: 10000 },
      );
      const b = await modelBounds(ctx);
      expect(b.y, `缩放 ${scale} 时模型上边缘超出画布`).toBeGreaterThanOrEqual(-0.5);
      expect(b.y + b.height, `缩放 ${scale} 时模型下边缘超出画布`).toBeLessThanOrEqual(
        b.canvasHeight + 0.5,
      );
      expect(b.x, `缩放 ${scale} 时模型左边缘超出画布`).toBeGreaterThanOrEqual(-0.5);
      expect(b.x + b.width, `缩放 ${scale} 时模型右边缘超出画布`).toBeLessThanOrEqual(
        b.canvasWidth + 0.5,
      );
    }
  } finally {
    await ctx.close();
  }
});
