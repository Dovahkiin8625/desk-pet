import { test, expect } from '@playwright/test';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODELS_DIR = join(ROOT, 'assets', 'live2d', 'models');
const SRC_DIR = join(MODELS_DIR, 'haru');

// 夹具放在 haru/ 目录下：该路径已被 .gitignore 覆盖
// （assets/live2d/models/haru/*），测试结束后整个目录被删掉，不会入库。
const FIXTURE_ID = 'haru/_e2e_no_pet_json';
const FIXTURE_DIR = join(MODELS_DIR, 'haru', '_e2e_no_pet_json');

/**
 * 造一个「没有 pet.json 的模型目录」。
 * 只复制模型自身的文件（moc3 / 贴图 / 动作 / 表情 / 音效），**不复制 pet.json**——
 * 这正是「把模型目录放进去就能加载」里那个没有清单的目录。
 */
async function createFixtureModelDir() {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });
  for (const entry of await readdir(SRC_DIR, { withFileTypes: true })) {
    if (entry.name === 'pet.json') continue;
    if (entry.name === '_e2e_no_pet_json') continue;
    await cp(join(SRC_DIR, entry.name), join(FIXTURE_DIR, entry.name), { recursive: true });
  }
}

test('模型目录没有 pet.json 时自动探测补齐，仍能加载', async () => {
  await createFixtureModelDir();
  let ctx = null;
  try {
    ctx = await launchApp();
    const info = await ctx.win.evaluate(async (fixtureId) => {
      // 只把「形象注册表」这一处读取换成夹具条目：
      // 注册表是**数据**（有哪些形象），不是代码路径。
      // 其余一切（model3.json、pet.json 的 404、贴图、moc3）都走真实的 app:// 服务，
      // 所以下面走的是真实的 loadManifest → fetch → mergeManifest 全链路，
      // 而不是手搓一个 model3 对象喂给 deriveManifest。
      const realFetch = window.fetch.bind(window);
      const realRegistry = await realFetch('/assets/live2d/index.json').then((r) => r.json());
      const registry = {
        ...realRegistry,
        models: [
          ...realRegistry.models,
          {
            id: fixtureId,
            name: 'E2E NoPetJson',
            manifest: 'haru/_e2e_no_pet_json/pet.json',
            model3: 'Haru.model3.json',
          },
        ],
      };
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (url.includes('/assets/live2d/index.json')) {
          return new Response(JSON.stringify(registry), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          });
        }
        return realFetch(input, init);
      };

      const { loadManifest, resolveExpressionName, resolveMotionSpec } =
        await import('/src/renderer/pet/manifest.js');
      const { loadPetModel, disposePetModel } = await import('/src/renderer/pet/model.js');

      const manifest = await loadManifest(fixtureId);

      // 夹具模型本身也要能真的加载出来（moc3 / 贴图都在，缺的只是清单）。
      let modelLoaded = false;
      let modelError = null;
      let motionGroupsInModel = [];
      try {
        const model = await loadPetModel(manifest);
        modelLoaded = !!model?.internalModel;
        motionGroupsInModel = Object.keys(model?.internalModel?.motionManager?.definitions || {});
        disposePetModel(model);
      } catch (err) {
        modelError = String(err?.message || err);
      }

      return {
        id: manifest.id,
        derived: manifest.derived,
        model3: manifest.model3,
        expressionKeys: Object.keys(manifest.expressions || {}),
        motionKeys: Object.keys(manifest.motions || {}),
        availableExpressions: manifest.availableExpressions || [],
        motionGroups: manifest.motionGroups || {},
        // 语义映射：降级时只保证「普通表情」有值，其余语义回退到第一个可用表情。
        normal: resolveExpressionName(manifest, 'normal'),
        happy: resolveExpressionName(manifest, 'happy'),
        angry: resolveExpressionName(manifest, 'angry'),
        motion: resolveMotionSpec(manifest, 'tapHead'),
        motionUnknown: resolveMotionSpec(manifest, '不存在的键'),
        modelLoaded,
        modelError,
        motionGroupsInModel,
        // 当前屏幕上的宠物不受影响
        petModelLoaded: window.__pet?.modelLoaded === true,
        petModelId: window.__pet?.modelId || null,
      };
    }, FIXTURE_ID);

    // 注册表是 id 的唯一真相：夹具 id 原样透传。
    expect(info.id).toBe(FIXTURE_ID);
    // 没有 pet.json → 清单完全来自探测。
    expect(info.derived).toBe(true);
    expect(info.model3).toBe('Haru.model3.json');

    // 能力探测：表情名与动作组都探出来了。
    expect(info.availableExpressions).toContain('F01');
    expect(info.availableExpressions.length).toBeGreaterThan(0);
    expect(info.motionGroups.Idle).toBeGreaterThan(0);
    expect(info.motionGroups.TapBody).toBeGreaterThan(0);
    expect(info.expressionKeys).toContain('normal');
    expect(info.motionKeys).toContain('idle');
    expect(info.motionKeys).toContain('tapHead');

    // 语义解析不崩溃：普通表情有值；未映射的语义**不猜**，返回 null
    // （交互层因此只播动作、不套表情）；动作组不存在时如实返回 null。
    expect(typeof info.normal).toBe('string');
    expect(info.happy).toBeNull();
    expect(info.angry).toBeNull();
    expect(info.motion).not.toBeNull();
    expect(info.motionUnknown).toBeNull();

    // 降级时**不按序号猜语义**：Haru 的 expressions[1] 是 F02，而 pet.json 里 F02 是 angry。
    // 按序号猜会让「摸头」触发生气的脸，所以未映射的语义必须解析为 null。
    expect(info.normal).toBe(info.availableExpressions[0]);
    expect(info.happy).not.toBe('F02');
    expect(info.happy).not.toBe(info.availableExpressions[0]);

    // 夹具模型真的能加载（moc3 / 贴图都在，缺的只是清单）。
    expect(info.modelError).toBeNull();
    expect(info.modelLoaded).toBe(true);
    expect(info.motionGroupsInModel).toContain('TapBody');

    // 当前宠物没被降级路径影响。
    expect(info.petModelLoaded).toBe(true);
  } finally {
    await ctx?.close();
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  }
});

test('有 pet.json 时清单优先于探测，语义映射不被按序号覆盖', async () => {
  const ctx = await launchApp();
  try {
    const info = await ctx.win.evaluate(async () => {
      const { resolveExpressionName, resolveMotionSpec } =
        await import('/src/renderer/pet/manifest.js');
      // window.__pet.manifest 是应用启动时真实 loadManifest() 的产物：
      // 走真实注册表、真实 pet.json、真实 model3.json。
      const m = window.__pet.manifest;
      return {
        id: m?.id,
        derived: m?.derived,
        expressions: m?.expressions || {},
        availableExpressions: m?.availableExpressions || [],
        happy: resolveExpressionName(m, 'happy'),
        angry: resolveExpressionName(m, 'angry'),
        normal: resolveExpressionName(m, 'normal'),
        drag: resolveMotionSpec(m, 'drag'),
        tapHead: resolveMotionSpec(m, 'tapHead'),
      };
    });

    // 有清单 → derived 为 false，id 以注册表为准。
    expect(info.derived).toBe(false);
    expect(info.id).toBe('haru');

    // pet.json 的语义映射完整生效（探测值不覆盖清单值）。
    expect(info.expressions.happy).toBe('F05');
    expect(info.expressions.angry).toBe('F02');
    expect(info.expressions.normal).toBe('F01');
    expect(info.happy).toBe('F05');
    expect(info.angry).toBe('F02');
    expect(info.normal).toBe('F01');

    // 动作映射同样以清单为准，且索引落在该组的有效范围内。
    expect(info.tapHead.group).toBe('TapBody');
    expect(info.drag.group).toBe('TapBody');
    expect(info.drag.index).toBeLessThan(4);
  } finally {
    await ctx.close();
  }
});
