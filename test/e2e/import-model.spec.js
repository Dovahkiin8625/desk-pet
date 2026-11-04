// 导入模型的端到端验证：主进程注册表 → app:// 虚拟根 → 渲染层加载。
//
// 这里不走「导入模型…」按钮（那需要原生文件夹选择器，自动化驱动不了），
// 而是**直接摆好**导入之后应有的样子：userData 里放一份模型目录 +
// 一份用户注册表。然后看：
//   1. 渲染层能不能通过 app:// 的虚拟根把模型加载出来；
//   2. 设置窗口的下拉框里有没有它、能不能删。
//
// 模型文件用的是 Haru 的真 moc3 与纹理——这样测的是**真的**加载路径，
// 而不是一份空壳清单。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-userdata');
const HARU = join(ROOT, 'assets', 'live2d', 'models', 'haru');

/** 在 userData 里摆一份「导入好的」模型与用户注册表。 */
async function seedImportedModel() {
  const modelDir = join(USER_DATA, 'live2d', 'models', 'testchar');
  await rm(modelDir, { recursive: true, force: true });
  await mkdir(join(modelDir, 'Haru.2048'), { recursive: true });
  await cp(join(HARU, 'Haru.moc3'), join(modelDir, 'Haru.moc3'));
  await cp(join(HARU, 'Haru.2048', 'texture_00.png'), join(modelDir, 'Haru.2048', 'texture_00.png'));
  await cp(join(HARU, 'Haru.2048', 'texture_01.png'), join(modelDir, 'Haru.2048', 'texture_01.png'));
  await writeFile(
    join(modelDir, 'TestChar.model3.json'),
    JSON.stringify({
      Version: 3,
      FileReferences: {
        Moc: 'Haru.moc3',
        Textures: ['Haru.2048/texture_00.png', 'Haru.2048/texture_01.png'],
      },
    }),
  );
  // 导入流程会生成的 pet.json：只有基础字段，**不猜**表情语义。
  await writeFile(
    join(modelDir, 'pet.json'),
    JSON.stringify({
      id: 'testchar',
      name: 'TestChar',
      model3: 'TestChar.model3.json',
      viewport: { width: 300, height: 560 },
      fit: { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] },
    }),
  );
  // 用户注册表。
  await writeFile(
    join(USER_DATA, 'live2d', 'registry.json'),
    JSON.stringify({
      version: 1,
      models: [
        {
          id: 'testchar',
          name: 'TestChar',
          model3: 'TestChar.model3.json',
          manifest: 'testchar/pet.json',
        },
      ],
    }),
  );
  // 选中导入的形象：默认是内置的 haru，不改的话桌宠启动时跑的是它。
  await writeFile(
    join(USER_DATA, 'settings.json'),
    JSON.stringify({
      version: 1,
      modelId: 'testchar',
      scale: 1,
      opacity: 1,
      visible: true,
    }),
  );
}

test.describe('导入的 Live2D 模型', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await seedImportedModel();
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('能通过虚拟根加载出来，并出现在设置窗口的形象列表里', async () => {
    const app = await electron.launch({
      args: [ROOT],
      env: {
        ...process.env,
        DESK_PET_USER_DATA: USER_DATA,
        DESK_PET_E2E: '1',
      },
    });
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      // 加载的是**导入的**那个形象，不是内置的 Haru。
      const modelId = await pet.evaluate(() => window.__pet.modelId);
      expect(modelId).toBe('testchar');

      // base 指向用户模型的虚拟根——加载路径确实走的是那里。
      const base = await pet.evaluate(() => window.__pet.manifest?.base);
      expect(base).toBe('/__models__');

      // 纹理真的加载出来了（模型文件与纹理都在子目录里，
      // 相对路径必须按 model3.json 自己的目录解析）。
      const textures = await pet.evaluate(() => window.__pet.model?.textures?.length ?? 0);
      expect(textures).toBeGreaterThan(0);

      // 打开设置窗口。
      await pet.evaluate(() => window.pet.openSettings());
      const settings = await app.waitForEvent('window');
      await settings.waitForLoadState('domcontentloaded');
      await settings.waitForFunction(() => document.querySelectorAll('#model option').length > 0, null, {
        timeout: 15000,
      });

      // 下拉框里有导入的形象，且标注了「（导入）」。
      const options = await settings.$$eval('#model option', (els) =>
        els.map((e) => ({ value: e.value, text: e.textContent })),
      );
      expect(options.map((o) => o.value)).toContain('testchar');
      expect(options.find((o) => o.value === 'testchar').text).toContain('导入');
      // 内置形象也还在。
      expect(options.map((o) => o.value)).toContain('haru');

      // 选中的导入形象可以删；内置的不行。
      await settings.selectOption('#model', 'testchar');
      await settings.waitForFunction(() => document.getElementById('deleteModel')?.disabled === false, null, {
        timeout: 10000,
      });
      await settings.selectOption('#model', 'haru');
      await settings.waitForFunction(() => document.getElementById('deleteModel')?.disabled === true, null, {
        timeout: 10000,
      });

      // 「导入模型…」按钮在。
      await expect(settings.locator('#importModel')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('「导入模型…」与「删除」按钮的完整流程', async () => {
    // 准备一个待导入的模型文件夹（用 Haru 的真 moc3 与纹理）。
    const sourceDir = join(ROOT, '.tmp-e2e-src', 'Char');
    await rm(join(ROOT, '.tmp-e2e-src'), { recursive: true, force: true });
    await mkdir(join(sourceDir, 'Char.2048'), { recursive: true });
    await cp(join(HARU, 'Haru.moc3'), join(sourceDir, 'Haru.moc3'));
    await cp(join(HARU, 'Haru.2048', 'texture_00.png'), join(sourceDir, 'Char.2048', 'texture_00.png'));
    await cp(join(HARU, 'Haru.2048', 'texture_01.png'), join(sourceDir, 'Char.2048', 'texture_01.png'));
    await writeFile(
      join(sourceDir, 'Char.model3.json'),
      JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: 'Haru.moc3',
          Textures: ['Char.2048/texture_00.png', 'Char.2048/texture_01.png'],
        },
      }),
    );

    const app = await electron.launch({
      args: [ROOT],
      env: {
        ...process.env,
        DESK_PET_USER_DATA: USER_DATA,
        DESK_PET_E2E: '1',
      },
    });
    try {
      // 把原生对话框换掉：自动化驱动不了系统文件夹选择器，
      // 但「选完之后发生了什么」正是要测的部分。
      await app.evaluate(({ dialog }, source) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
        dialog.showMessageBox = async () => ({ response: 1 });
      }, sourceDir);

      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      await pet.evaluate(() => window.pet.openSettings());
      const settings = await app.waitForEvent('window');
      await settings.waitForLoadState('domcontentloaded');
      await settings.waitForFunction(() => document.querySelectorAll('#model option').length > 0, null, {
        timeout: 15000,
      });

      // 导入。
      await settings.click('#importModel');
      await settings.waitForFunction(
        () => Array.from(document.querySelectorAll('#model option')).some((o) => o.value === 'char'),
        null,
        { timeout: 30000 },
      );
      // 导入后自动切到新模型：桌宠跑的就是它。
      await pet.waitForFunction(() => window.__pet?.modelId === 'char', null, { timeout: 30000 });
      // 状态栏报告成功。
      await settings.waitForFunction(
        () => document.getElementById('status')?.textContent?.includes('已导入'),
        null,
        { timeout: 15000 },
      );

      // 模型文件确实落到了用户数据目录里。
      const copied = await app.evaluate(async ({ app: electronApp }) => {
        // 主进程是 ESM，evaluate 里没有 require；
        // process.getBuiltinModule 是 ESM 下拿到内置模块的办法。
        const fs = process.getBuiltinModule('node:fs/promises');
        const path = process.getBuiltinModule('node:path');
        const dir = path.join(electronApp.getPath('userData'), 'live2d', 'models', 'char');
        const files = await fs.readdir(dir).catch(() => []);
        return files;
      });
      expect(copied).toContain('Char.model3.json');
      expect(copied).toContain('pet.json');

      // 删除。
      await settings.selectOption('#model', 'char');
      await settings.waitForFunction(() => document.getElementById('deleteModel')?.disabled === false, null, {
        timeout: 10000,
      });
      await settings.click('#deleteModel');
      await settings.waitForFunction(
        () => !Array.from(document.querySelectorAll('#model option')).some((o) => o.value === 'char'),
        null,
        { timeout: 20000 },
      );
      // 目录也被删了。
      const afterDelete = await app.evaluate(async ({ app: electronApp }) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const path = process.getBuiltinModule('node:path');
        const dir = path.join(electronApp.getPath('userData'), 'live2d', 'models', 'char');
        const exists = await fs.stat(dir).then(() => true, () => false);
        return exists;
      });
      expect(afterDelete).toBe(false);
    } finally {
      await app.close();
      await rm(join(ROOT, '.tmp-e2e-src'), { recursive: true, force: true });
    }
  });
});
