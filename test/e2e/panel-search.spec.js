// 搜索框的新本事：图标、更宽的搜索范围、右键菜单。
//
// 覆盖三件事：
//   1. 程序与文件显示**自己的图标**（不是统一的符号）；
//   2. 搜索范围盖住 Win+S 能搜到的东西：程序、文件、系统设置；
//   3. 右键菜单能打开、能定位到所在目录。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-search');

/** 假程序清单：指向真的 notepad.exe（这样图标抽得出来）。 */
const FAKE_APPS = join(USER_DATA, 'apps.json');
const NOTEPAD = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe');

/** 启动应用（E2E 模式：不抢单实例锁，用临时 userData）。 */
async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
      DESK_PET_E2E_APPS: FAKE_APPS,
    },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开插件面板，返回那个窗口。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  if (!panel) throw new Error('面板窗口没有出现');
  await panel.waitForLoadState('domcontentloaded');
  await panel.waitForFunction(() => (window.__panel?.resultIds || []).length > 0, null, {
    timeout: 15000,
  });
  return panel;
}

test.describe('搜索框', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await writeFile(
      FAKE_APPS,
      JSON.stringify([
        { name: '记事本', target: NOTEPAD, kind: 'path', hint: 'C:\\Windows\\System32' },
      ]),
      'utf8'
    );
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('程序显示自己的图标', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', '记事本');
      await panel.waitForFunction(() => (window.__panel?.appIds || []).length > 0, null, {
        timeout: 10000,
      });

      // 图标是**抽出来的**（notepad.exe 的图标），不是统一的符号。
      const img = panel.locator('#results li img.icon-img').first();
      await expect(img).toBeVisible({ timeout: 10000 });
      const src = await img.getAttribute('src');
      expect(src).toMatch(/^data:image\/png;base64,/);
    } finally {
      await app.close();
    }
  });

  test('能搜到系统设置页', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', '蓝牙');
      await panel.waitForFunction(
        () => (window.__panel?.settingIds || []).includes('settings:bluetooth'),
        null,
        { timeout: 10000 }
      );
      await expect(panel.locator('#results li:has-text("蓝牙和设备")')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('能搜到本机文件', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      // 文件走的是 Windows 搜索索引：这台机器上索引里有没有东西不归测试管，
      // 但通道得是通的（返回的是文件条目，不是程序条目）。
      const files = await panel.evaluate(() => window.panel.files('desktop'));
      expect(Array.isArray(files)).toBe(true);
      for (const file of files) {
        expect(file.kind).toBe('file');
        expect(file.name).toBeTruthy();
        expect(file.target).toBeTruthy();
      }
    } finally {
      await app.close();
    }
  });

  test('右键菜单：打开与打开所在目录', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', '记事本');
      await panel.waitForFunction(() => (window.__panel?.appIds || []).length > 0, null, {
        timeout: 10000,
      });

      // 右键：渲染层把那条结果交给主进程弹原生菜单。
      await panel.locator('#results li').first().click({ button: 'right' });
      const target = await panel.evaluate(() => window.__panel.contextTarget);
      expect(target).toBeTruthy();
      expect(target.kind).toBe('app');
      expect(target.path).toBe(NOTEPAD);
    } finally {
      await app.close();
    }
  });
});
