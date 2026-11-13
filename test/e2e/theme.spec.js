// 共享设计系统：theme.css 要能被 app:// 页面取到，变量要能解析，
// 而且 blocks.css 得是**靠 @import** 拿到这些变量的（而不是各自硬写一套）。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-theme');

async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: USER_DATA, DESK_PET_E2E: '1' },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes(part)) return win;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

test.describe('共享设计系统', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('theme.css 能被 app:// 页面取到，变量能解析', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel?.());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板没有出现').not.toBeNull();

      const info = await panel.evaluate(() => {
        const sheets = [...document.styleSheets].map((s) => s.href || '');
        let blocksImport = null;
        for (const sheet of document.styleSheets) {
          if (!sheet.href || !sheet.href.endsWith('/src/renderer/ui/blocks.css')) continue;
          const rule = sheet.cssRules?.[0];
          blocksImport = {
            isImport: rule?.constructor?.name === 'CSSImportRule',
            href: rule?.href || '',
          };
        }
        // 变量是 light-dark()：自定义属性本身是原样的标记，
        // **用出来的颜色**才是解析后的值——那才是界面上的东西。
        const probe = document.createElement('div');
        probe.style.background = 'var(--dp-bg)';
        probe.style.color = 'var(--dp-accent)';
        document.body.append(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return { sheets, bg, accent, blocksImport };
      });

      // 主题被加载了。
      expect(info.sheets.some((h) => h.endsWith('/src/renderer/ui/theme.css'))).toBe(true);
      // 变量解析成了预期的值（浅色那一套）。
      expect(info.bg).toBe('rgb(255, 253, 248)');
      expect(info.accent).toBe('rgb(217, 201, 163)');
      // blocks.css 的**第一条**规则是 import 指向 theme.css。
      expect(info.blocksImport?.isImport).toBe(true);
      expect(info.blocksImport?.href).toContain('/src/renderer/ui/theme.css');
    } finally {
      await app.close();
    }
  });

  test('宿主页面的配色是跟着主题走的，不是自己写死的一套', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel?.());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板没有出现').not.toBeNull();

      const info = await panel.evaluate(() => {
        const card = getComputedStyle(document.getElementById('panel'));
        // token 的**用出来的颜色**（跟卡片底色同一个尺子）。
        const probe = document.createElement('div');
        probe.style.background = 'var(--dp-bg)';
        probe.style.color = 'var(--dp-text)';
        document.body.append(probe);
        const bgToken = getComputedStyle(probe).backgroundColor;
        const textToken = getComputedStyle(probe).color;
        probe.remove();
        return { bgToken, cardBg: card.backgroundColor, textToken, cardColor: card.color };
      });

      // 卡片底色与文字色都等于主题里的 token：
      // 改了主题的 --dp-bg，这一页得跟着变——否则就是两套配色。
      expect(info.cardBg).toBe(info.bgToken);
      expect(info.cardColor).toBe(info.textToken);
    } finally {
      await app.close();
    }
  });

  test('设置里换主题，全应用跟着换', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openSettings?.());
      const settings = await findWindow(app, '/settings/index.html');
      expect(settings, '设置窗口没有出现').not.toBeNull();

      // 换一套配色（主题与明暗都在「外观」分区里）。
      await settings.locator('#tab-appearance').click();
      await settings.locator('#themeSelect').selectOption('ink');
      await settings.locator('input[name="mode"][value="dark"]').check();

      // 设置窗口自己立刻换。
      await settings.waitForFunction(
        () => document.documentElement.dataset.theme === 'ink'
          && document.documentElement.dataset.scheme === 'dark',
        null,
        { timeout: 10000 }
      );

      // 面板（另一个窗口）也得跟着换：主进程把主题广播给所有窗口。
      await pet.evaluate(() => window.pet.openPanel?.());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板没有出现').not.toBeNull();

      await panel.waitForFunction(
        () => document.documentElement.dataset.theme === 'ink'
          && document.documentElement.dataset.scheme === 'dark',
        null,
        { timeout: 10000 }
      );
      const cardBg = await panel.evaluate(
        () => getComputedStyle(document.getElementById('panel')).backgroundColor
      );
      expect(cardBg).toBe('rgb(23, 24, 27)');

      // 插件自己的页面（在 iframe 里，是另一个文档）也得跟上。
      await panel.fill('#query', '剪贴板');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('clipboard'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("剪贴板")');
      const frame = panel.frameLocator('#plugin-frame');
      await expect(frame.locator('html')).toHaveAttribute('data-theme', 'ink');
      await expect(frame.locator('html')).toHaveAttribute('data-scheme', 'dark');
    } finally {
      await app.close();
    }
  });

  test('换主题不会把桌宠的透明底涂掉', async () => {
    const { app, pet } = await launch();
    try {
      const readPetBg = () => app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/src/renderer/index.html'));
        // 透明窗口的 getBackgroundColor 会把 alpha 去掉，剩 #000000；
        // 一旦被涂上不透明的颜色，就不是这个值了。
        return win?.getBackgroundColor() ?? null;
      });

      expect(await readPetBg(), '桌宠窗口一开始就不是透明的').toBe('#000000');

      await pet.evaluate(() => window.pet.openSettings?.());
      const settings = await findWindow(app, '/settings/index.html');
      expect(settings, '设置窗口没有出现').not.toBeNull();
      await settings.locator('#tab-appearance').click();
      await settings.locator('input[name="mode"][value="dark"]').check();
      await settings.waitForFunction(
        () => document.documentElement.dataset.scheme === 'dark',
        null,
        { timeout: 10000 }
      );

      expect(await readPetBg(), '换主题后桌宠的底被涂掉了').toBe('#000000');
    } finally {
      await app.close();
    }
  });
});
