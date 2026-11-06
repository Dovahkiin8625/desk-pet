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
        const root = getComputedStyle(document.documentElement);
        let blocksImport = null;
        for (const sheet of document.styleSheets) {
          if (!sheet.href || !sheet.href.endsWith('/src/renderer/ui/blocks.css')) continue;
          const rule = sheet.cssRules?.[0];
          blocksImport = {
            isImport: rule?.constructor?.name === 'CSSImportRule',
            href: rule?.href || '',
          };
        }
        return {
          sheets,
          bg: root.getPropertyValue('--dp-bg').trim(),
          accent: root.getPropertyValue('--dp-accent').trim(),
          blocksImport,
        };
      });

      // 主题被加载了。
      expect(info.sheets.some((h) => h.endsWith('/src/renderer/ui/theme.css'))).toBe(true);
      // 变量解析成了预期的值。
      expect(info.bg).toBe('#fffdf8');
      expect(info.accent).toBe('#d9c9a3');
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
        const root = getComputedStyle(document.documentElement);
        const card = getComputedStyle(document.getElementById('panel'));
        /** 把 token 的十六进制转成 rgb，才好跟计算值比。 */
        const hexToRgb = (hex) => {
          const m = hex.match(/^#([0-9a-f]{6})$/i);
          if (!m) return hex;
          const n = parseInt(m[1], 16);
          return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
        };
        const token = (name) => hexToRgb(root.getPropertyValue(name).trim());
        return {
          bgToken: token('--dp-bg'),
          cardBg: card.backgroundColor,
          textToken: token('--dp-text'),
          cardColor: card.color,
        };
      });

      // 卡片底色与文字色都等于主题里的 token：
      // 改了 theme.css 的 --dp-bg，这一页得跟着变——否则就是两套配色。
      expect(info.cardBg).toBe(info.bgToken);
      expect(info.cardColor).toBe(info.textToken);
    } finally {
      await app.close();
    }
  });
});
