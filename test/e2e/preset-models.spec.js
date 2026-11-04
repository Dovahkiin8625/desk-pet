// 预制（内置）模型的端到端验证。
//
// 内置注册表（assets/live2d/index.json）里的每一条都必须真的能加载：
// 注册表里写错一个 model3 文件名，表现是「那个形象切过去就是空白」，
// 而清单缺失时应用会**静默降级**（从设置文件探测能力），
// 用户完全看不出发生了什么——所以这里逐个真的挂载一遍。
//
// 还锁住两条清单不变量：
//   1. 每个预制模型都带手写清单（manifest.derived 为 false）；
//      降级清单意味着「表情语义靠猜」，那是明确不做的。
//   2. 模型自带表情时，必须映射出 normal —— 否则换过表情之后
//      脸回不到默认脸（没有 normal 就没法复位），会一直挂着上一张脸。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-preset-models');

/** 启动一个桌宠；userData 目录可以指定（不同用例各用各的，别互相污染）。 */
async function launch(userData = USER_DATA) {
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: userData,
      DESK_PET_E2E: '1',
    },
  });
}

/** 内置注册表里登记的 id（读仓库里的 assets/live2d/index.json）。 */
async function readBundledIds() {
  const registry = JSON.parse(await readFile(join(ROOT, 'assets', 'live2d', 'index.json'), 'utf8'));
  return (registry.models || []).map((m) => m.id);
}

/** 挂载一个形象，把它看到的东西原样报回来。 */
async function mount(pet, modelId) {
  return pet.evaluate(async (id) => {
    const ok = await window.__pet.switchModel(id);
    if (!ok) {
      return { ok: false, error: window.__pet.switchError || '未知原因' };
    }
    // 等两帧：挂载完了不等于画出来了。
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // 画布上到底有没有画出东西（不透明的像素）。
    // 「加载成功但渲染炸了」是真实发生过的事：模型能加载、纹理也绑上了，
    // 却在绘制时抛异常——画布上什么也没有。
    //
    // 提取时要关掉面剔除：PIXI 的 extract 用 Y 轴翻转的投影做离屏渲染
    // （最后再翻回来），三角形绕序随之反转，Live2D 的单面部件会被剔除掉
    // ——那些部件在屏幕上明明是画着的。应用自己测轮廓时也是这么处理的
    // （见 src/renderer/pet/silhouette.js）。
    let painted = 0;
    try {
      const app = window.__pet.stage?.app;
      const gl = app.renderer.gl;
      const origEnable = gl.enable.bind(gl);
      const origDisable = gl.disable.bind(gl);
      gl.enable = (cap) => {
        if (cap !== gl.CULL_FACE) origEnable(cap);
      };
      gl.disable = (cap) => {
        if (cap !== gl.CULL_FACE) origDisable(cap);
      };
      try {
        const canvas = app.renderer.plugins.extract.canvas(app.stage);
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 16) painted++;
        }
      } finally {
        gl.enable = origEnable;
        gl.disable = origDisable;
      }
    } catch (err) {
      return { ok: false, error: `读取画布失败：${err?.message || err}` };
    }
    return {
      ok: true,
      modelId: window.__pet.modelId,
      textures: window.__pet.model?.textures?.length ?? 0,
      painted,
      naturalSize: window.__pet.naturalSize,
      derived: window.__pet.manifest?.derived,
      expressions: window.__pet.manifest?.expressions || {},
      availableExpressions: window.__pet.manifest?.availableExpressions || [],
    };
  }, modelId);
}

/** 应用为**当前**形象量出的可见矩形（可点击区域就按它算）。 */
async function visibleRect(pet) {
  return pet.evaluate(() => {
    const r = window.__pet.contentRect;
    return r ? { width: r.width, height: r.height } : null;
  });
}

test.describe('预制模型', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('注册表里的每个预制模型都能加载出来', async () => {
    const app = await launch();
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      const bundled = await pet.evaluate(async () => {
        const list = await window.pet.listModels();
        return list.filter((m) => m.source === 'bundled').map((m) => m.id);
      });
      // 预制模型不止一个：只有一个的话这个用例等于什么都没验证。
      expect(bundled.length).toBeGreaterThan(1);

      for (const id of bundled) {
        const before = await visibleRect(pet);
        const currentId = await pet.evaluate(() => window.__pet.modelId);
        const r = await mount(pet, id);
        expect(r.ok, `${id} 加载失败：${r.error}`).toBe(true);
        expect(r.modelId).toBe(id);
        // 纹理真的加载出来了：模型文件与纹理都在子目录里，
        // 相对路径必须按 model3.json 自己的目录解析。
        expect(r.textures, `${id} 没有纹理`).toBeGreaterThan(0);
        expect(r.naturalSize?.w, `${id} 的自然尺寸是 0`).toBeGreaterThan(0);
        expect(r.naturalSize?.h, `${id} 的自然尺寸是 0`).toBeGreaterThan(0);
        // 真的画出来了：画布上得有东西。
        expect(r.painted, `${id} 没有画出任何像素`).toBeGreaterThan(0);

        // 应用也为**这个**形象重新量了可见矩形（可点击区域就按它算）。
        // 量到的还是上一个模型的矩形，就说明新模型没被量到。
        // （切到当前已经在跑的形象不会重新量——那不是切换。）
        if (before && currentId !== id) {
          await pet.waitForFunction(
            (prev) => {
              const rect = window.__pet.contentRect;
              if (!rect) return false;
              return Math.abs(rect.width - prev.width) > 1 || Math.abs(rect.height - prev.height) > 1;
            },
            before,
            { timeout: 15000 },
          );
        }
        const after = await visibleRect(pet);
        expect(after, `${id} 没有量出可见矩形`).toBeTruthy();
        expect(after.width, `${id} 的可见矩形宽度是 0`).toBeGreaterThan(0);
        expect(after.height, `${id} 的可见矩形高度是 0`).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  test('每个预制模型都带手写清单，映射的表情名都真实存在', async () => {
    const app = await launch();
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      const bundled = await pet.evaluate(async () => {
        const list = await window.pet.listModels();
        return list.filter((m) => m.source === 'bundled').map((m) => m.id);
      });

      for (const id of bundled) {
        const r = await mount(pet, id);
        expect(r.ok, `${id} 加载失败：${r.error}`).toBe(true);

        // 每个预制模型都带手写清单：降级清单意味着表情语义靠猜。
        expect(r.derived, `${id} 没有手写清单（走了降级探测）`).toBe(false);

        // 映射到的表情名必须是模型**自己的**表情名：写错一个字母
        // 表现是「换表情没反应」，而清单不会报错。
        for (const [semantic, name] of Object.entries(r.expressions)) {
          expect(
            r.availableExpressions.includes(name),
            `${id} 的 ${semantic} 指向了不存在的表情 ${name}`,
          ).toBe(true);
        }

        // 模型自带表情时必须映射出 normal：换过表情之后要能复位回默认脸，
        // 没有 normal 就只能一直挂着上一张脸。
        if (r.availableExpressions.length > 0) {
          expect(r.expressions.normal, `${id} 自带表情却没有 normal 映射`).toBeTruthy();
        }
      }
    } finally {
      await app.close();
    }
  });

  test('预制的形象也能移除：移除后不再出现在列表里，重启也还在', async () => {
    const userData = join(ROOT, '.tmp-e2e-preset-remove');
    await rm(userData, { recursive: true, force: true });
    await mkdir(userData, { recursive: true });

    const app = await launch(userData);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      const before = await pet.evaluate(async () => (await window.pet.listModels()).map((m) => m.id));
      expect(before).toContain('haru');

      // 删除要走设置窗口（主进程只认设置窗口的发送方），
      // 确认框是原生的——把它换成「直接点确认」。
      await pet.evaluate(() => window.pet.openSettings());
      const settings = await app.waitForEvent('window', { timeout: 15000 });
      await settings.waitForLoadState('domcontentloaded');
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      });

      const result = await settings.evaluate(() => window.pet.deleteModel('haru'));
      expect(result.ok, `移除预制形象失败：${result.error}`).toBe(true);

      // 列表里没有了。
      const after = await pet.evaluate(async () => (await window.pet.listModels()).map((m) => m.id));
      expect(after).not.toContain('haru');
      // 其余形象不受影响。
      expect(after.length).toBe(before.length - 1);
    } finally {
      await app.close();
    }

    // 重启后仍然是被移除的：移除记录落在用户数据目录里。
    const app2 = await launch(userData);
    try {
      const pet = await app2.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
      const ids = await pet.evaluate(async () => (await window.pet.listModels()).map((m) => m.id));
      expect(ids).not.toContain('haru');
    } finally {
      await app2.close();
    }

    await rm(userData, { recursive: true, force: true });
  });

  test('不能把最后一个形象也移除掉', async () => {
    const userData = join(ROOT, '.tmp-e2e-preset-last');
    await rm(userData, { recursive: true, force: true });
    // 先把清单写到只剩一个形象（模拟用户移掉了其它全部）。
    const all = await readBundledIds();
    await mkdir(join(userData, 'live2d'), { recursive: true });
    await writeFile(
      join(userData, 'live2d', 'removed.json'),
      JSON.stringify({ version: 1, models: all.slice(1) }),
    );

    const app = await launch(userData);
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      const ids = await pet.evaluate(async () => (await window.pet.listModels()).map((m) => m.id));
      expect(ids).toHaveLength(1);

      await pet.evaluate(() => window.pet.openSettings());
      const settings = await app.waitForEvent('window', { timeout: 15000 });
      await settings.waitForLoadState('domcontentloaded');
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 });
      });

      const result = await settings.evaluate((id) => window.pet.deleteModel(id), ids[0]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('至少要保留一个形象');
    } finally {
      await app.close();
    }

    await rm(userData, { recursive: true, force: true });
  });
});
