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
      const oldModel = window.__pet.model;
      const oldHitAreaDef = oldModel.internalModel?.hitAreas?.Head;
      const ok = await window.__pet.switchModel('natori');
      const newModel = window.__pet.model;
      return {
        ok,
        switchError: window.__pet.switchError || null,
        modelId: window.__pet.modelId,
        expressions: window.__pet.expressions.slice(),
        hitAreas: window.__pet.hitAreas.slice(),
        // 命中区确实来自**新模型**：定义对象是新模型自己的实例，
        // 而不是上一个模型留下的旧对象。
        // 只断言「包含 Head/Body」是不够的——Haru 与 Natori 的命中区
        // 名字完全一样，成员断言无法证明命中区被重读过。
        hitAreaDefReplaced: oldHitAreaDef !== newModel.internalModel?.hitAreas?.Head,
        hitAreasMatchMountedModel:
          JSON.stringify(window.__pet.hitAreas) ===
          JSON.stringify(Object.keys(newModel.internalModel?.hitAreas || {})),
        // 旧模型必须已经离开舞台
        oldModelDetached: oldModel.parent === null,
        stageChildren: window.__pet.stage.app.stage.children.length,
      };
    });

    expect(after.switchError).toBeNull();
    expect(after.ok).toBe(true);
    expect(after.modelId).toBe('natori');
    expect(after.expressions).not.toEqual(before.expressions);
    expect(after.expressions).toContain('Normal');
    expect(after.hitAreas).toContain('Head');
    expect(after.hitAreas).toContain('Body');
    expect(after.hitAreaDefReplaced).toBe(true);
    expect(after.hitAreasMatchMountedModel).toBe(true);
    expect(after.oldModelDetached).toBe(true);
    // 舞台上必须只有一个模型：旧模型没被摘干净就会出现两个
    expect(after.stageChildren).toBe(1);
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
        texturesValid: (window.__pet.model.textures || []).map((t) => t.valid),
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
    // 新模型的纹理必须仍然有效（旧的释放没有误伤新的）
    expect(after.texturesValid.every(Boolean)).toBe(true);
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

test('切换到当前已挂载的同一形象是空操作，不会毁掉自己的纹理', async () => {
  // pixi 对已缓存的 URL 返回**同一个 Texture 实例**，所以重新加载同一形象时
  // 新旧模型共享同一批纹理对象。如果切换时照旧销毁旧模型，
  // 被销毁的其实是新模型自己的纹理——桌宠变成没有绑定纹理的空壳，
  // 而 switchModel 仍然报告成功。
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const probe = () =>
      ctx.win.evaluate(() => {
        const app = window.__pet.stage.app;
        const model = window.__pet.model;
        // 画面是否还有内容：统计不透明像素。
        // 呼吸动画会让这个数小幅浮动，所以只做粗略比较。
        const raw = app.renderer.plugins.extract._rawPixels(app.stage);
        let opaque = 0;
        for (let i = 3; i < raw.pixels.length; i += 4) {
          if (raw.pixels[i] > 8) opaque++;
        }
        return {
          modelId: window.__pet.modelId,
          opaque,
          texturesValid: (model.textures || []).map((t) => t.valid),
          stageChildren: app.stage.children.length,
          sameModelInstance: window.__probeModel === window.__pet.model,
          switchError: window.__pet.switchError || null,
        };
      });

    // 记住当前模型实例，切换后要确认还是同一个（空操作，没有重新加载）
    await ctx.win.evaluate(() => {
      window.__probeModel = window.__pet.model;
    });
    const before = await probe();

    const ok = await ctx.win.evaluate(() => window.__pet.switchModel(window.__pet.modelId));
    const after = await probe();

    expect(ok).toBe(true);
    expect(after.switchError).toBeNull();
    expect(after.modelId).toBe(before.modelId);
    // 纹理必须仍然有效
    expect(after.texturesValid).toEqual(before.texturesValid);
    expect(after.texturesValid.every(Boolean)).toBe(true);
    // 画面仍然有内容
    expect(after.opaque).toBeGreaterThan(0);
    expect(Math.abs(after.opaque - before.opaque) / before.opaque).toBeLessThan(0.2);
    // 舞台上一个模型，模型实例也没被换掉
    expect(after.stageChildren).toBe(1);
    expect(after.sameModelInstance).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('并发切换时最后一次请求的形象胜出', async () => {
  // 谁先加载完谁上屏的话，屏幕上可能不是用户最后选的那个，
  // 而主进程已经把最后选的 id 落盘了——重启后会变成另一个形象。
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      window.__probeOldModel = window.__pet.model;
      // 两个请求都不 await，模拟用户在设置窗口里连点两下
      const p1 = window.__pet.switchModel('natori');
      const p2 = window.__pet.switchModel('haru');
      const [r1, r2] = await Promise.all([p1, p2]);
      return {
        r1,
        r2,
        modelId: window.__pet.modelId,
        switchError: window.__pet.switchError || null,
        stageChildren: window.__pet.stage.app.stage.children.length,
        oldModelDetached: window.__probeOldModel.parent === null,
        texturesValid: (window.__pet.model.textures || []).map((t) => t.valid),
      };
    });
    // 最后请求的是 haru，屏幕上也必须是 haru
    expect(result.modelId).toBe('haru');
    expect(result.switchError).toBeNull();
    expect(result.stageChildren).toBe(1);
    expect(result.texturesValid.every(Boolean)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('并发切换到同一个新形象时，胜出的模型纹理仍然有效', async () => {
  // pixi 的纹理缓存以 URL 为键：两次**并发**加载同一形象会拿到同一批
  // Texture 实例。先完成的那次若销毁自己的模型，就会把另一次正在用的
  // 纹理一起销毁——胜出的模型变成没有绑定纹理的空壳，
  // 而 switchModel 仍然报告成功。
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const result = await ctx.win.evaluate(async () => {
      window.__probeOldModel = window.__pet.model;
      const p1 = window.__pet.switchModel('natori');
      const p2 = window.__pet.switchModel('natori');
      const [r1, r2] = await Promise.all([p1, p2]);
      const app = window.__pet.stage.app;
      const raw = app.renderer.plugins.extract._rawPixels(app.stage);
      let opaque = 0;
      for (let i = 3; i < raw.pixels.length; i += 4) {
        if (raw.pixels[i] > 8) opaque++;
      }
      return {
        r1,
        r2,
        modelId: window.__pet.modelId,
        switchError: window.__pet.switchError || null,
        stageChildren: app.stage.children.length,
        oldModelDetached: window.__probeOldModel.parent === null,
        texturesValid: (window.__pet.model.textures || []).map((t) => t.valid),
        opaque,
      };
    });
    expect(result.modelId).toBe('natori');
    expect(result.switchError).toBeNull();
    // 舞台上只有一个模型，旧模型已经摘掉
    expect(result.stageChildren).toBe(1);
    expect(result.oldModelDetached).toBe(true);
    // 纹理必须仍然有效：被销毁的纹理会让模型渲染成空壳
    expect(result.texturesValid.every(Boolean)).toBe(true);
    expect(result.opaque).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
