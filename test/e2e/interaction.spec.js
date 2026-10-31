import { test, expect } from '@playwright/test';
import { launchApp, collectErrors } from './helpers.js';

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
      // 直接用页面里那份 normalizeZone，别在测试里另写一份匹配规则——
      // 否则模型把身体命中区叫 Torso 之类时，测试会误判成「找不到区分点」。
      let normalizeZone;
      try {
        ({ normalizeZone } = await import('/src/renderer/pet/hitZone.js'));
      } catch {
        normalizeZone = (n) => {
          const s = String(n ?? '').toLowerCase();
          if (s.includes('head')) return 'head';
          if (s.includes('body') || s.includes('torso')) return 'body';
          return 'other';
        };
      }

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
        const names = Array.isArray(raw) ? raw : [raw];
        const zone = names.map(normalizeZone).find((z) => z !== 'other');
        if (zone === 'body') {
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
  try {
    // 主进程里把原生菜单弹窗换成计数桩：真弹窗会挡住自动化。
    // 必须在 try 里：这一步抛错时 finally 仍要负责关掉 Electron 进程。
    await ctx.app.evaluate(({ Menu }) => {
      globalThis.__contextMenuCount = 0;
      Menu.prototype.popup = function () {
        globalThis.__contextMenuCount += 1;
      };
    });

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

test('真实指针事件下画布会捕获指针，拖拽移出窗口也不丢事件', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    await ctx.win.bringToFront();

    // 真实（受信任的）指针事件：Playwright 的 mouse 会产生真实的 pointerId，
    // setPointerCapture 在这条路径上才会真的生效——
    // 合成事件（dispatchEvent）带的是不存在的 pointer id，
    // 规范要求此时必须抛 NotFoundError（含义是「未知的 pointer id」）。
    await ctx.win.mouse.move(150, 150);
    await ctx.win.mouse.down();

    const captured = await ctx.win.evaluate(() => {
      const canvas = window.__pet.stage.app.view;
      if (typeof canvas.hasPointerCapture !== 'function') return null;
      const ids = [];
      for (let id = 1; id <= 5; id += 1) {
        if (canvas.hasPointerCapture(id)) ids.push(id);
      }
      return ids;
    });

    // 按住之后移动：位移远超阈值 → 进入拖拽态 → 松手不产生点击反应。
    await ctx.win.mouse.move(220, 200);
    const zoneAfterDrag = await ctx.win.evaluate(() => window.__pet.lastZone);
    await ctx.win.mouse.up();

    expect(captured, 'hasPointerCapture 不可用时无法断言捕获').not.toBeNull();
    expect(captured.length, '按下鼠标时画布应捕获该指针').toBeGreaterThan(0);
    // 拖拽（不是点击）不应产生点击反应。
    expect(zoneAfterDrag).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('空闲计时会反复播放随机 idle 动作并回到 normal 表情', async () => {
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

    // 把空闲间隔调短：既省掉 20 秒等待，也能验证「重新武装」——
    // 只播一次就再也不响的实现会在这里露馅。
    const applied = await ctx.win.evaluate(() => window.__pet.setIdleMs(300));
    expect(applied).toBe(300);

    await ctx.win.waitForFunction(
      () => window.__idleCalls.motions.filter((m) => m.group === 'Idle').length >= 1,
      null,
      { timeout: 10000 }
    );
    // 第二次：证明空闲计时器会重新武装（独处一会的桌宠不该只动一次）。
    await ctx.win.waitForFunction(
      () => window.__idleCalls.motions.filter((m) => m.group === 'Idle').length >= 2,
      null,
      { timeout: 10000 }
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

    const idleCalls = result.motions.filter((m) => m.group === 'Idle');
    expect(idleCalls.length).toBeGreaterThanOrEqual(2);
    // 不给索引 = 库随机挑该组里的动作；给了固定索引就不是「随机待机动作」。
    expect(idleCalls.every((m) => m.index === undefined)).toBe(true);
    expect(result.idleMs).toBe(300);
    // 同时回到 normal 表情。
    expect(result.expressions).toContain(result.normal);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
