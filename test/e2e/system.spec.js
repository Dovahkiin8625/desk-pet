import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchApp,
  launchWithMenuProbe,
  collectErrors,
  dragBy,
  dragToRightEdge,
  moveToTopLeft,
  petBounds,
  waitForSystemState,
} from './helpers.js';

/**
 * 系统级功能（第六部分）的端到端用例。
 *
 * 本任务先只放「总音量」这一条：它要证明的是
 * 「主进程是唯一的状态来源」——设置窗口改的值，
 * 经主进程推到渲染层，渲染层把它用在自己的主增益上。
 */
test('总音量传到了渲染层', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    await ctx.win.evaluate(async () => {
      await window.pet.saveAssistantPrefs({ sound: { volume: 0.3 } });
    });
    await ctx.win.waitForFunction(() => window.__pet.volume === 0.3, null, { timeout: 10000 });
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('穿透模式：打开后主进程上报穿透状态', async () => {
  const ctx = await launchApp();
  try {
    const before = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(before.clickThroughActive).toBe(false);

    await ctx.win.evaluate(() => window.pet.saveSettings({ clickThrough: true }));
    const on = await waitForSystemState(ctx, (s) => s.clickThroughActive === true);
    expect(on.clickThrough, '穿透应当真的被打开了').toBe(true);
    expect(on.clickThroughActive, '穿透应当真的生效了').toBe(true);

    // 关掉：点击要还给窗口。
    await ctx.win.evaluate(() => window.pet.saveSettings({ clickThrough: false }));
    const off = await waitForSystemState(ctx, (s) => s.clickThroughActive === false);
    expect(off.clickThrough, '穿透应当真的被关掉了').toBe(false);
    expect(off.clickThroughActive, '穿透应当真的不再生效了').toBe(false);
  } finally {
    await ctx.close();
  }
});

test('托盘点「鼠标穿透」能真的切换，并让菜单勾选态跟着变', async () => {
  const ctx = await launchWithMenuProbe();
  try {
    const before = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(before.clickThrough).toBe(false);

    // 真的点托盘菜单里的那一项——走的是 index.js 的接线，
    // 不是 IPC 的 saveSettings。
    await ctx.clickMenuItem('鼠标穿透');

    // 状态真的变了。
    const after = await waitForSystemState(ctx, (s) => s.clickThrough === true);
    expect(after.clickThrough, '点菜单项应当真的把穿透打开').toBe(true);

    // 菜单被重建了，新的一份里「鼠标穿透」是勾上的。
    //
    // 原始模板要进主进程去取：helpers 的 probe() 只回传了标签摘要，
    // 勾选状态在原始项的 checked 上。这里按调用栈认托盘菜单，
    // 不靠「templates 的最后一份就是它」这种顺序上的运气。
    const menus = await ctx.app.evaluate(() =>
      globalThis.__menuProbe.templates.map((t) => ({
        stack: t.stack,
        items: t.template.map((i) => ({ label: i.label, type: i.type, checked: i.checked })),
      })),
    );
    const trayMenus = menus.filter((m) => m.stack.includes('buildTrayMenu'));
    // 重建过一次：启动那份之外还得多一份。
    expect(trayMenus.length, '托盘菜单应当被重建过').toBeGreaterThanOrEqual(2);
    const last = trayMenus[trayMenus.length - 1];
    const item = last.items.find((i) => i.label === '鼠标穿透');
    expect(item, '菜单里应当还有「鼠标穿透」这一项').toBeTruthy();
    expect(item.checked, '菜单里的「鼠标穿透」应当是勾上的').toBe(true);
  } finally {
    await ctx.close();
  }
});

test('拖到屏幕边缘会贴齐；开了「贴边隐藏」会滑出去只留一条边', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);

    // 往右推到底：窗口被夹到右边缘。
    await dragToRightEdge(ctx);

    const bounds = await petBounds(ctx);
    const wa = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    // 停靠后窗口大部分在屏幕外，只剩 24px 落在工作区里。
    expect(wa.x + wa.width - bounds.x).toBe(24);

    const state = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe('right');
  } finally {
    await ctx.close();
  }
});

test('停靠后拖那条窄边能把桌宠拽回来', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);
    await dragToRightEdge(ctx);
    expect((await ctx.win.evaluate(() => window.pet.getSystemState())).dock).toBe('right');

    // 抓住窄边往左拽。
    await dragBy(ctx.win, -400, 0);
    const state = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe(null);

    const bounds = await petBounds(ctx);
    const wa = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    // 完全可见：窗口右边缘贴齐工作区右边缘。
    expect(bounds.x + bounds.width).toBe(wa.x + wa.width);
  } finally {
    await ctx.close();
  }
});

test('停靠状态重启后仍然停靠', async () => {
  // **必须自己指定 userData 目录**：launchApp() 不带参数时用的是临时目录，
  // close() 会把它删掉——那样第二次启动读到的就是别人的（干净的）目录。
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-dock-'));
  const userDataDir = join(dir, 'userData');
  await mkdir(userDataDir, { recursive: true });

  const ctx = await launchApp({ userDataDir });
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);
    await dragToRightEdge(ctx);
    expect((await ctx.win.evaluate(() => window.pet.getSystemState())).dock).toBe('right');
  } finally {
    await ctx.close();
  }

  // 用同一个 userData 目录再启动一次。
  const again = await launchApp({ userDataDir });
  try {
    const state = await again.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe('right');
    const bounds = await petBounds(again);
    const wa = await again.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    expect(wa.x + wa.width - bounds.x).toBe(24);
  } finally {
    await again.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('关掉「贴边隐藏」时，停靠中的桌宠立刻取回', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: true }));
    await moveToTopLeft(ctx);
    await dragToRightEdge(ctx);
    expect((await ctx.win.evaluate(() => window.pet.getSystemState())).dock).toBe('right');

    await ctx.win.evaluate(() => window.pet.saveSettings({ dockEnabled: false }));
    const state = await ctx.win.evaluate(() => window.pet.getSystemState());
    expect(state.dock).toBe(null);

    const bounds = await petBounds(ctx);
    const wa = await ctx.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    expect(bounds.x + bounds.width).toBe(wa.x + wa.width);
  } finally {
    await ctx.close();
  }
});
