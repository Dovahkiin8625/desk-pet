import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers.js';

test('模型成功加载并具备能力', async () => {
  const ctx = await launchApp();
  try {
    const info = await ctx.win.evaluate(() => ({
      ready: window.__pet?.ready,
      error: window.__pet?.error || null,
      modelLoaded: window.__pet?.modelLoaded,
      modelId: window.__pet?.modelId,
      expressions: window.__pet?.expressions,
      hitAreas: window.__pet?.hitAreas,
      naturalSize: window.__pet?.naturalSize,
      hasPixi: typeof window.PIXI !== 'undefined',
      hasCore: typeof window.Live2DCubismCore !== 'undefined',
      hasLive2d: !!(window.PIXI && window.PIXI.live2d),
    }));
    expect(info.error).toBeNull();
    expect(info.ready).toBe(true);
    expect(info.modelLoaded).toBe(true);
    expect(info.modelId).toBe('haru');
    expect(info.hasPixi).toBe(true);
    expect(info.hasCore).toBe(true);
    expect(info.hasLive2d).toBe(true);
    expect(info.expressions.length).toBeGreaterThan(0);
    expect(info.hitAreas).toContain('Head');
    expect(info.hitAreas).toContain('Body');
    expect(info.naturalSize.w).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

test('模型在无输入时自动产生画面变化（呼吸/眨眼/物理生效）', async () => {
  const ctx = await launchApp();
  try {
    await ctx.win.bringToFront();
    const info = await ctx.win.evaluate(async () => {
      const app = window.__pet.stage.app;
      const internal = window.__pet.model.internalModel;
      // 注意：extract.pixels() 每次都会重新渲染；extract.canvas() 返回缓存画面，不可用于逐帧比较
      const extract = app.renderer.plugins.extract;
      const bounds = app.stage.getBounds();
      const W = Math.round(bounds.width);
      const H = Math.round(bounds.height);
      // 取眼部区域（上部中央）
      const ex = Math.round(W * 0.38);
      const ey = Math.round(H * 0.115);
      const ew = Math.round(W * 0.24);
      const eh = Math.round(H * 0.055);
      const regionHash = (px) => {
        let v = 0;
        for (let y = ey; y < ey + eh; y++) {
          for (let x = ex; x < ex + ew; x++) {
            const i = (y * W + x) * 4;
            v = (v * 31 + px[i] + px[i + 1] * 3) >>> 0;
          }
        }
        return v;
      };
      const hashes = new Set();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          hashes.add(regionHash(extract.pixels(app.stage)));
          if (performance.now() - t0 > 6000) {
            clearInterval(iv);
            resolve();
          }
        }, 30);
      });
      return {
        distinctHashes: hashes.size,
        hasBreath: !!internal.breath,
        breathParams: internal.breath ? internal.breath.getParameters().map((p) => p.parameterId) : [],
        hasEyeBlink: !!internal.eyeBlink,
        eyeBlinkParamIds: internal.eyeBlink ? internal.eyeBlink.getParameterIds() : [],
      };
    });

    expect(info.hasBreath).toBe(true);
    expect(info.breathParams).toContain('ParamBreath');
    expect(info.hasEyeBlink).toBe(true);
    expect(info.eyeBlinkParamIds).toContain('ParamEyeLOpen');
    expect(info.distinctHashes).toBeGreaterThan(1);
  } finally {
    await ctx.close();
  }
});

test('未注册的 modelId 回退到注册表里的第一个形象', async () => {
  // settings.json 可以被用户手改，modelId 是任意非空字符串。
  // 渲染层必须对着注册表核对，不能把未知 id 拼进资源路径。
  const userDataDir = await mkdtemp(join(tmpdir(), 'desk-pet-e2e-badid-'));
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ version: 1, modelId: '../../etc', scale: 1, opacity: 1, visible: true }),
    'utf8',
  );
  const ctx = await launchApp({ userDataDir });
  try {
    const info = await ctx.win.evaluate(() => ({
      ready: window.__pet?.ready,
      error: window.__pet?.error || null,
      modelLoaded: window.__pet?.modelLoaded,
      modelId: window.__pet?.modelId,
      manifestId: window.__pet?.manifest?.id || null,
    }));
    expect(info.error).toBeNull();
    expect(info.ready).toBe(true);
    expect(info.modelLoaded).toBe(true);
    // 未知 id → 回退到注册表首个形象
    expect(info.modelId).toBe('haru');
    expect(info.manifestId).toBe('haru');
  } finally {
    await ctx.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
