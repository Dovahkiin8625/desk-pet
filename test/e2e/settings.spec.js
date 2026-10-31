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
    const settingsWin = await openSettingsWindow(ctx);

    // 用设置窗口**自己的**透明度滑块驱动保存：这条用例要覆盖的是
    // 「在设置页改透明度 → 落到宠物窗口上」这条链路，
    // 而不是从宠物窗口那边绕一圈发保存指令。
    await settingsWin.evaluate(() => {
      const input = document.getElementById('opacity');
      input.value = '0.6';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 等广播到达宠物窗口：主进程先施加透明度再广播，
    // 所以诊断面上的 opacity 变成 0.6 时，win.setOpacity() 已经跑过了。
    await ctx.win.waitForFunction(() => window.__pet.opacity === 0.6, null, { timeout: 10000 });

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

    // 断言「聚焦的正是原来那个窗口」：只看窗口个数不够——
    // 「没多开一个」和「开了一个新的又关掉旧的」在计数上是一样的。
    // 非交互会话里 focus() 未必会报告已聚焦，所以改用窗口 id：确定性强。
    const settingsWindowId = () =>
      ctx.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) =>
          x.webContents.getURL().includes('/src/settings/index.html'),
        );
        return w ? w.id : null;
      });

    const countAfterFirst = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(countAfterFirst).toBe(2);
    const idAfterFirst = await settingsWindowId();
    expect(idAfterFirst).not.toBeNull();

    await ctx.win.evaluate(() => window.pet.openSettings());
    await new Promise((r) => setTimeout(r, 500));
    const countAfterSecond = await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(countAfterSecond).toBe(2);
    // 还是**同一个**窗口 id：重复打开没有另起炉灶。
    expect(await settingsWindowId()).toBe(idAfterFirst);
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

    const state = await ctx.app.evaluate(({ BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().length,
    }));
    // 只剩宠物窗口，应用还活着
    expect(state.windows).toBe(1);
    expect(ctx.win.isClosed()).toBe(false);
    // 注：这里刻意**不**断言 app.hasSingleInstanceLock()。
    // E2E 模式下主进程根本不调用 requestSingleInstanceLock()（见 src/main/index.js），
    // 因此它恒为 false——断言它只会得到一个恒真的假断言（false confidence），
    // 而单例的真实行为由上面「重复打开只聚焦已有窗口」那条用例覆盖。
  } finally {
    await ctx.close();
  }
});

test('空 id 的切换请求不会覆盖已存的形象', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.evaluate(async () => {
      await window.pet.switchModel('natori');
    });

    // 空 id 表示「没有指定要切到哪个」，不是「切到第一个形象」：
    // 按注册表解析会把任何不认识的 id 落到第一个形象，
    // 于是 switchModel('') 会把存得好好的 modelId 覆盖掉。
    const applied = await ctx.win.evaluate(async () => await window.pet.switchModel(''));
    expect(applied).toBe('natori');

    await new Promise((r) => setTimeout(r, 500));
    const saved = JSON.parse(await readFile(join(ctx.userDataDir, 'settings.json'), 'utf8'));
    expect(saved.modelId).toBe('natori');
  } finally {
    await ctx.close();
  }
});

test('广播先于下拉框填充到达时，下拉框以广播里的形象为准', async () => {
  // 竞态回归：设置页的广播监听器先于 Promise.all([getSettings(), listModels()]) 注册，
  // 两者之间到达的 modelId 广播会撞上空的 options。
  // 没有「先记下来、等选项填好再应用」的处理时，init() 结尾会用**更旧**的
  // getSettings 结果覆盖一次，下拉框就与桌面上跑的形象脱节，
  // 而且不会有下一次广播来纠正它。
  const ctx = await launchApp();
  try {
    // 把 pet:getSettings 拖慢 1.5 秒：设置页的 init 卡在 await 里，
    // 选项还没填出来——正好落在竞态窗口内。
    const patched = await ctx.app.evaluate(({ ipcMain }) => {
      const orig = ipcMain._invokeHandlers?.get('pet:getSettings');
      if (!orig) return false;
      ipcMain.removeHandler('pet:getSettings');
      ipcMain.handle('pet:getSettings', async (...args) => {
        await new Promise((r) => setTimeout(r, 1500));
        return orig(...args);
      });
      return true;
    });
    // 用的是 Electron 的内部 API（ipcMain._invokeHandlers）：
    // 一旦 Electron 改名，这条用例就失去意义了——宁可报错，也不要静默跳过。
    expect(patched, 'ipcMain._invokeHandlers 不可用，这条竞态用例需要重写').toBe(true);

    const settingsWinPromise = ctx.app.waitForEvent('window');
    await ctx.win.evaluate(() => window.pet.openSettings());
    const settingsWin = await settingsWinPromise;

    // 趁 init 还没跑完，广播一个更新的 modelId
    await new Promise((r) => setTimeout(r, 400));
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().includes('/src/settings/index.html'),
      );
      w.webContents.send('pet:settingsChanged', {
        version: 1,
        position: null,
        modelId: 'natori',
        scale: 1,
        opacity: 1,
        visible: true,
      });
    });

    await settingsWin.waitForFunction(
      () => document.querySelectorAll('#model option').length > 0,
      null,
      { timeout: 15000 },
    );
    await new Promise((r) => setTimeout(r, 300));
    const value = await settingsWin.evaluate(() => document.getElementById('model').value);
    expect(value).toBe('natori');
  } finally {
    await ctx.close();
  }
});

test('只改透明度不会让宠物窗口重新适配模型', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);

    // 给舞台的 fitModel 装个计数器：重新适配是有代价的，
    // 广播带的是完整设置对象，不比较 scale 就会在每次广播时都白白 fit 一次。
    await ctx.win.evaluate(() => {
      const stage = window.__pet.stage;
      window.__fitCalls = 0;
      const orig = stage.fitModel.bind(stage);
      stage.fitModel = (...args) => {
        window.__fitCalls++;
        return orig(...args);
      };
    });

    // 拖透明度滑块：广播里带着没变的 scale，不该触发任何重新适配。
    await settingsWin.evaluate(() => {
      const input = document.getElementById('opacity');
      input.value = '0.6';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ctx.win.waitForFunction(() => window.__pet.opacity === 0.6, null, { timeout: 10000 });
    expect(await ctx.win.evaluate(() => window.__fitCalls)).toBe(0);

    // 拖缩放滑块：scale 真的变了，必须重新适配。
    await settingsWin.evaluate(() => {
      const input = document.getElementById('scale');
      input.value = '1.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ctx.win.waitForFunction(() => window.__pet.scale === 1.5, null, { timeout: 10000 });
    expect(await ctx.win.evaluate(() => window.__fitCalls)).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
