// Cubism 2 老模型（DSR50）的端到端验证。
//
// DSR50 是 Cubism 2 格式：.moc（不是 .moc3）、model0.json（不是 .model3.json），
// 动作文件是**文本**格式（"# Live2D Animator Motion Data"）。
// 它走的是完全不同的运行时与解析路径，所以单独测。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-cubism2');
const DSR50 = join(ROOT, 'assets', 'live2d', 'models', 'DSR50');

test.describe('Cubism 2 老模型', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('DSR50 能被导入、加载并渲染', async () => {
    // DSR50 只有旧版 Cubism SDK 才带（Cubism 5 的 SDK 与上游样例仓库
    // 都没有它），本机没有这个模型文件时这条用例没法跑——跳过，
    // 而不是让它永远红着。
    test.skip(!existsSync(DSR50), `本机没有 DSR50 样例模型（${DSR50}）`);

    const app = await electron.launch({
      args: [ROOT],
      env: {
        ...process.env,
        DESK_PET_USER_DATA: USER_DATA,
        DESK_PET_E2E: '1',
      },
    });
    try {
      // 把原生对话框指向真的 DSR50 目录：走完整的导入路径。
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [DSR50],
        });
        dialog.showMessageBox = async () => ({ response: 1 });
      });

      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      // 打开设置窗口并导入。
      await pet.evaluate(() => window.pet.openSettings());
      const settings = await app.waitForEvent('window');
      await settings.waitForLoadState('domcontentloaded');
      await settings.waitForFunction(() => document.querySelectorAll('#model option').length > 0, null, {
        timeout: 15000,
      });

      await settings.click('#importModel');

      // 导入后自动切到新模型，桌宠跑的就是它。
      await pet.waitForFunction(() => window.__pet?.modelId === 'dsr50', null, { timeout: 30000 });

      const info = await pet.evaluate(() => ({
        id: window.__pet.modelId,
        base: window.__pet.manifest?.base,
        cubismVersion: window.__pet.manifest?.cubismVersion,
        modelFile: window.__pet.manifest?.modelFile,
        textures: window.__pet.model?.textures?.length ?? 0,
        hitAreas: window.__pet.hitAreas,
        motionGroups: Object.keys(window.__pet.manifest?.motionGroups || {}),
        idleMotion: window.__pet.manifest?.motions?.idle,
        error: window.__pet.error || null,
      }));

      // 认出是 Cubism 2，且设置文件指向 model0.json。
      expect(info.cubismVersion).toBe(2);
      expect(info.modelFile).toBe('model0.json');
      expect(info.base).toBe('/__models__');

      // 纹理真的加载出来了。
      expect(info.textures).toBeGreaterThan(0);
      expect(info.error).toBeNull();

      // 命中区来自老格式的 hit_areas。
      expect(info.hitAreas).toContain('D_REF.FACE');

      // 动作组探测到了，而且**待机**挑的是 idle 那一组
      // （老模型的第一个组是 tap，直接取第一个会把点击动作当待机动作）。
      expect(info.motionGroups).toContain('idle');
      expect(info.motionGroups).toContain('tap');
      expect(info.idleMotion?.group).toBe('idle');

      // 画布上真的画出了东西。
      //
      // 用 PIXI 自己的 extract：它会把舞台**重新渲染**到一张离屏纹理上，
      // 再读像素。直接 gl.readPixels 读不到东西——PIXI 建上下文时没开
      // preserveDrawingBuffer，浏览器合成完那一帧之后缓冲区就被清掉了。
      const painted = await pet.evaluate(async () => {
        const app = window.__pet.stage?.app;
        if (!app) return { ok: false, reason: 'no app' };
        const canvas = app.renderer.extract.canvas(app.stage);
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 10) opaque++;
        }
        return { ok: true, opaque, total: canvas.width * canvas.height };
      });
      expect(painted.ok).toBe(true);
      expect(painted.opaque).toBeGreaterThan(1000);

      // 动作文件是**文本**格式（"# Live2D Animator Motion Data"），
      // 只有老 SDK 认得。这里真的播一次：播得起来就说明它被解析了。
      const motion = await pet.evaluate(async () => {
        try {
          await window.__pet.model.motion('tap', 0);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      });
      expect(motion.ok).toBe(true);

      // 老 SDK 直接读一遍那个文本动作文件：应当解析出若干条曲线。
      const parsed = await pet.evaluate(async () => {
        const res = await fetch('/__models__/dsr50/motions_tap_0_file_0');
        const ab = await res.arrayBuffer();
        const m = window.Live2DMotion.loadMotion(ab);
        return { curves: m?.motions?.length ?? 0 };
      });
      expect(parsed.curves).toBeGreaterThan(10);
    } finally {
      await app.close();
    }
  });
});
