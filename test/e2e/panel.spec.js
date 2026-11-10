// 插件面板与插件窗口的端到端验证。
//
// 覆盖四件事：
//   1. 面板列出**磁盘上的**插件（插件是可插拔的，不是写死的清单）；
//   2. 输入框不只是搜索：它也能直接跟桌宠说话；
//   3. 面板的卡片四周留白放得下投影——底部的投影不会被窗口切掉；
//   4. 插件能分离成独立窗口与桌面小部件，设置窗口里能开关插件。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-panel');

/** 启动应用（E2E 模式：不抢单实例锁，用临时 userData）。 */
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

/**
 * 点一下按钮。
 *
 * **不用 Playwright 的 click**：分离插件时面板会当场收起，
 * 窗口一隐藏，click 的「命中目标」检查就没得玩了——它会一直重试到超时。
 * 直接在页面里派发 click 事件，绕开那套检查。
 */
async function clickIn(page, selector) {
  await page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`找不到 ${sel}`);
      el.click();
    }, selector)
    .catch((err) => {
      // 点的是「关闭」这类按钮时，窗口会当场就没了：
      // evaluate 的回执还没回来，页面先被销毁了——
      // 报「目标已关闭」正是我们要的结果，不算失败。
      if (!/closed|closed/i.test(err?.message || '')) throw err;
    });
}

/**
 * 在所有窗口里按 URL 找某一个。
 *
 * **不能**用 `waitForEvent('window')`：桌宠打招呼时会冒出一个气泡窗口，
 * 那个事件可能先到——等到的就不是面板了。
 */
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

test.describe('插件面板', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('面板列出磁盘上的插件，输入框既能搜也能说话', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);

      // 插件清单来自 plugins/ 目录：待办、提醒……都得在。
      const ids = await panel.evaluate(() => window.__panel.resultIds);
      expect(ids).toContain('todos');
      expect(ids).toContain('reminders');
      expect(ids).toContain('pomodoro');
      expect(ids).toContain('system');
      // 设置是**内置功能**，不是插件：
      // 它照样出现在搜索结果里，但不在 plugins/ 目录里。
      expect(ids).toContain('settings');
      // 聊天记录已经是**插件**了（以前是内置功能，id 叫 history）。
      expect(ids).toContain('chat-history');
      // 「插件管理」不是插件了：它变成了设置窗口里的一个分区。
      expect(ids).not.toContain('manager');

      // 输入框：图标与提示都要说清楚「它也能聊天」。
      await expect(panel.locator('#searchbar .icon')).toHaveText('✨');
      const placeholder = await panel.locator('#query').getAttribute('placeholder');
      expect(placeholder).toContain('搜索');
      expect(placeholder).toContain('跟桌宠说点什么');

      // 打字 → 模糊搜索出插件；搜不到时冒出「和桌宠聊天」那一项。
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.fill('#query', '在吗');
      await panel.waitForFunction(() => window.__panel?.hasChat === true, null, { timeout: 10000 });
    } finally {
      await app.close();
    }
  });

  test('卡片四周的留白放得下投影：底部的投影不会被切掉', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);

      // 取原始字符串回来自己解析：在页面里算好了再传回来，
      // 出了错只看到一个 NaN，根本看不出是哪一栏不对。
      const raw = await panel.evaluate(() => {
        const card = getComputedStyle(document.getElementById('panel'));
        const body = getComputedStyle(document.body);
        return {
          shadow: card.boxShadow,
          padTop: body.paddingTop,
          padRight: body.paddingRight,
          padBottom: body.paddingBottom,
          padLeft: body.paddingLeft,
        };
      });

      // boxShadow 的长度依次是：x 偏移、y 偏移、模糊半径、扩散。
      // 注意用 parseFloat 而不是 Number：match 返回的是「0px」这样的整段，
      // Number('0px') 是 NaN。
      const px = (raw.shadow.match(/(-?\d+(?:\.\d+)?)px/g) || []).map(parseFloat);
      const blur = px[2] ?? 0;
      const offsetY = px[1] ?? 0;
      const pad = (v) => parseFloat(v) || 0;

      expect(blur, `投影参数没读出来：${raw.shadow}`).toBeGreaterThan(0);
      // 上下左右都要放得下阴影的扩散半径——
      // 放不下的话，投影会被窗口边界切掉（底部那一截最明显）。
      expect(pad(raw.padTop)).toBeGreaterThanOrEqual(blur);
      expect(pad(raw.padLeft)).toBeGreaterThanOrEqual(blur);
      expect(pad(raw.padRight)).toBeGreaterThanOrEqual(blur);
      // 底部还要多留出阴影自己的下偏移。
      expect(pad(raw.padBottom)).toBeGreaterThanOrEqual(blur + offsetY);
    } finally {
      await app.close();
    }
  });

  test('插件视图的卡片是**完整**的：底部的圆角与投影都不被切掉', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);

      // 从输入框里打开一个插件：面板换成插件视图，卡片按内容收缩。
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("待办")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });
      // 等窗口按内容调完尺寸：不然量的是调尺寸之前的那一帧。
      //
      // 只等「高度不再变」，不预设它该变成多少——该变成多少正是这条用例在查的事。
      await panel.waitForFunction(
        () => {
          const h = window.innerHeight;
          const now = Date.now();
          if (window.__lastH !== h) {
            window.__lastH = h;
            window.__lastHAt = now;
            return false;
          }
          return now - window.__lastHAt > 300;
        },
        null,
        { timeout: 10000, polling: 100 }
      );

      const geo = await panel.evaluate(() => {
        const card = document.getElementById('panel');
        const body = document.body;
        const r = card.getBoundingClientRect();
        const br = body.getBoundingClientRect();
        const px = (getComputedStyle(card).boxShadow.match(/(-?\d+(?:\.\d+)?)px/g) || []).map(
          parseFloat
        );
        return {
          innerHeight: window.innerHeight,
          cardBottom: r.bottom,
          // body 的 overflow:hidden 在**padding box** 的下沿裁剪（这里没有边框，
          // 所以 border box 的下沿就是裁剪线）。
          clipBottom: br.bottom,
          // 影子铺到哪儿：卡片下沿 + 自己的下偏移 + 模糊半径。
          shadowBottom: r.bottom + (px[1] || 0) + (px[2] || 0),
        };
      });

      // 卡片整个落在裁剪框里：底部的圆角才不会被切成一个直角。
      expect(
        geo.cardBottom,
        `卡片下沿 ${geo.cardBottom} 超出了裁剪线 ${geo.clipBottom}`
      ).toBeLessThanOrEqual(geo.clipBottom + 0.5);
      // 影子整个落在窗口里：不会被窗口边界切掉半截。
      expect(
        geo.shadowBottom,
        `影子铺到 ${geo.shadowBottom}，超出了窗口高度 ${geo.innerHeight}`
      ).toBeLessThanOrEqual(geo.innerHeight + 0.5);
    } finally {
      await app.close();
    }
  });

  test('插件能分离成独立窗口，也能变成桌面小部件', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);

      // 打开「待办」：它的清单里写了 window 段，所以有「在新窗口打开」。
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('todos'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("待办")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'todos', null, { timeout: 10000 });
      await expect(panel.locator('#detach')).toBeVisible();

      // 分离出去：开一个独立窗口，界面与面板里的是同一份。
      await clickIn(panel, '#detach');
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      if (!pluginWin) throw new Error('插件的独立窗口没有出现');
      await pluginWin.waitForLoadState('domcontentloaded');
      await pluginWin.waitForFunction(() => document.getElementById('title')?.textContent === '待办', null, {
        timeout: 15000,
      });
      await expect(pluginWin.locator('#body .block-input input')).toBeVisible();

      // 系统状态有小部件形态：变成桌面上的小部件。
      const systemPanel = await openPanel(app, pet);
      await systemPanel.fill('#query', 'xituan');
      await systemPanel.waitForFunction(() => window.__panel?.resultIds?.includes('system'), null, {
        timeout: 10000,
      });
      await systemPanel.click('#results li:has-text("系统状态")');
      await systemPanel.waitForFunction(() => window.__panel?.pluginId === 'system', null, { timeout: 10000 });
      await expect(systemPanel.locator('#widget')).toBeVisible();

      await clickIn(systemPanel, '#widget');
      const widgetWin = await findWindow(app, 'plugins/system/widget.html');
      if (!widgetWin) throw new Error('小部件窗口没有出现');
      await widgetWin.waitForLoadState('domcontentloaded');
      // 小部件走的是插件自己的页面（widget.html），窗口是透明的。
      expect(widgetWin.url()).toContain('mode=widget');
      // 数据是宿主每秒喂一次的：等它真的显示出一个百分比。
      await widgetWin.waitForFunction(
        () => /\d+%/.test(document.getElementById('cpu-val')?.textContent || ''),
        null,
        { timeout: 15000 },
      );

      // 收掉小部件：它挂在桌面上，不该在测试结束时还开着。
      await clickIn(widgetWin, '#close');
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      await app.close();
    }
  });

  test('设置窗口里能开关插件：关掉的插件从搜索结果里消失', async () => {
    const { app, pet } = await launch();
    try {
      // 插件管理是设置窗口里的一个分区，不是插件。
      await pet.evaluate(() => window.pet.openSettings());
      const settings = await findWindow(app, '/src/settings/index.html');
      if (!settings) throw new Error('设置窗口没有出现');
      await settings.waitForLoadState('domcontentloaded');

      await settings.click('#tab-plugins');
      await settings.waitForFunction(
        () => document.querySelectorAll('#pluginList .plugin-row').length > 0,
        null,
        { timeout: 15000 },
      );
      // 清单来自磁盘：待办、提醒……都得在。
      const rows = await settings.evaluate(() =>
        [...document.querySelectorAll('#pluginList .plugin-row')].map((el) => el.dataset.pluginId)
      );
      expect(rows).toContain('todos');

      // 关掉「待办」：状态栏会说出结果——那才是真的生效了，
      // 光看勾选框不行（界面是先动的，IPC 是后到的）。
      await settings.click('#pluginList .plugin-row[data-plugin-id="todos"] input.p-enable');
      await settings.waitForFunction(
        () => (document.getElementById('status')?.textContent || '').includes('关掉了'),
        null,
        { timeout: 10000 },
      );

      // 回到面板：待办不见了。
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'daiban');
      await panel.waitForFunction(() => (window.__panel?.resultIds || []).length === 0, null, {
        timeout: 10000,
      });
      const ids = await panel.evaluate(() => window.__panel.resultIds);
      expect(ids).not.toContain('todos');

      // 收拾干净：把它开回去。
      await settings.click('#pluginList .plugin-row[data-plugin-id="todos"] input.p-enable');
      await settings.waitForFunction(
        () => (document.getElementById('status')?.textContent || '').includes('开起来了'),
        null,
        { timeout: 10000 },
      );
    } finally {
      await app.close();
    }
  });
});
