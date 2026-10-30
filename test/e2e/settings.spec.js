import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp } from './helpers.js';

/**
 * 收集渲染层的未捕获异常与 console.error。
 * 设置窗口走的是同一套 preload 与 app:// 协议，
 * 任何一步抛错都会让设置界面半死不活，必须看得见。
 */
function collectErrors(page, bucket) {
  page.on('pageerror', (err) => bucket.push(`pageerror: ${err?.message || err}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.push(`console.error: ${msg.text()}`);
  });
}

/** 打开设置窗口并等到它加载完毕。 */
async function openSettingsWindow(ctx) {
  // 先挂监听再触发：openSettings 返回时窗口已经建好，
  // 晚一步挂监听就会错过 'window' 事件。
  const settingsWinPromise = ctx.app.waitForEvent('window');
  await ctx.win.evaluate(() => window.pet.openSettings());
  const settingsWin = await settingsWinPromise;
  await settingsWin.waitForLoadState('domcontentloaded');
  await settingsWin.waitForFunction(() => document.querySelectorAll('#model option').length > 0);
  return settingsWin;
}

test('设置窗口可打开并列出全部形象', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    const settingsWin = await openSettingsWindow(ctx);
    collectErrors(settingsWin, errors);
    const labels = await settingsWin.locator('#model option').allTextContents();
    expect(labels).toEqual(['Haru', 'Natori']);

    // 选中 Natori 后宠物窗口应切换形象
    await settingsWin.locator('#model').selectOption('natori');
    await ctx.win.waitForFunction(() => window.__pet.modelId === 'natori', null, { timeout: 20000 });
    const modelId = await ctx.win.evaluate(() => window.__pet.modelId);
    expect(modelId).toBe('natori');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('切换形象与调整缩放生效并被持久化', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(async () => {
      await window.pet.switchModel('natori');
    });
    await ctx.win.evaluate(async () => {
      await window.pet.saveSettings({ scale: 1.4, opacity: 0.8 });
    });
    await new Promise((r) => setTimeout(r, 500));

    // 说明：Electron 主进程的 evaluate 里既不能用动态 import
    // （"A dynamic import callback was not specified"），也没有 require，
    // 因此直接读测试进程这边的 userData 目录——那正是 app.getPath('userData')。
    const saved = JSON.parse(await readFile(join(ctx.userDataDir, 'settings.json'), 'utf8'));
    expect(saved.modelId).toBe('natori');
    expect(saved.scale).toBe(1.4);
    expect(saved.opacity).toBe(0.8);
  } finally {
    await ctx.close();
  }
});

test('只改缩放不换形象也立刻在宠物窗口生效', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    const settingsWin = await openSettingsWindow(ctx);
    collectErrors(settingsWin, errors);

    const before = await ctx.win.evaluate(() => ({
      scale: window.__pet.scale,
      modelScale: window.__pet.model.scale.x,
    }));

    // 直接改滑块并派发 input：走的是真实交互路径。
    await settingsWin.evaluate(() => {
      const input = document.getElementById('scale');
      input.value = '1.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // 缩放要立刻生效：不等切换形象，也不等落盘（落盘有 300ms 防抖）。
    await ctx.win.waitForFunction(() => window.__pet.scale === 1.5, null, { timeout: 10000 });
    const after = await ctx.win.evaluate(() => ({
      scale: window.__pet.scale,
      modelScale: window.__pet.model.scale.x,
      modelId: window.__pet.modelId,
    }));
    // 形象没换，只是重新适配了缩放
    expect(after.modelId).toBe('haru');
    expect(after.modelScale).toBeGreaterThan(before.modelScale);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('透明度施加在宠物窗口上，而不是设置窗口', async () => {
  const ctx = await launchApp();
  try {
    await openSettingsWindow(ctx);
    await ctx.win.evaluate(() => window.pet.saveSettings({ opacity: 0.6 }));

    const windows = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        url: w.webContents.getURL(),
        opacity: w.getOpacity(),
      })),
    );
    const pet = windows.find((w) => w.url.includes('/src/renderer/index.html'));
    const settings = windows.find((w) => w.url.includes('/src/settings/index.html'));
    expect(pet).toBeTruthy();
    expect(settings).toBeTruthy();
    expect(Math.abs(pet.opacity - 0.6)).toBeLessThan(0.01);
    // 设置窗口不该被顺带改掉透明度
    expect(Math.abs(settings.opacity - 1)).toBeLessThan(0.01);
  } finally {
    await ctx.close();
  }
});

test('设置窗口是单例，重复打开只聚焦已有窗口', async () => {
  const ctx = await launchApp();
  try {
    await openSettingsWindow(ctx);
    const countAfterFirst = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(countAfterFirst).toBe(2);

    await ctx.win.evaluate(() => window.pet.openSettings());
    await new Promise((r) => setTimeout(r, 500));
    const countAfterSecond = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(countAfterSecond).toBe(2);
  } finally {
    await ctx.close();
  }
});

test('切换到未知形象时下拉框与实际生效的形象保持一致', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    const settingsWin = await openSettingsWindow(ctx);
    collectErrors(settingsWin, errors);

    // 走主进程：未知 id 会按注册表回退到第一个形象。
    await settingsWin.evaluate(() => window.pet.switchModel('__no_such_model__'));
    await ctx.win.waitForFunction(() => window.__pet.modelId === 'haru', null, { timeout: 20000 });

    // 下拉框必须显示实际生效的那个，而不是空白或请求里的那个。
    await settingsWin.waitForFunction(
      () => document.getElementById('model').value === 'haru',
      null,
      { timeout: 10000 },
    );
    const selected = await settingsWin.evaluate(() => document.getElementById('model').value);
    expect(selected).toBe('haru');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('关闭设置窗口不会退出应用', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);
    await settingsWin.close();
    await new Promise((r) => setTimeout(r, 500));

    const state = await ctx.app.evaluate(({ app, BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().length,
      hasSingleInstanceLock: app.hasSingleInstanceLock(),
    }));
    // 只剩宠物窗口，应用还活着
    expect(state.windows).toBe(1);
    expect(ctx.win.isClosed()).toBe(false);
  } finally {
    await ctx.close();
  }
});
