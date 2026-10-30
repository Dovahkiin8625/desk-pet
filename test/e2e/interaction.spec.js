import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

/**
 * 收集渲染层的未捕获异常与 console.error。
 * 与 switch.spec.js 用的是同一套模式：这是新代码在浏览器里唯一跑的地方，
 * 「渲染进程不得产生未捕获错误」这条必须在这里被断言。
 */
function collectErrors(win) {
  const errors = [];
  win.on('pageerror', (err) => errors.push(`pageerror: ${err?.message || err}`));
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

test('点击头部与身体触发不同反应', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const rect = canvas.getBoundingClientRect();
      const b = model.getBounds();

      const clickAt = async (x, y) => {
        const opts = { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true };
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointermove', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', opts));
        await new Promise((r) => setTimeout(r, 60));
        return { zone: window.__pet.lastZone, expr: window.__pet.lastExpression };
      };

      const head = await clickAt(b.x + b.width / 2, b.y + b.height * 0.15);
      const body = await clickAt(b.x + b.width / 2, b.y + b.height * 0.75);

      // 期望值来自**当前模型**的清单，而不是写死某个表情名：
      // natori 的 happy 与 smile 都映射到 "Smile"，写死「两者必须不同」是错的。
      const m = window.__pet.manifest;
      const fallback = m.availableExpressions?.[0] || null;
      return {
        head,
        body,
        expectedHead: m.expressions?.happy || fallback,
        expectedBody: m.expressions?.smile || fallback,
        rect: { w: rect.width, h: rect.height },
      };
    });

    expect(result.head.zone).toBe('head');
    expect(result.body.zone).toBe('body');
    expect(result.head.expr).toBe(result.expectedHead);
    expect(result.body.expr).toBe(result.expectedBody);
    expect(result.head.expr).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('命中区由模型自身的命中区决定，而不是包围盒的上三分之一', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const b = model.getBounds();
      const cx = b.x + b.width / 2;

      // 找一个「几何兜底会判成 head（rel <= 0.35）、但模型自己的命中区判成 body」的点。
      // 只有用了模型原生命中区，点击结果才是 body；纯几何兜底会给 head。
      let target = null;
      for (let f = 0.05; f <= 0.35; f += 0.01) {
        const y = b.y + b.height * f;
        const raw = model.hitTest(cx, y);
        const names = (Array.isArray(raw) ? raw : [raw]).map((n) => String(n).toLowerCase());
        if (names.some((n) => n.includes('body'))) {
          target = { f, x: cx, y };
          break;
        }
      }
      if (!target) return { target: null, zone: null };

      const opts = { clientX: target.x, clientY: target.y, pointerId: 1, button: 0, bubbles: true };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts));
      await new Promise((r) => setTimeout(r, 60));
      return { target, zone: window.__pet.lastZone };
    });

    // 找不到这样的点说明模型没有可区分的头身命中区，测试应当明确失败而不是跳过。
    expect(result.target, '模型应存在「几何判头、原生判身」的点').not.toBeNull();
    expect(result.zone).toBe('body');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('指针移动触发视线跟随', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const focus = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      // 记录 focus 的真实调用：只断言 focusPoint 的话，
      // 把 currentModel.focus(x, y) 整段删掉测试照样是绿的。
      const calls = [];
      const orig = model.focus;
      model.focus = function (x, y, instant) {
        calls.push({ x, y });
        return orig.call(model, x, y, instant);
      };

      const canvas = window.__pet.stage.app.view;
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 250, clientY: 40, pointerId: 1, bubbles: true })
      );
      await new Promise((r) => setTimeout(r, 60));
      delete model.focus;
      return { calls, point: window.__pet.focusPoint };
    });

    expect(focus.point).not.toBeNull();
    expect(focus.point.x).toBeGreaterThan(200);
    expect(focus.point.y).toBeLessThan(100);
    expect(focus.calls.length).toBeGreaterThan(0);
    expect(focus.calls[0].x).toBe(250);
    expect(focus.calls[0].y).toBe(40);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('右键不会开始拖拽，右键菜单仍然送达', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  // 主进程里把原生菜单弹窗换成计数桩：真弹窗会挡住自动化。
  await ctx.app.evaluate(({ Menu }) => {
    globalThis.__contextMenuCount = 0;
    Menu.prototype.popup = function () {
      globalThis.__contextMenuCount += 1;
    };
  });
  try {
    const result = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const b = model.getBounds();
      const x = b.x + b.width / 2;
      const y = b.y + b.height * 0.15;

      // 记录动作调用：右键若被当成拖拽或点击，drag/tap 动作会被播放。
      const motions = [];
      const origMotion = model.motion;
      model.motion = function (group, index, priority) {
        motions.push({ group, index });
        return origMotion.call(model, group, index, priority);
      };

      let contextmenuSeen = false;
      const onMenu = () => { contextmenuSeen = true; };
      canvas.addEventListener('contextmenu', onMenu);

      const right = { clientX: x, clientY: y, pointerId: 1, button: 2, buttons: 2, bubbles: true, cancelable: true };
      canvas.dispatchEvent(new PointerEvent('pointerdown', right));
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...right, clientX: x + 120, clientY: y + 60 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...right, clientX: x + 120, clientY: y + 60 }));
      canvas.dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 120));

      canvas.removeEventListener('contextmenu', onMenu);
      delete model.motion;
      return { contextmenuSeen, motions, lastZone: window.__pet.lastZone };
    });

    expect(result.contextmenuSeen).toBe(true);
    // 既没有开始拖拽（drag 动作），也没有产生点击反应（tap 动作）。
    expect(result.motions).toEqual([]);
    expect(result.lastZone).toBeNull();
    const popupCount = await ctx.app.evaluate(() => globalThis.__contextMenuCount);
    expect(popupCount).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('拖拽不触发点击反应，点击才触发', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const b = model.getBounds();
      const x = b.x + b.width / 2;
      const y = b.y + b.height * 0.15;

      const motions = [];
      const origMotion = model.motion;
      model.motion = function (group, index, priority) {
        motions.push({ group, index });
        return origMotion.call(model, group, index, priority);
      };

      const send = (type, cx, cy) => {
        canvas.dispatchEvent(
          new PointerEvent(type, { clientX: cx, clientY: cy, pointerId: 1, button: 0, bubbles: true })
        );
      };

      // 先拖一次：位移远超阈值，松手时不应产生点击反应。
      send('pointerdown', x, y);
      send('pointermove', x + 40, y);
      send('pointerup', x + 40, y);
      await new Promise((r) => setTimeout(r, 60));
      const afterDrag = window.__pet.lastZone;
      const dragMotions = motions.slice();

      // 再点一次：位移在阈值内，应当产生点击反应。
      send('pointerdown', x, y);
      send('pointermove', x + 2, y);
      send('pointerup', x + 2, y);
      await new Promise((r) => setTimeout(r, 60));
      const afterClick = window.__pet.lastZone;

      delete model.motion;
      const m = window.__pet.manifest;
      return {
        afterDrag,
        afterClick,
        dragMotions,
        dragGroup: m.motions?.drag?.group || null,
      };
    });

    // 拖拽松手不产生反应：lastZone 保持初始的 null。
    expect(result.afterDrag).toBeNull();
    // 拖拽本身播放的是语义键 drag 对应的动作（不是 tapHead/tapBody）。
    expect(result.dragMotions.some((m) => m.group === result.dragGroup)).toBe(true);
    // 点击产生反应：命中头部。
    expect(result.afterClick).toBe('head');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('空闲计时会播放随机 idle 动作并回到 normal 表情', async () => {
  test.setTimeout(60000);
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    await ctx.win.evaluate(() => {
      const model = window.__pet.model;
      window.__idleCalls = { motions: [], expressions: [] };
      const origMotion = model.motion;
      model.motion = function (group, index, priority) {
        window.__idleCalls.motions.push({ group, index });
        return origMotion.call(model, group, index, priority);
      };
      const origExpr = model.expression;
      model.expression = function (id) {
        window.__idleCalls.expressions.push(id);
        return origExpr.call(model, id);
      };
    });

    // 空闲计时器是 20 秒，等它自己响。
    await ctx.win.waitForFunction(
      () => window.__idleCalls.motions.some((m) => m.group === 'Idle'),
      null,
      { timeout: 30000 }
    );

    const result = await ctx.win.evaluate(() => {
      const m = window.__pet.manifest;
      return {
        motions: window.__idleCalls.motions,
        expressions: window.__idleCalls.expressions,
        idleMs: window.__pet.idleMs,
        normal: m.expressions?.normal || m.availableExpressions?.[0] || null,
      };
    });

    const idleCall = result.motions.find((m) => m.group === 'Idle');
    expect(idleCall).toBeTruthy();
    // 不给索引 = 库随机挑该组里的动作；给了固定索引就不是「随机待机动作」。
    expect(idleCall.index).toBeUndefined();
    expect(result.idleMs).toBe(20000);
    // 同时回到 normal 表情。
    expect(result.expressions).toContain(result.normal);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
