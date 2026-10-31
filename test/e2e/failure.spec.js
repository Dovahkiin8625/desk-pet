import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchApp } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_MAIN = join(ROOT, 'src', 'main', 'index.js');
const REGISTRY = join(ROOT, 'assets', 'live2d', 'index.json');

// 一个「注册了、但文件不存在」的形象：它的 model3.json 必然 404，
// 于是模型必然加载失败——用来复现「切换形象失败」与「启动加载失败」两条路径。
const BROKEN_ID = 'e2e-broken';

/**
 * 临时把一个坏形象写进注册表。
 *
 * 必须改**磁盘上**的那份：主进程按注册表解析请求的 id，
 * 不认识的 id 会被解析成注册表首项（于是根本不会去加载那个坏模型）。
 *
 * 恢复由调用方负责（finally 里写回原文件）。
 * Playwright 的配置是 workers: 1 且 fullyParallel: false——用例串行执行，
 * 不会有另一条用例在这段时间里读到被改过的注册表。
 */
async function addBrokenModelToRegistry() {
  const original = await readFile(REGISTRY, 'utf8');
  const parsed = JSON.parse(original);
  parsed.models = [
    ...parsed.models,
    {
      id: BROKEN_ID,
      name: 'E2E Broken',
      manifest: `${BROKEN_ID}/pet.json`,
      model3: `${BROKEN_ID}.model3.json`,
    },
  ];
  await writeFile(REGISTRY, JSON.stringify(parsed, null, 2), 'utf8');
  return original;
}

async function restoreRegistry(original) {
  await writeFile(REGISTRY, original, 'utf8');
}

/** 打开设置窗口并等到它加载完毕。 */
async function openSettingsWindow(ctx) {
  const settingsWinPromise = ctx.app.waitForEvent('window');
  await ctx.win.evaluate(() => window.pet.openSettings());
  const settingsWin = await settingsWinPromise;
  await settingsWin.waitForLoadState('domcontentloaded');
  await settingsWin.waitForFunction(() => document.querySelectorAll('#model option').length > 0);
  return settingsWin;
}

test('切换形象失败时回滚到屏幕上那个形象，并在设置窗口报告失败', async () => {
  // spec §4.5 第 4 步：失败则回滚到原形象并提示。
  //
  // 修复前：主进程先落盘再通知渲染层，且收不到回执——
  // 加载失败时磁盘写着新 id、设置窗口显示「已切换到 …」，桌面上还是旧形象。
  const original = await addBrokenModelToRegistry();
  let ctx = null;
  try {
    ctx = await launchApp();
    const settingsWin = await openSettingsWindow(ctx);

    // 启动时屏幕上跑的是 Haru，磁盘上也必须是 Haru。
    expect(await ctx.win.evaluate(() => window.__pet.modelId)).toBe('haru');

    const result = await settingsWin.evaluate(async (brokenId) => {
      const select = document.getElementById('model');
      select.value = brokenId;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      // 等状态栏给出结论（成功或失败）。
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (document.getElementById('status').textContent) {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      });
      return {
        status: document.getElementById('status').textContent,
        dropdown: select.value,
      };
    }, BROKEN_ID);

    // 设置窗口必须报告**失败**，不能报成功。
    expect(result.status).toContain('切换失败');
    expect(result.status).not.toContain('已切换到');
    // 下拉框必须回到屏幕上那个形象。
    expect(result.dropdown).toBe('haru');

    // 桌面上仍然是 Haru，且渲染层记下了失败原因。
    const pet = await ctx.win.evaluate(() => ({
      modelId: window.__pet.modelId,
      switchError: window.__pet.switchError || null,
      stageChildren: window.__pet.stage.app.stage.children.length,
    }));
    expect(pet.modelId).toBe('haru');
    expect(pet.switchError).not.toBeNull();
    // 失败的加载不能把旧模型也带走。
    expect(pet.stageChildren).toBe(1);

    // 磁盘上的 modelId 必须仍然指向屏幕上那个形象。
    await new Promise((r) => setTimeout(r, 800));
    const saved = JSON.parse(await readFile(join(ctx.userDataDir, 'settings.json'), 'utf8'));
    expect(saved.modelId).toBe('haru');
  } finally {
    await ctx?.close();
    await restoreRegistry(original);
  }
});

test('启动时模型加载失败，错误必须传到主进程（不是只留在渲染层）', async () => {
  // 全新 clone 没跑 npm run setup 时就是这个状态：
  // 渲染层 console.* 不进终端，用户在 npm start 里只看到一份干净的日志
  // 和一个全透明的空窗口——完全不可见的失败。
  const original = await addBrokenModelToRegistry();
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-boot-fail-'));
  const userDataDir = join(dir, 'userData');
  await mkdir(userDataDir, { recursive: true });
  // 让应用启动时就去加载那个坏形象。
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify(
      { version: 1, position: null, modelId: BROKEN_ID, scale: 1, opacity: 1, visible: true },
      null,
      2
    ),
    'utf8'
  );

  let ctx = null;
  const stderrChunks = [];
  const stdoutChunks = [];
  try {
    // 自己启动应用（而不是用 launchApp）：必须在**主进程报出失败之前**
    // 就把 stdout/stderr 挂上监听，否则那条日志会被错过。
    const app = await electron.launch({
      args: [APP_MAIN],
      cwd: ROOT,
      env: {
        ...process.env,
        DESK_PET_E2E: '1',
        DESK_PET_USER_DATA: userDataDir,
      },
    });
    const proc = app.process();
    proc?.stdout?.on('data', (chunk) => stdoutChunks.push(String(chunk)));
    proc?.stderr?.on('data', (chunk) => stderrChunks.push(String(chunk)));
    const win = await app.firstWindow();
    await win.waitForFunction(() => window.__pet && window.__pet.ready === true, null, { timeout: 30000 });
    ctx = { app, win, userDataDir };

    const renderer = await ctx.win.evaluate(() => ({
      error: window.__pet.error || null,
      modelLoaded: window.__pet.modelLoaded === true,
      ready: window.__pet.ready === true,
    }));
    // 渲染层自己也留了痕。
    expect(renderer.error).not.toBeNull();
    expect(renderer.modelLoaded).toBe(false);
    expect(renderer.ready).toBe(true);

    // 失败必须**看得见**：画布上有一块占位提示，不是全透明的空窗口。
    const opaque = await ctx.win.evaluate(() => {
      const app = window.__pet.stage.app;
      const raw = app.renderer.plugins.extract._rawPixels(app.stage);
      let n = 0;
      for (let i = 3; i < raw.pixels.length; i += 4) if (raw.pixels[i] > 8) n += 1;
      return n;
    });
    expect(opaque, '画布上应看得见失败占位提示').toBeGreaterThan(0);

    // 主进程收到了失败报告：它把磁盘上的 modelId 回退到了注册表首项
    // （否则下次启动还会加载同一个坏模型，桌宠永久空白）。
    await new Promise((r) => setTimeout(r, 1000));
    const saved = JSON.parse(await readFile(join(userDataDir, 'settings.json'), 'utf8'));
    expect(saved.modelId).toBe('haru');

    // 主进程的输出里有失败原因——用户在终端里能看见。
    await ctx.win.waitForTimeout(300);
    const output = stderrChunks.join('') + stdoutChunks.join('');
    expect(output, '主进程输出里应能看到模型加载失败').toContain('模型加载失败');
  } finally {
    await ctx?.app.close();
    await restoreRegistry(original);
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 延迟宠物窗口页面加载的临时入口。
 *
 * 用途：制造一个**确定的**「启动窗口」——渲染层在这段时间里还没注册
 * 任何监听器，因此主进程此刻发出的推送频道会被丢弃
 * （Electron 的 webContents.send 对尚未注册监听器的页面是丢弃，不是排队）。
 */
function delayedLoadEntrySource(delayMs) {
  const mainUrl = pathToFileURL(APP_MAIN).href;
  return `
import { BrowserWindow } from 'electron';

const originalLoad = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function (url, ...rest) {
  if (String(url).includes('/src/renderer/index.html')) {
    return new Promise((resolve) => {
      setTimeout(() => {
        Promise.resolve(originalLoad.call(this, url, ...rest)).then(resolve, resolve);
      }, ${delayMs});
    });
  }
  return originalLoad.call(this, url, ...rest);
};

await import(${JSON.stringify(mainUrl)});
`;
}

test('启动期间发出的切换请求不会丢：主进程排队，渲染层就绪后补发', async () => {
  // 修复前：渲染层在首次 mountModel **之后**才注册 pet:modelSwitchRequest，
  // 而 Electron 对尚未注册监听器的页面是丢弃推送——
  // 用户在启动窗口里选了 Natori，磁盘写着 natori，桌面上还是 Haru。
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-boot-switch-'));
  const entry = join(dir, 'entry.mjs');
  await writeFile(entry, delayedLoadEntrySource(3000), 'utf8');

  const app = await electron.launch({
    args: [entry],
    cwd: ROOT,
    env: {
      ...process.env,
      DESK_PET_E2E: '1',
      DESK_PET_USER_DATA: join(dir, 'userData'),
    },
  });

  try {
    // 等主进程把 IPC 处理器装好（此时宠物窗口刚建，页面还在延迟加载中）。
    await waitFor(async () => {
      const has = await app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.has('pet:switchModel'));
      return has === true;
    });

    // 此刻渲染层**还没加载完**：这个切换请求必须被主进程排上队，
    // 而不是凭空消失。直接调用主进程的 IPC 处理器——
    // 它就是设置窗口「切换形象」走的那条路径。
    const pending = app.evaluate(({ ipcMain }) =>
      ipcMain._invokeHandlers.get('pet:switchModel')(null, 'natori')
    );

    const win = await app.firstWindow();
    await win.waitForFunction(() => window.__pet && window.__pet.ready === true, null, { timeout: 30000 });
    // 排队的请求最终必须真的执行：屏幕上变成 Natori。
    await win.waitForFunction(() => window.__pet.modelId === 'natori', null, { timeout: 30000 });

    const ack = await pending;
    expect(ack.ok).toBe(true);
    expect(ack.modelId).toBe('natori');

    // 磁盘上也必须是 natori：磁盘与屏幕一致。
    await new Promise((r) => setTimeout(r, 800));
    const saved = JSON.parse(await readFile(join(dir, 'userData', 'settings.json'), 'utf8'));
    expect(saved.modelId).toBe('natori');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** 轮询等待某个条件成立。 */
async function waitFor(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}
