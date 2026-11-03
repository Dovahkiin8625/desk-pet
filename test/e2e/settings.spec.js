import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchApp, collectErrors, launchWithAssistantState, gotoSection, PET_WINDOW_URL } from './helpers.js';

/**
 * 收集渲染层与设置页的未捕获异常与 console.error。
 * 设置窗口走的是同一套 preload 与 app:// 协议，
 * 任何一步抛错都会让设置界面半死不活，必须看得见。
 * 收集器统一放在 test/e2e/helpers.js（全仓库只有一份实现）。
 */

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
    // 形象在「外观」分区——selectOption 要求元素可见。
    await gotoSection(settingsWin, 'appearance');
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
    //
    // 模型大小跟着**画布**走（画布随窗口放大而放大，模型再适配进画布），
    // 所以要等窗口尺寸落地、画布重新适配之后模型才变大——
    // 只等 __pet.scale 变了不够：那一刻画布可能还是旧的。
    await ctx.win.waitForFunction(
      (oldScale) => window.__pet.scale === 1.5 && window.__pet.model.scale.x > oldScale,
      before.modelScale,
      { timeout: 10000 },
    );
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

    const countAfterFirst = await ctx.app.evaluate(
      ({ BrowserWindow }, urls) =>
        BrowserWindow.getAllWindows().filter((w) =>
          urls.some((u) => w.webContents.getURL().includes(u))
        ).length,
      [PET_WINDOW_URL, '/src/settings/index.html']
    );
    expect(countAfterFirst).toBe(2);
    const idAfterFirst = await settingsWindowId();
    expect(idAfterFirst).not.toBeNull();

    await ctx.win.evaluate(() => window.pet.openSettings());
    await new Promise((r) => setTimeout(r, 500));
    const countAfterSecond = await ctx.app.evaluate(
      ({ BrowserWindow }, urls) =>
        BrowserWindow.getAllWindows().filter((w) =>
          urls.some((u) => w.webContents.getURL().includes(u))
        ).length,
      [PET_WINDOW_URL, '/src/settings/index.html']
    );
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

    const state = await ctx.app.evaluate(
      ({ BrowserWindow }, petUrl) => ({
        // 按 URL 数，不按窗口总数：桌宠还有「说话气泡」这个窗口，
        // 它出现与否与这条用例无关。
        windows: BrowserWindow.getAllWindows().filter((w) =>
          w.webContents.getURL().includes(petUrl)
        ).length,
      }),
      PET_WINDOW_URL
    );
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
    // switchModel 返回的是结果对象 { ok, modelId, error }：
    // 它要等渲染层回执才返回，不再是「请求即成功」。
    expect(applied.ok).toBe(true);
    expect(applied.modelId).toBe('natori');

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

test('设置窗口里能改桌面助理与语音的偏好，并落到 assistant.json', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);

    // 桌面助理与语音这两组控件要在。
    // 它们在**不同的分区**里：一次只显示一节，所以得分两次切。
    await gotoSection(settingsWin, 'assistant');
    await settingsWin.waitForSelector('#chime', { timeout: 10000 });
    expect(await settingsWin.locator('#chime').count()).toBe(1);
    await gotoSection(settingsWin, 'voice');
    await settingsWin.waitForSelector('#ttsEnabled', { timeout: 10000 });
    expect(await settingsWin.locator('#ttsEnabled').count()).toBe(1);

    // 音色建议表要有内容（来自主进程那份**验过**的清单）。
    const voiceOptions = await settingsWin.locator('#voiceList option').allTextContents();
    expect(voiceOptions.length).toBeGreaterThan(0);

    // 关掉整点报时：它存在 assistant.json 里，不是 settings.json。
    await settingsWin.evaluate(() => {
      const box = document.getElementById('chime');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });

    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        saved = JSON.parse(await readFile(join(ctx.userDataDir, 'assistant.json'), 'utf8'));
      } catch {
        saved = null;
      }
      if (saved?.chime && saved.chime.enabled === false) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.chime?.enabled, '整点报时应当被关掉').toBe(false);
  } finally {
    await ctx.close();
  }
});

test('API Key 只以掩码形式回显，明文不落到设置界面', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);
    // Key 在「语音」分区里，不切过去就点不到「保存」。
    await gotoSection(settingsWin, 'voice');
    await settingsWin.waitForSelector('#apiKey', { timeout: 10000 });

    // 初始状态：要么「未配置」，要么是一个掩码——
    // 无论如何都**不能**出现明文（项目根目录的 minimax-api-key 也会被当作来源）。
    const initial = await settingsWin.locator('#keyStatus').textContent();
    expect(initial).not.toContain('sk-cp-');
    expect(initial).not.toContain('secret-value');

    await settingsWin.evaluate(() => {
      document.getElementById('apiKey').value = 'sk-cp-secret-value-1234';
    });
    await settingsWin.click('#saveKey');
    await settingsWin.waitForFunction(
      () => document.getElementById('keyStatus').textContent.includes('已配置'),
      null,
      { timeout: 10000 }
    );

    // 界面上只有掩码：明文一个字符都不该出现。
    const shown = await settingsWin.locator('#keyStatus').textContent();
    expect(shown).toContain('****1234');
    expect(shown).not.toContain('sk-cp-secret-value');

    // 输入框也被清空了（不回显明文）。
    expect(await settingsWin.locator('#apiKey').inputValue()).toBe('');

    // key 落在 credentials.json 里，**不在** settings.json / assistant.json 里。
    const credentials = JSON.parse(
      await readFile(join(ctx.userDataDir, 'credentials.json'), 'utf8')
    );
    expect(credentials.minimaxApiKey).toBe('sk-cp-secret-value-1234');
  } finally {
    await ctx.close();
  }
});

test('设置窗口里能改对话的配置与人设，并落到 assistant.json', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);

    // 对话那一节的控件要在。
    await gotoSection(settingsWin, 'chat');
    await settingsWin.waitForSelector('#llmEnabled', { timeout: 10000 });
    expect(await settingsWin.locator('#llmBaseUrl').count()).toBe(1);
    expect(await settingsWin.locator('#llmPersonaName').count()).toBe(1);

    // 打开对话、改接口地址与人设。
    await settingsWin.evaluate(() => {
      const box = document.getElementById('llmEnabled');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      const url = document.getElementById('llmBaseUrl');
      url.value = 'http://127.0.0.1:1234/v1';
      url.dispatchEvent(new Event('change', { bubbles: true }));
      const name = document.getElementById('llmPersonaName');
      name.value = '小哈';
      name.dispatchEvent(new Event('change', { bubbles: true }));
    });

    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        saved = JSON.parse(await readFile(join(ctx.userDataDir, 'assistant.json'), 'utf8'));
      } catch {
        saved = null;
      }
      if (saved?.llm?.persona?.name === '小哈') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.llm?.enabled, '对话应当被打开').toBe(true);
    expect(saved?.llm?.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(saved?.llm?.persona?.name).toBe('小哈');
    // 没被改动的内部字段不能被抹掉（探测出来的地址、搭话时间…）。
    expect(saved?.llm?.model, '模型名应当还在').toBeTruthy();
  } finally {
    await ctx.close();
  }
});

test('「它记住的事」能在设置里看到并一键清空', async () => {
  const ctx = await launchWithAssistantState({
    version: 1,
    chat: { messages: [], facts: ['用户喜欢喝美式'] },
  });
  try {
    const settingsWin = await openSettingsWindow(ctx);
    // 「它记住的事」单独占一个分区。
    await gotoSection(settingsWin, 'memory');
    await settingsWin.waitForSelector('#llmFacts', { timeout: 10000 });

    const facts = await settingsWin.locator('#llmFacts li').allTextContents();
    expect(facts).toContain('用户喜欢喝美式');

    await settingsWin.click('#clearFacts');
    let saved = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        saved = JSON.parse(await readFile(join(ctx.userDataDir, 'assistant.json'), 'utf8'));
      } catch {
        saved = null;
      }
      if (saved?.chat?.facts?.length === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.chat?.facts, '记住的事应当被清空').toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('设置窗口按分区显示：一次只显示一个区', async () => {
  const ctx = await launchApp();
  const errors = [];
  collectErrors(ctx.win, errors);
  try {
    const settingsWin = await openSettingsWindow(ctx);
    collectErrors(settingsWin, errors);

    const keys = ['appearance', 'assistant', 'voice', 'chat', 'memory'];
    for (const key of keys) {
      await gotoSection(settingsWin, key);
      for (const other of keys) {
        const visible = await settingsWin.locator(`#panel-${other}`).isVisible();
        expect(visible, `显示「${key}」时，「${other}」不该同时可见`).toBe(other === key);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('目录上的状态摘要跟着当前状态走', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);
    const summary = async (key) =>
      (await settingsWin.locator(`[data-summary="${key}"]`).textContent()).trim();

    // 摘要要等初始化填完值才有意义。
    await settingsWin.waitForFunction(
      () => document.querySelector('[data-summary="appearance"]').textContent.trim() !== '—',
      null,
      { timeout: 10000 },
    );
    // 外观：当前形象的名字。
    expect(await summary('appearance')).toBe('Haru');
    // 助理：默认开着 4 项（报时/问候/提示音/太热），共 6 项。
    expect(await summary('assistant')).toBe('4/6');
    // 语音与对话默认关着；还没记住任何事。
    expect(await summary('voice')).toBe('已关');
    expect(await summary('chat')).toBe('已关');
    expect(await summary('memory')).toBe('0 条');

    // 关掉「整点报时」→ 摘要变成 3/6。
    await gotoSection(settingsWin, 'assistant');
    await settingsWin.evaluate(() => {
      const box = document.getElementById('chime');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settingsWin.waitForFunction(
      () => document.querySelector('[data-summary="assistant"]').textContent.trim() === '3/6',
      null,
      { timeout: 10000 },
    );

    // 语音的摘要是三态：开关开了但没填 Key 时要说「缺 Key」，
    // 不能只说「已开」——那正好盖住用户最常踩的坑。
    // 期望值从页面自己算：key 有没有，看 #keyStatus 的 data-configured
    // （开发期根目录里的 minimax-api-key 也算来源，不能写死）。
    await gotoSection(settingsWin, 'voice');
    await settingsWin.evaluate(() => {
      const box = document.getElementById('ttsEnabled');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const expectedVoice = await settingsWin.evaluate(() => {
      const keyOk = document.getElementById('keyStatus').dataset.configured === 'true';
      return keyOk ? '已开' : '缺 Key';
    });
    await settingsWin.waitForFunction(
      (want) => document.querySelector('[data-summary="voice"]').textContent.trim() === want,
      expectedVoice,
      { timeout: 10000 },
    );
  } finally {
    await ctx.close();
  }
});

test('方向键可以在分区之间移动', async () => {
  const ctx = await launchApp();
  try {
    const settingsWin = await openSettingsWindow(ctx);
    await settingsWin.locator('#tab-appearance').focus();
    await settingsWin.keyboard.press('ArrowDown');
    await settingsWin.waitForSelector('#panel-assistant', { state: 'visible', timeout: 10000 });
    expect(await settingsWin.locator('#tab-assistant').getAttribute('aria-selected')).toBe('true');
    expect(await settingsWin.locator('#tab-appearance').getAttribute('aria-selected')).toBe('false');
  } finally {
    await ctx.close();
  }
});
