import { test, expect } from '@playwright/test';
import { launchApp } from './helpers.js';

/**
 * 收集渲染层的未捕获异常与 console.error。
 * 切换形象要走「加载新模型 → 销毁旧模型 → 释放纹理」一整条链路，
 * 任何一步抛错都会让桌宠变成空白或直接崩溃，必须看得见。
 */
function collectErrors(win) {
  const errors = [];
  win.on('pageerror', (err) => errors.push(`pageerror: ${err?.message || err}`));
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

test('切换形象后模型、表情与命中区均更换', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const before = await ctx.win.evaluate(() => ({
      modelId: window.__pet.modelId,
      expressions: window.__pet.expressions.slice(),
      hitAreas: window.__pet.hitAreas.slice(),
    }));
    expect(before.modelId).toBe('haru');

    const after = await ctx.win.evaluate(async () => {
      const ok = await window.__pet.switchModel('natori');
      return {
        ok,
        switchError: window.__pet.switchError || null,
        modelId: window.__pet.modelId,
        expressions: window.__pet.expressions.slice(),
        hitAreas: window.__pet.hitAreas.slice(),
      };
    });

    expect(after.switchError).toBeNull();
    expect(after.ok).toBe(true);
    expect(after.modelId).toBe('natori');
    expect(after.expressions).not.toEqual(before.expressions);
    expect(after.expressions).toContain('Normal');
    expect(after.hitAreas).toContain('Head');
    expect(after.hitAreas).toContain('Body');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('连续切换多次不报错', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      const ids = ['natori', 'haru', 'natori', 'haru', 'natori'];
      for (const id of ids) {
        const ok = await window.__pet.switchModel(id);
        if (!ok) return { failedAt: id, error: window.__pet.switchError };
      }
      return { failedAt: null, error: window.__pet.switchError || null, finalId: window.__pet.modelId };
    });
    expect(result.failedAt).toBeNull();
    expect(result.error).toBeNull();
    expect(result.finalId).toBe('natori');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('切换时释放旧模型纹理，且不误伤其它纹理', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const before = await ctx.win.evaluate(() => {
      const PIXI = window.PIXI;
      const cache = PIXI.utils.TextureCache;
      // 放一个**与模型无关**的纹理进全局纹理缓存。
      // 释放逻辑是全局命名空间里的精准删除，如果它被误删，
      // 说明释放范围过宽——别的资源（托盘图标等）会跟着消失。
      PIXI.Texture.from('/assets/icons/tray.png');
      const modelKeys = (window.__pet.model.textures || []).map((t) => t.baseTexture.cacheId);
      return {
        modelId: window.__pet.modelId,
        modelKeys,
        oldKeysInCache: modelKeys.filter((k) => !!cache[k]),
        unrelatedKey: '/assets/icons/tray.png',
        unrelatedInCache: !!cache['/assets/icons/tray.png'],
      };
    });

    // 前置条件：旧模型的纹理此刻确实在缓存里，且与模型无关的纹理也在。
    expect(before.modelKeys.length).toBeGreaterThan(0);
    expect(before.oldKeysInCache).toEqual(before.modelKeys);
    expect(before.unrelatedInCache).toBe(true);

    const after = await ctx.win.evaluate(async (oldKeys) => {
      const ok = await window.__pet.switchModel('natori');
      const cache = window.PIXI.utils.TextureCache;
      const newKeys = (window.__pet.model.textures || []).map((t) => t.baseTexture.cacheId);
      return {
        ok,
        switchError: window.__pet.switchError || null,
        released: window.__pet.lastReleasedTextures,
        modelId: window.__pet.modelId,
        // 旧模型的纹理键必须已经从缓存里消失（显存被回收了）
        oldKeysLeftInCache: oldKeys.filter((k) => !!cache[k]),
        // 新模型的纹理键必须还在（渲染没被误伤）
        newKeysMissingFromCache: newKeys.filter((k) => !cache[k]),
        unrelatedInCache: !!cache['/assets/icons/tray.png'],
      };
    }, before.modelKeys);

    expect(after.ok).toBe(true);
    expect(after.switchError).toBeNull();
    expect(after.modelId).toBe('natori');
    // 释放数量为 0 就是泄漏信号：纹理还留在显存里。
    expect(after.released).toBeGreaterThan(0);
    expect(after.oldKeysLeftInCache).toEqual([]);
    expect(after.newKeysMissingFromCache).toEqual([]);
    expect(after.unrelatedInCache).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('切换到未注册的 modelId 时回退到注册表里的形象', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      const registry = await fetch('/assets/live2d/index.json').then((r) => r.json());
      const ok = await window.__pet.switchModel('__no_such_model__');
      return {
        ok,
        switchError: window.__pet.switchError || null,
        modelId: window.__pet.modelId,
        manifestId: window.__pet.manifest?.id || null,
        firstRegisteredId: registry.models[0].id,
      };
    });
    // 未知 id 不能抛错——必须落到一个注册过的形象上。
    expect(result.switchError).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.modelId).toBe(result.firstRegisteredId);
    expect(result.manifestId).toBe(result.firstRegisteredId);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('主进程通过 pet:modelSwitchRequest 驱动切换', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    // 走既有 IPC：渲染层 → 主进程 → pet:modelSwitchRequest → 渲染层。
    // 不新增通道，也不新增 contextBridge API。
    await ctx.win.evaluate(() => window.pet.switchModel('natori'));
    await ctx.win.waitForFunction(() => window.__pet.modelId === 'natori', null, { timeout: 20000 });
    const info = await ctx.win.evaluate(() => ({
      modelId: window.__pet.modelId,
      switchError: window.__pet.switchError || null,
      expressions: window.__pet.expressions.slice(),
      hitAreas: window.__pet.hitAreas.slice(),
    }));
    expect(info.modelId).toBe('natori');
    expect(info.switchError).toBeNull();
    expect(info.expressions).toContain('Normal');
    expect(info.hitAreas).toContain('Head');
    expect(info.hitAreas).toContain('Body');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
