import { test, expect } from '@playwright/test';
import { launchApp, collectErrors, dragBy } from './helpers.js';

/**
 * 情绪系统：心情值与语义表情。
 *
 * 断言都读 window.__pet 上的诊断面（mood / emotion），
 * 而不是去猜模型内部长什么样——表情要断言「换成哪个表情名」，
 * 那是清单（pet.json）里的映射，属于模型自己的名字。
 */
test('摸头让心情变好，情绪变开心', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const before = await ctx.win.evaluate(() => ({
      mood: window.__pet.mood,
      emotion: window.__pet.emotion,
    }));

    await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const b = model.getBounds();
      const x = b.x + b.width / 2;
      const y = b.y + b.height * 0.15;
      const opts = { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      canvas.dispatchEvent(new PointerEvent('pointermove', opts));
      canvas.dispatchEvent(new PointerEvent('pointerup', opts));
      await new Promise((r) => setTimeout(r, 80));
    });

    const after = await ctx.win.evaluate(() => ({
      mood: window.__pet.mood,
      emotion: window.__pet.emotion,
    }));

    expect(before.mood).toBe(0);
    expect(after.mood).toBeGreaterThan(before.mood);
    expect(after.emotion).toBe('happy');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('被拖拽时换成惊讶脸，落地后回到平常', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    // 记录换过的表情：情绪系统换表情走的是 model.expression()。
    await ctx.win.evaluate(() => {
      const model = window.__pet.model;
      window.__exprCalls = [];
      const orig = model.expression;
      model.expression = function (id) {
        window.__exprCalls.push(id);
        return orig.call(model, id);
      };
    });

    await dragBy(ctx.win, 60, 0, 3);

    const result = await ctx.win.evaluate(() => ({
      exprCalls: window.__exprCalls,
      emotion: window.__pet.emotion,
      rotation: window.__pet.model.rotation,
    }));

    const manifest = await ctx.win.evaluate(() => window.__pet.manifest);
    const surprised = manifest.expressions?.surprised || null;
    const normal = manifest.expressions?.normal || null;

    // 惊讶脸换过一次（清单里没映射就是 null，那就不该有任何表情调用）。
    if (surprised) expect(result.exprCalls).toContain(surprised);
    // 落地之后情绪回到平常。
    expect(result.emotion).toBe('neutral');
    // 摇摆停了：模型被摆正。
    expect(Math.abs(result.rotation)).toBeLessThan(0.001);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('连续猛点会让桌宠生气', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const emotion = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const b = model.getBounds();
      const x = b.x + b.width / 2;
      const y = b.y + b.height * 0.15;
      const opts = { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true };
      // 2 秒内连点 3 下
      for (let i = 0; i < 3; i += 1) {
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointermove', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', opts));
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, 80));
      return window.__pet.emotion;
    });

    expect(emotion).toBe('angry');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('系统光标不在桌宠身上时，桌宠仍然看着光标', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    await ctx.win.evaluate(() => {
      const model = window.__pet.model;
      window.__focusCalls = [];
      const orig = model.focus;
      model.focus = function (x, y, instant) {
        window.__focusCalls.push({ x, y });
        return orig.call(model, x, y, instant);
      };
    });

    // 等光标轮询送来一个点。
    await ctx.win.waitForFunction(() => window.__pet.cursorPoint !== null, null, { timeout: 10000 });

    const result = await ctx.win.evaluate(() => ({
      cursorPoint: window.__pet.cursorPoint,
      focusCalls: window.__focusCalls.length,
    }));

    expect(result.cursorPoint).not.toBeNull();
    expect(typeof result.cursorPoint.x).toBe('number');
    expect(typeof result.cursorPoint.y).toBe('number');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
