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
    // 不写死 'haru'：注册表里第一个形象将来可能换人。
    // 从注册表推导期望值，这条断言才不会因为与渲染层无关的原因失败。
    const registry = await ctx.win.evaluate(() =>
      fetch('/assets/live2d/index.json').then((r) => r.json())
    );
    expect(info.modelId).toBe(registry.models[0].id);
    expect(info.hasPixi).toBe(true);
    expect(info.hasCore).toBe(true);
    expect(info.hasLive2d).toBe(true);
    expect(info.expressions.length).toBeGreaterThan(0);
    // 命中区名按名字归一化（head/body），具体叫法由模型作者决定，
    // 这里只断言存在头/身两类命中区，不断言字面拼写。
    expect(info.hitAreas.some((h) => /head/i.test(h))).toBe(true);
    expect(info.hitAreas.some((h) => /body/i.test(h))).toBe(true);
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
      // 行宽必须从实际像素数组里取，**不要**自己乘 renderer.resolution：
      // extract 对 DisplayObject 走 renderer.generateTexture()，
      // 它按 getLocalBounds 创建 RenderTexture 且不传 resolution，
      // 因此行宽恒等于 bounds 宽度（settings.RESOLUTION 默认为 1），
      // 与 renderer.resolution 无关。乘上 resolution 反而会在
      // 150% 缩放的 Windows 11 上取到完全错位的行。
      // _rawPixels 直接返回 {pixels, width, height}，是最不容易算错的取法。
      const raw = extract._rawPixels(app.stage);
      const W = raw.width;
      const H = raw.height;
      // 取眼部区域（上部中央）
      const ex = Math.round(W * 0.38);
      const ey = Math.round(H * 0.115);
      const ew = Math.round(W * 0.24);
      const eh = Math.round(H * 0.055);
      const regionHash = () => {
        // 每帧重新提取：_rawPixels 每次都会重新渲染 target。
        const r = extract._rawPixels(app.stage);
        let v = 0;
        for (let y = ey; y < ey + eh; y++) {
          for (let x = ex; x < ex + ew; x++) {
            const i = (y * r.width + x) * 4;
            v = (v * 31 + r.pixels[i] + r.pixels[i + 1] * 3) >>> 0;
          }
        }
        return v;
      };
      // 采样区是不是真的落在角色身上：统计该区域的不透明像素占比与亮度分布。
      // 「画面在动」这条断言对采到哪一块并不敏感（模型整体都在呼吸），
      // 所以这里额外记录区域特征，让「采错地方」能被看见。
      const regionStats = () => {
        const r = extract._rawPixels(app.stage);
        let opaque = 0;
        let n = 0;
        let sum = 0;
        let sumSq = 0;
        for (let y = ey; y < ey + eh; y++) {
          for (let x = ex; x < ex + ew; x++) {
            const i = (y * r.width + x) * 4;
            if (r.pixels[i + 3] > 8) {
              const lum = 0.299 * r.pixels[i] + 0.587 * r.pixels[i + 1] + 0.114 * r.pixels[i + 2];
              opaque++;
              n++;
              sum += lum;
              sumSq += lum * lum;
            }
          }
        }
        const mean = n ? sum / n : 0;
        return {
          opaqueRatio: opaque / (ew * eh),
          meanLum: mean,
          stdDev: Math.sqrt(Math.max(0, n ? sumSq / n - mean * mean : 0)),
        };
      };
      // 模型上半部分（头顶一带）的平均亮度，作为「脸部应当比周围更亮」的基准。
      const topQuarterMeanLum = () => {
        const r = extract._rawPixels(app.stage);
        const yEnd = Math.round(r.height * 0.25);
        let n = 0;
        let sum = 0;
        for (let y = 0; y < yEnd; y++) {
          for (let x = 0; x < r.width; x++) {
            const i = (y * r.width + x) * 4;
            if (r.pixels[i + 3] > 8) {
              const lum = 0.299 * r.pixels[i] + 0.587 * r.pixels[i + 1] + 0.114 * r.pixels[i + 2];
              n++;
              sum += lum;
            }
          }
        }
        return n ? sum / n : 0;
      };
      const hashes = new Set();
      const stats = regionStats();
      const topMean = topQuarterMeanLum();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const iv = setInterval(() => {
          hashes.add(regionHash());
          if (performance.now() - t0 > 6000) {
            clearInterval(iv);
            resolve();
          }
        }, 30);
      });
      return {
        distinctHashes: hashes.size,
        // 采样几何：实际用的步长必须等于像素数组的真实行宽，
        // 而真实行宽恒等于模型 bounds 宽度（与 renderer.resolution 无关）。
        strideUsed: raw.width,
        arrayRowWidth: raw.width,
        arrayLength: raw.pixels.length,
        boundsWidth: bounds.width,
        boundsHeight: bounds.height,
        rendererResolution: app.renderer.resolution,
        opaqueRatio: stats.opaqueRatio,
        meanLum: stats.meanLum,
        stdDev: stats.stdDev,
        topQuarterMeanLum: topMean,
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
    // 采样步长 = 像素数组真实行宽 = 模型 bounds 宽度。
    // 这条断言会在「误乘 renderer.resolution」时立刻失败：
    // 那样用起来的步长会是行宽的两倍（三倍），采样会落到躯干甚至画外。
    expect(info.arrayRowWidth).toBe(Math.round(info.boundsWidth));
    expect(info.strideUsed).toBe(info.arrayRowWidth);
    expect(info.arrayLength).toBe(info.arrayRowWidth * Math.round(info.boundsHeight) * 4);
    // 采样区确实落在角色身上（有实心像素），而且是有细节的脸部区域
    // （亮度有明显起伏），不是一整片纯色——采错地方时这两条会失败。
    expect(info.opaqueRatio).toBeGreaterThan(0.5);
    expect(info.stdDev).toBeGreaterThan(20);
    // 脸比模型上半部分整体更亮。采样步长一旦错位（采到躯干/深色衣服），
    // 亮度会掉到上半部分均值以下，这条就会失败——
    // 这是让「采到哪一块」不再是一个无关痛痒的量。
    expect(info.meanLum).toBeGreaterThan(info.topQuarterMeanLum * 1.1);
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
    const registry = await ctx.win.evaluate(() =>
      fetch('/assets/live2d/index.json').then((r) => r.json())
    );
    expect(info.error).toBeNull();
    expect(info.ready).toBe(true);
    expect(info.modelLoaded).toBe(true);
    // 未知 id → 回退到注册表首个形象
    expect(info.modelId).toBe(registry.models[0].id);
    expect(info.manifestId).toBe(registry.models[0].id);
  } finally {
    await ctx.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
