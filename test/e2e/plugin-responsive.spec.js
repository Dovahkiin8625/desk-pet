// 宽版与窄版：同一个插件，在面板里与在独立窗口里是两种形态。
//
// 宽窄由**可用宽度**决定（断点 560px）：
// - 面板窄（420 宽）→ 永远是窄版；
// - 独立窗口宽（默认 640～860）→ 宽版：配置项排成两列，条目仍是单列；
// - 用户把窗口拖到 560 以下 → 退回窄版。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-responsive');

async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
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

/** 打开面板。 */
async function openPanel(app, pet) {
  await pet.evaluate(() => window.pet.openPanel?.());
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      try {
        if (win.url().includes('/renderer/panel/index.html')) {
          await win.waitForLoadState('domcontentloaded');
          return win;
        }
      } catch {
        /* 忽略 */
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('面板没有出现');
}

test.describe('宽版与窄版', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('列表是单列：面板里与独立窗口里都是一列', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("待办")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });

      // 待办是空的时画的是「空态」块，没有列表——先加一条，列表才在。
      await panel.fill('#plugin-body input[type="text"]', '写测试');
      await panel.press('#plugin-body input[type="text"]', 'Enter');
      await panel.waitForFunction(() => document.querySelector('.block-list'), null, { timeout: 10000 });

      // 面板里：单列。
      const inPanel = await panel.evaluate(() => {
        const list = document.querySelector('.block-list');
        return list ? getComputedStyle(list).columnCount : 'none';
      });
      expect(inPanel).toBe('auto');

      // 独立窗口：也是单列。
      await panel.click('#detach');
      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(win, '待办的独立窗口没有出现').not.toBeNull();
      await win.waitForLoadState('domcontentloaded');
      await win.waitForFunction(() => document.querySelector('.block-list'), null, { timeout: 10000 });
      const inWindow = await win.evaluate(
        () => getComputedStyle(document.querySelector('.block-list')).columnCount
      );
      expect(inWindow, '独立窗口里的列表该是单列').toBe('auto');
    } finally {
      await app.close();
    }
  });

  test('单列是真的单列：条目上下排，不并排', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("待办")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });
      for (const text of ['写测试', '给窗子换个尺寸']) {
        await panel.fill('#plugin-body input[type="text"]', text);
        await panel.press('#plugin-body input[type="text"]', 'Enter');
        await new Promise((r) => setTimeout(r, 300));
      }

      await panel.click('#detach');
      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      await win.waitForLoadState('domcontentloaded');
      await win.waitForFunction(
        () => document.querySelectorAll('.block-list li').length >= 2,
        null,
        { timeout: 10000 }
      );
      // 两条的横向位置一样——只验计算样式不够。
      const offsets = await win.evaluate(() =>
        Array.from(document.querySelectorAll('.block-list li')).map((li) => li.offsetLeft)
      );
      expect(offsets.length).toBeGreaterThanOrEqual(2);
      expect(offsets[0]).toBe(offsets[1]);
    } finally {
      await app.close();
    }
  });

  test('配置项在抽屉里：标签一行、控件一行（别把标签挤没了）', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'fanqie');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('pomodoro'), null, {
        timeout: 10000,
      });
      await panel.click('#results li[data-plugin-id="pomodoro"]');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'pomodoro', null, {
        timeout: 10000,
      });

      await panel.click('#detach');
      const win = await findWindow(app, '/renderer/plugin-window/index.html');
      await win.waitForLoadState('domcontentloaded');
      await win.waitForFunction(() => document.querySelector('.block-settings .config-row'), null, {
        timeout: 10000,
      });
      // 配置项在右边的抽屉里，不在正文里。
      const inDrawer = await win.evaluate(
        () => Boolean(document.querySelector('.dp-drawer-body .block-settings .config-row'))
      );
      expect(inDrawer, '配置项该在抽屉里').toBe(true);
      const direction = await win.evaluate(
        () => getComputedStyle(document.querySelector('.block-settings .config-row')).flexDirection
      );
      expect(direction).toBe('column');
    } finally {
      await app.close();
    }
  });

  // 自带页面的插件：窄版是默认（面板里、小部件里），宽版在媒体查询里。
  // 宽版换的是**版面**（左右两栏），条目本身始终单列。
  const WIDE_CASES = [
    { id: 'music-player', query: 'yinyue', sel: '#body' },
    { id: 'tasks', query: 'houtai', sel: '#overview' },
  ];
  const SINGLE_CASES = [
    { id: 'chat-history', query: 'jl', sel: '#list' },
    { id: 'clipboard', query: 'jiban', sel: '.clip-list' },
  ];

  test('插件自带页面：独立窗口里是宽版（两栏），面板里是窄版', async () => {
    const { app, pet } = await launch();
    try {
      for (const c of WIDE_CASES) {
        const panel = await openPanel(app, pet);
        await panel.fill('#query', c.query);
        await panel.waitForFunction((id) => window.__panel?.resultIds?.includes(id), c.id, {
          timeout: 10000,
        });
        await panel.click(`#results li[data-plugin-id="${c.id}"]`);

        // 面板里：窄版（不是网格）。
        await panel.waitForFunction(
          (sel) => {
            const doc = document.getElementById('plugin-frame')?.contentDocument;
            return Boolean(doc?.querySelector(sel));
          },
          c.sel,
          { timeout: 10000 }
        );
        const narrow = await panel.evaluate((sel) => {
          const doc = document.getElementById('plugin-frame')?.contentDocument;
          const el = doc?.querySelector(sel);
          return el ? getComputedStyle(el).gridTemplateColumns : 'none';
        }, c.sel);
        expect(narrow, `${c.id} 在面板里不该是两栏`).toBe('none');

        // 独立窗口里：宽版（两栏）。
        await panel.click('#detach');
        const win = await findWindow(app, '/renderer/plugin-window/index.html');
        expect(win, `${c.id} 的独立窗口没有出现`).not.toBeNull();
        await win.waitForLoadState('domcontentloaded');
        const frame = win.frameLocator('#plugin-frame');
        // 空列表高度是 0，Playwright 会当成「不可见」——只等它挂上。
        await frame.locator(c.sel).first().waitFor({ state: 'attached', timeout: 10000 });
        const wide = await frame
          .locator(c.sel)
          .first()
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
        expect(wide.split(' ').length, `${c.id} 在独立窗口里不是两栏`).toBe(2);

        // 拖窄到 560 以下：插件自己的页面也退回窄版。
        await app.evaluate(({ BrowserWindow }) => {
          const w = BrowserWindow.getAllWindows().find((x) =>
            x.getURL().includes('/renderer/plugin-window/index.html')
          );
          w.setSize(500, 500);
        });
        await new Promise((r) => setTimeout(r, 400));
        const narrowAgain = await frame
          .locator(c.sel)
          .first()
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
        expect(narrowAgain.split(' ').length, `${c.id} 拖窄后没退回窄版`).toBe(1);

        await win.click('#close');
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      await app.close();
    }
  });

  test('插件自带页面：条目单列（聊天记录、剪贴板），面板与独立窗口一样', async () => {
    const { app, pet } = await launch();
    try {
      for (const c of SINGLE_CASES) {
        const panel = await openPanel(app, pet);
        await panel.fill('#query', c.query);
        await panel.waitForFunction((id) => window.__panel?.resultIds?.includes(id), c.id, {
          timeout: 10000,
        });
        await panel.click(`#results li[data-plugin-id="${c.id}"]`);

        // 面板里：条目竖着排一列。
        await panel.waitForFunction(
          (sel) => {
            const doc = document.getElementById('plugin-frame')?.contentDocument;
            return Boolean(doc?.querySelector(sel));
          },
          c.sel,
          { timeout: 10000 }
        );
        const narrow = await panel.evaluate((sel) => {
          const doc = document.getElementById('plugin-frame')?.contentDocument;
          const el = doc?.querySelector(sel);
          if (!el) return null;
          const s = getComputedStyle(el);
          return { display: s.display, direction: s.flexDirection };
        }, c.sel);
        expect(narrow?.display, `${c.id} 在面板里该是竖排`).toBe('flex');
        expect(narrow?.direction, `${c.id} 在面板里该是一列`).toBe('column');

        // 独立窗口里：还是单列。
        await panel.click('#detach');
        const win = await findWindow(app, '/renderer/plugin-window/index.html');
        expect(win, `${c.id} 的独立窗口没有出现`).not.toBeNull();
        await win.waitForLoadState('domcontentloaded');
        const frame = win.frameLocator('#plugin-frame');
        await frame.locator(c.sel).first().waitFor({ state: 'attached', timeout: 10000 });
        const wide = await frame
          .locator(c.sel)
          .first()
          .evaluate((el) => {
            const s = getComputedStyle(el);
            return { display: s.display, direction: s.flexDirection };
          });
        expect(wide.display, `${c.id} 在独立窗口里该是竖排`).toBe('flex');
        expect(wide.direction, `${c.id} 在独立窗口里该是一列`).toBe('column');

        await win.click('#close');
        await new Promise((r) => setTimeout(r, 400));
      }
    } finally {
      await app.close();
    }
  });
});
