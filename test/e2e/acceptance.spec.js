import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchApp, collectErrors } from './helpers.js';

/**
 * 端到端验收用例：逐条对应设计规格 §11 的验收标准。
 *
 * §11.1 启动渲染与自发动画   → 验收①
 * §11.2 视线跟随与头/身反应 → 验收②
 * §11.3 拖拽                → test/e2e/drag.spec.js（同一断言不抄第二遍）
 * §11.4 托盘菜单（显示/隐藏 · 设置 · 退出）→ 验收④⑤、验收④（退出）
 * §11.5 角色右键菜单        → 验收④⑤
 * §11.6 重启后位置记忆      → test/e2e/drag.spec.js（同一断言不抄第二遍）
 * §11.7 设置窗口            → 验收⑦
 * §11.8 无未捕获错误        → 验收⑧
 *
 * 拖拽夹具（dragBy / windowPos / moveToTopLeft）与错误收集器统一放在
 * test/e2e/helpers.js，本文件与 drag.spec.js 共用同一份实现——抄一份会漂移。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_MAIN = join(ROOT, 'src', 'main', 'index.js');

/**
 * 菜单探针的入口脚本。
 *
 * 托盘菜单与角色右键菜单都由 src/main/menu.js 的 menuTemplate() 生成，
 * 而托盘菜单只在启动时构建一次——应用起来之后就再也拿不到它的模板了。
 * 所以这里用一个**临时入口**包一层：先给 Menu.buildFromTemplate 装上探针，
 * 再 import 真正的主进程入口，于是托盘菜单的模板在它被构建的那一刻就被抓了下来。
 *
 * 探针同时把「菜单项的 click 回调」原样留着，因此测试可以**真的去点它们**：
 * 显示/隐藏、设置、退出这些动作都是主进程里的真实实现，不是替身。
 */
function menuProbeEntrySource() {
  const mainUrl = pathToFileURL(APP_MAIN).href;
  return `
import { Menu } from 'electron';

globalThis.__menuProbe = { templates: [], popupCount: 0, mainErrors: [] };

process.on('uncaughtException', (err) => {
  globalThis.__menuProbe.mainErrors.push('uncaughtException: ' + (err?.stack || err));
});
process.on('unhandledRejection', (reason) => {
  globalThis.__menuProbe.mainErrors.push('unhandledRejection: ' + (reason?.stack || reason));
});

const originalBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => {
  globalThis.__menuProbe.templates.push({
    labels: template.map((item) => item.label || item.type),
    stack: new Error().stack || '',
    template,
  });
  return originalBuild(template);
};

// 真弹窗会挡住自动化：只记次数，不真的弹。
Menu.prototype.popup = function () {
  globalThis.__menuProbe.popupCount += 1;
};

await import(${JSON.stringify(mainUrl)});
`;
}

/**
 * 用菜单探针入口启动应用。
 *
 * 与 helpers.launchApp 的唯一区别是入口脚本不同；其余（E2E 标志、userData 目录、
 * 等待渲染层 ready）保持一致。
 */
async function launchWithMenuProbe(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-acceptance-'));
  const entry = join(dir, 'entry.mjs');
  await writeFile(entry, menuProbeEntrySource(), 'utf8');

  const userDataDir = options.userDataDir || join(dir, 'userData');
  const app = await electron.launch({
    args: [entry],
    cwd: ROOT,
    env: {
      ...process.env,
      DESK_PET_E2E: '1',
      DESK_PET_USER_DATA: userDataDir,
      ...(options.env || {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__pet && window.__pet.ready === true, null, { timeout: 30000 });

  return {
    app,
    win,
    userDataDir,
    /** 读探针状态（模板摘要 + 弹窗次数 + 主进程错误）。 */
    async probe() {
      return app.evaluate(() => ({
        templates: globalThis.__menuProbe.templates.map((t) => ({ labels: t.labels, stack: t.stack })),
        popupCount: globalThis.__menuProbe.popupCount,
        mainErrors: globalThis.__menuProbe.mainErrors,
      }));
    },
    /** 点菜单里的一项（按标签）。模板里保留了真实的 click 回调。 */
    async clickMenuItem(label, index = 0) {
      // 注意：主进程求值的第一个参数是 electron 模块，第二个才是传入的参数。
      return app.evaluate(
        (_electron, { label, index }) => {
          const template = globalThis.__menuProbe.templates[index]?.template;
          const item = (template || []).find((i) => i.label === label);
          if (!item) throw new Error(`菜单里没有「${label}」`);
          item.click();
        },
        { label, index }
      );
    },
    async close() {
      try {
        await app.close();
      } catch {
        /* 应用可能已经自己退出了 */
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 形象注册表（assets/live2d/index.json）是「有哪些形象」的唯一事实来源。 */
const readRegistry = (win) => win.evaluate(() => fetch('/assets/live2d/index.json').then((r) => r.json()));

test('验收①：启动后渲染出模型，并在无人操作时持续动画', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const registry = await readRegistry(ctx.win);
    const state = await ctx.win.evaluate(() => ({
      ready: window.__pet?.ready === true,
      modelLoaded: window.__pet?.modelLoaded === true,
      modelId: window.__pet?.modelId,
      expressions: window.__pet?.expressions?.length ?? 0,
      hitAreas: window.__pet?.hitAreas ?? [],
      hasCanvas: !!window.__pet?.stage?.app?.view,
      error: window.__pet?.error ?? null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      // 呼吸是模型自带的动态效果：它存在，模型就是活的。
      // 「眼睛真的在眨」不在这里断言——那只证明 internalModel.eyeBlink **存在**，
      // 不证明眼皮在动；render.spec.js 的眼部区域逐帧哈希是更强的检查。
      hasBreath: !!window.__pet?.model?.internalModel?.breath,
    }));

    expect(state.error).toBeNull();
    expect(state.ready).toBe(true);
    expect(state.modelLoaded).toBe(true);
    // 不写死 'haru'：注册表里第一个形象将来可能换人。
    expect(state.modelId).toBe(registry.models[0].id);
    expect(state.expressions).toBeGreaterThan(0);
    expect(state.hitAreas).toContain('Head');
    expect(state.hitAreas).toContain('Body');
    expect(state.hasCanvas).toBe(true);
    // 透明背景：桌宠窗口不能是一块白板。
    expect(state.bodyBg).toContain('rgba(0, 0, 0, 0)');
    expect(state.hasBreath).toBe(true);

    // 没有人碰它，画面也必须自己在变（呼吸/眨眼/物理效果）。
    // 先置顶：窗口若被别的窗口盖住，渲染循环可能停摆，画面就不再变了。
    await ctx.win.bringToFront();
    const distinctFrames = await ctx.win.evaluate(async () => {
      const app = window.__pet.stage.app;
      const extract = app.renderer.plugins.extract;
      const sample = () => {
        const raw = extract._rawPixels(app.stage);
        let v = 0;
        for (let i = 0; i < raw.pixels.length; i += 64) {
          v = (v * 31 + raw.pixels[i] + raw.pixels[i + 1] * 3 + raw.pixels[i + 2] * 7) >>> 0;
        }
        return v;
      };
      const hashes = new Set();
      const t0 = performance.now();
      while (performance.now() - t0 < 2500) {
        hashes.add(sample());
        await new Promise((r) => setTimeout(r, 50));
      }
      return hashes.size;
    });
    expect(distinctFrames, '无人操作时画面也应持续变化').toBeGreaterThan(1);

    // 空闲时自己播一次待机动作（用测试缝缩短空闲间隔）。
    // 动作组名不写死 'Idle'：它来自当前形象的清单（语义键 idle → 动作组）。
    const idleMotions = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const calls = [];
      const orig = model.motion;
      model.motion = function (group, index, priority) {
        calls.push({ group, index });
        return orig.call(model, group, index, priority);
      };
      const { resolveMotionSpec } = await import('/src/renderer/pet/manifest.js');
      const expectedGroup = resolveMotionSpec(window.__pet.manifest, 'idle')?.group ?? null;
      window.__pet.setIdleMs(300);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !calls.some((c) => c.group === expectedGroup)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      delete model.motion;
      return { calls, expectedGroup };
    });
    expect(idleMotions.expectedGroup, '清单里应当有 idle 动作').toBeTruthy();
    expect(
      idleMotions.calls.some((c) => c.group === idleMotions.expectedGroup),
      '空闲时应自动播放待机动作'
    ).toBe(true);

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('验收②：视线跟随鼠标，摸头与点击身体触发不同反应', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const b = model.getBounds();

      // 视线跟随：记录 focus 的真实调用。
      const focusCalls = [];
      const origFocus = model.focus;
      model.focus = function (x, y, instant) {
        focusCalls.push({ x, y });
        return origFocus.call(model, x, y, instant);
      };

      const clickAt = async (x, y) => {
        const opts = { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true };
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointermove', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', opts));
        await new Promise((r) => setTimeout(r, 80));
        return {
          zone: window.__pet.lastZone,
          expression: window.__pet.lastExpression,
          motion: window.__pet.lastMotion,
        };
      };

      // 先把鼠标挪到角色附近：视线必须跟过去。
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 250, clientY: 40, pointerId: 1, bubbles: true })
      );
      await new Promise((r) => setTimeout(r, 80));

      const head = await clickAt(b.x + b.width / 2, b.y + b.height * 0.15);
      const body = await clickAt(b.x + b.width / 2, b.y + b.height * 0.75);

      delete model.focus;

      // 期望值来自**当前形象**的清单，而不是写死某个表情名。
      const { resolveExpressionName, resolveMotionSpec } = await import('/src/renderer/pet/manifest.js');
      const m = window.__pet.manifest;
      return {
        head,
        body,
        focusCalls,
        focusPoint: window.__pet.focusPoint,
        expectedHeadExpression: resolveExpressionName(m, 'happy'),
        expectedBodyExpression: resolveExpressionName(m, 'smile'),
        expectedHeadMotion: resolveMotionSpec(m, 'tapHead'),
        expectedBodyMotion: resolveMotionSpec(m, 'tapBody'),
        // 两个语义键映射到同一个表情名时，两者本来就该相同。
        sameExpressionByManifest:
          resolveExpressionName(m, 'happy') === resolveExpressionName(m, 'smile'),
      };
    });

    // 视线跟随
    expect(result.focusCalls.length).toBeGreaterThan(0);
    expect(result.focusCalls[0].x).toBe(250);
    expect(result.focusCalls[0].y).toBe(40);
    expect(result.focusPoint).not.toBeNull();

    // 命中区不同
    expect(result.head.zone).toBe('head');
    expect(result.body.zone).toBe('body');

    // 表情符合清单的语义映射
    expect(result.head.expression).toBe(result.expectedHeadExpression);
    expect(result.body.expression).toBe(result.expectedBodyExpression);
    expect(result.head.expression).toBeTruthy();
    // 「不同反应」：表情要么不同（清单映射到不同表情），要么至少动作不同。
    expect(result.head.expression === result.body.expression).toBe(result.sameExpressionByManifest);
    expect(result.head.motion).toEqual(result.expectedHeadMotion);
    expect(result.body.motion).toEqual(result.expectedBodyMotion);
    expect(result.head.motion).not.toEqual(result.body.motion);

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('验收④⑤：托盘菜单提供 显示/隐藏 · 设置 · 退出，角色右键弹出菜单', async () => {
  const ctx = await launchWithMenuProbe();
  const errors = collectErrors(ctx.win);
  try {
    const probe = await ctx.probe();
    expect(probe.mainErrors).toEqual([]);

    // 启动时构建的第一个菜单就是托盘菜单：靠调用栈确认，
    // 否则「抓到的第一个模板是托盘菜单」只是「大概」。
    expect(probe.templates.length).toBeGreaterThanOrEqual(1);
    const trayMenu = probe.templates[0];
    expect(trayMenu.stack, '第一个菜单应当由 buildTrayMenu 构建').toContain('buildTrayMenu');
    expect(trayMenu.labels).toEqual(['显示 / 隐藏', 'separator', '设置…', 'separator', '退出']);

    // 右键菜单：主进程用同一份模板构建，并真的去弹它。
    await ctx.win.evaluate(async () => {
      const canvas = window.__pet.stage.app.view;
      const b = window.__pet.model.getBounds();
      const x = b.x + b.width / 2;
      const y = b.y + b.height * 0.15;
      const right = {
        clientX: x,
        clientY: y,
        pointerId: 1,
        button: 2,
        buttons: 2,
        bubbles: true,
        cancelable: true,
      };
      canvas.dispatchEvent(new PointerEvent('pointerdown', right));
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...right, clientX: x + 120, clientY: y + 60 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...right, clientX: x + 120, clientY: y + 60 }));
      canvas.dispatchEvent(
        new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true })
      );
      await new Promise((r) => setTimeout(r, 200));
    });
    // 主进程那边是异步的（IPC 往返），轮询等菜单真的弹出来。
    const deadline = Date.now() + 5000;
    let afterRightClick = null;
    for (;;) {
      afterRightClick = await ctx.probe();
      if (afterRightClick.popupCount >= 1) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(afterRightClick.popupCount, '右键后菜单应被弹出').toBeGreaterThanOrEqual(1);
    const contextMenu = afterRightClick.templates[afterRightClick.templates.length - 1];
    expect(contextMenu.stack, '右键菜单应当由 buildContextMenu 构建').toContain('buildContextMenu');
    expect(contextMenu.labels).toEqual(['显示 / 隐藏', 'separator', '设置…', 'separator', '退出']);

    // 「显示 / 隐藏」：真的把桌宠窗口藏起来，再放出来。
    const visibleBefore = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible()
    );
    expect(visibleBefore).toBe(true);
    await ctx.clickMenuItem('显示 / 隐藏');
    await new Promise((r) => setTimeout(r, 500));
    const visibleAfterHide = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible()
    );
    expect(visibleAfterHide, '「显示 / 隐藏」应把角色藏起来').toBe(false);

    await ctx.clickMenuItem('显示 / 隐藏');
    await new Promise((r) => setTimeout(r, 500));
    const visibleAfterShow = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible()
    );
    expect(visibleAfterShow, '再点一次应把角色放回来').toBe(true);

    // 「设置…」：打开设置窗口。
    const settingsWinPromise = ctx.app.waitForEvent('window');
    await ctx.clickMenuItem('设置…');
    const settingsWin = await settingsWinPromise;
    await settingsWin.waitForLoadState('domcontentloaded');
    const settingsUrl = settingsWin.url();
    expect(settingsUrl).toContain('/src/settings/index.html');

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('验收④：托盘菜单的「退出」会真正退出应用', async () => {
  const ctx = await launchWithMenuProbe();
  const errors = collectErrors(ctx.win);
  try {
    // 错误状态必须在**退出之前**取：应用一旦退出，app.evaluate 就执行不了，
    // 那个 .catch(() => []) 会把断言变成恒真（应用退出后读到的永远是空数组）。
    // 这里取的是「退出那一刻之前」的快照。
    const before = await ctx.probe();
    expect(before.mainErrors, '退出前主进程不应有未捕获错误').toEqual([]);
    expect(errors, '退出前渲染层不应有未捕获错误').toEqual([]);

    const closed = ctx.app.waitForEvent('close', { timeout: 15000 });
    await ctx.clickMenuItem('退出');
    // 应用真的退出了：主进程发出 close 事件。
    // 15 秒内没有 close 事件就说明「退出」没生效，这条用例失败。
    await closed;
  } finally {
    await ctx.close();
  }
});

test('验收⑦：设置窗口可切换形象、调整缩放与透明度，切换后功能仍完整', async () => {
  const ctx = await launchWithMenuProbe();
  const errors = collectErrors(ctx.win);
  try {
    const registry = await readRegistry(ctx.win);
    // 切换目标不写死 'natori'：从注册表里挑一个「不是当前形象」的形象。
    const target = registry.models.find((m) => m.id !== registry.models[0].id);
    expect(target, '注册表里应当至少有两个形象').toBeTruthy();

    // 从托盘菜单的「设置…」打开设置窗口。
    const settingsWinPromise = ctx.app.waitForEvent('window');
    await ctx.clickMenuItem('设置…');
    const settingsWin = await settingsWinPromise;
    await settingsWin.waitForLoadState('domcontentloaded');
    await settingsWin.waitForFunction(() => document.querySelectorAll('#model option').length > 0);

    // 下拉框列出的就是注册表里的那些形象（顺序与名称都不写死）。
    const labels = await settingsWin.locator('#model option').allTextContents();
    expect(labels).toEqual(registry.models.map((m) => m.name));

    // 切换形象：默认形象 → 另一个注册过的形象。
    await settingsWin.locator('#model').selectOption(target.id);
    await ctx.win.waitForFunction((id) => window.__pet.modelId === id, target.id, { timeout: 12000 });

    // 切换之后功能仍完整：模型重新挂载，表情与命中区都换了。
    const afterSwitch = await ctx.win.evaluate(() => ({
      modelId: window.__pet.modelId,
      switchError: window.__pet.switchError || null,
      expressions: window.__pet.expressions.slice(),
      hitAreas: window.__pet.hitAreas.slice(),
      stageChildren: window.__pet.stage.app.stage.children.length,
      hasCanvas: !!window.__pet.stage?.app?.view,
    }));
    expect(afterSwitch.switchError).toBeNull();
    expect(afterSwitch.modelId).toBe(target.id);
    expect(afterSwitch.expressions.length).toBeGreaterThan(0);
    expect(afterSwitch.hitAreas).toContain('Head');
    expect(afterSwitch.hitAreas).toContain('Body');
    expect(afterSwitch.stageChildren).toBe(1);
    expect(afterSwitch.hasCanvas).toBe(true);

    // 缩放：设置页的滑块 → 宠物窗口立刻重新适配。
    const scaleBefore = await ctx.win.evaluate(() => window.__pet.model.scale.x);
    await settingsWin.evaluate(() => {
      const input = document.getElementById('scale');
      input.value = '1.5';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ctx.win.waitForFunction(() => window.__pet.scale === 1.5, null, { timeout: 8000 });
    const scaleAfter = await ctx.win.evaluate(() => window.__pet.model.scale.x);
    expect(scaleAfter).toBeGreaterThan(scaleBefore);

    // 透明度：设置页的滑块 → 主进程把透明度施加在**宠物窗口**上。
    await settingsWin.evaluate(() => {
      const input = document.getElementById('opacity');
      input.value = '0.6';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await ctx.win.waitForFunction(() => window.__pet.opacity === 0.6, null, { timeout: 8000 });
    const windows = await ctx.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        url: w.webContents.getURL(),
        opacity: w.getOpacity(),
      }))
    );
    const pet = windows.find((w) => w.url.includes('/src/renderer/index.html'));
    expect(pet).toBeTruthy();
    expect(Math.abs(pet.opacity - 0.6)).toBeLessThan(0.01);

    // 设置已落盘。
    const deadline = Date.now() + 6000;
    let saved = null;
    while (Date.now() < deadline) {
      try {
        saved = JSON.parse(await readFile(join(ctx.userDataDir, 'settings.json'), 'utf8'));
        if (saved?.modelId === target.id && saved?.scale === 1.5 && saved?.opacity === 0.6) break;
      } catch {
        /* 文件还没写出来 */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(saved?.modelId).toBe(target.id);
    expect(saved?.scale).toBe(1.5);
    expect(saved?.opacity).toBe(0.6);

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('验收⑧：主进程与渲染进程均无未捕获错误', async () => {
  const ctx = await launchWithMenuProbe();
  const errors = collectErrors(ctx.win);
  try {
    await new Promise((r) => setTimeout(r, 1500));
    expect(errors).toEqual([]);
    const probe = await ctx.probe();
    expect(probe.mainErrors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
