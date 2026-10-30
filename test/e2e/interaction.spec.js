import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

test('点击头部与身体触发不同反应', async () => {
  const ctx = await launchApp();
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
      return { head, body, rect: { w: rect.width, h: rect.height } };
    });

    expect(result.head.zone).toBe('head');
    expect(result.body.zone).toBe('body');
    expect(result.head.expr).not.toBe(result.body.expr);
    expect(result.head.expr).toBeTruthy();
  } finally {
    await ctx.close();
  }
});

test('指针移动触发视线跟随', async () => {
  const ctx = await launchApp();
  try {
    const focus = await ctx.win.evaluate(async () => {
      const canvas = window.__pet.stage.app.view;
      canvas.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 250, clientY: 40, pointerId: 1, bubbles: true })
      );
      await new Promise((r) => setTimeout(r, 60));
      return window.__pet.focusPoint;
    });
    expect(focus).not.toBeNull();
    expect(focus.x).toBeGreaterThan(200);
    expect(focus.y).toBeLessThan(100);
  } finally {
    await ctx.close();
  }
});

test('拖拽不触发点击反应，点击才触发', async () => {
  const ctx = await launchApp();
  try {
    const result = await ctx.win.evaluate(async () => {
      const model = window.__pet.model;
      const canvas = window.__pet.stage.app.view;
      const b = model.getBounds();
      const x = b.x + b.width / 2;
      const y = b.y + b.height * 0.15;

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

      // 再点一次：位移在阈值内，应当产生点击反应。
      send('pointerdown', x, y);
      send('pointermove', x + 2, y);
      send('pointerup', x + 2, y);
      await new Promise((r) => setTimeout(r, 60));
      const afterClick = window.__pet.lastZone;

      return { afterDrag, afterClick };
    });

    // 拖拽松手不产生反应：lastZone 保持初始的 null。
    expect(result.afterDrag).toBeNull();
    // 点击产生反应：命中头部。
    expect(result.afterClick).toBe('head');
  } finally {
    await ctx.close();
  }
});
