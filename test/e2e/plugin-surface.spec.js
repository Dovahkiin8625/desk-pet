// 插件界面（surface）的端到端验证。
//
// 覆盖三件事：
//   1. **每个插件**都能在新窗口打开（清单里没写 window 段也算）；
//   2. 插件自带的页面在面板工作台与独立窗口里是**同一份**；
//   3. 用户自己装的插件（userData 里的）也走同一条路。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-surface');

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

/**
 * 摆一个「带自定义页面」的用户插件。
 *
 * 摆在 userData/plugins/ 下——用户自己的插件就放那儿（README「插件系统」）。
 * 它同时验证了两件事：用户插件的前缀（/__plugins__/）对不对，
 * 以及自定义页面在两处是不是同一份。
 */
async function makeUserPluginWithPage() {
  const dir = join(USER_DATA, 'plugins', 'e2e-page');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'e2e-page',
        name: '测试页面',
        icon: '🧪',
        description: '端到端测试用的插件',
        keywords: ['测试', 'ce shi', 'test', 'e2e-page'],
        entry: 'main.js',
        window: { page: 'page.html', title: '测试页面', width: 420, height: 360, refreshMs: 500 },
      },
      null,
      2
    ),
    'utf8'
  );
  await writeFile(
    join(dir, 'main.js'),
    `export default function createPlugin() {
  return {
    page() {
      return { pluginId: 'e2e-page', title: '测试页面', blocks: [] };
    },
    async data() {
      return { hello: 'from-plugin-data' };
    },
    async tick() {
      return { hello: 'from-plugin-tick' };
    },
    async act(ctx, actionId, payload) {
      if (actionId === 'ping') return { pong: payload?.from || '' };
      return null;
    },
  };
}
`,
    'utf8'
  );
  await writeFile(
    join(dir, 'page.html'),
    `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>测试页面</title></head>
  <body>
    <div id="marker">自定义页面</div>
    <button id="send" type="button">发个动作</button>
    <div id="received"></div>
    <div id="pushed"></div>
    <div id="ticked"></div>
    <script type="module">
      import { bindSurface } from '/src/renderer/ui/pluginPage.js';
      const surface = bindSurface();
      document.getElementById('send').addEventListener('click', async () => {
        const result = await surface.act('ping', { from: 'e2e' });
        document.getElementById('received').textContent = String(result?.pong || '');
      });
      // 跨帧的回调方向：主进程推来的数据要能穿过壳到达到插件页面。
      surface.onData((data) => {
        document.getElementById('pushed').textContent = String(data?.hello || '');
      });
      surface.onTick((data) => {
        document.getElementById('ticked').textContent = String(data?.hello || '');
      });
      // 插件页面把底部那行字交给壳（postMessage）。
      surface.setStatus('来自插件页面的状态');
    </script>
  </body>
</html>
`,
    'utf8'
  );
}

test.describe('插件界面（surface）', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test('每个插件都有「在新窗口打开」：清单里没写 window 段也行', async () => {
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      // 录屏的清单里没写 window 段——它以前连 ↗ 按钮都没有。
      await panel.fill('#query', 'luping');
      await panel.waitForFunction(
        () => window.__panel?.resultIds?.includes('screen-recorder'),
        null,
        { timeout: 10000 }
      );
      await panel.click('#results li:has-text("录屏")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'screen-recorder', null, {
        timeout: 10000,
      });
      await expect(panel.locator('#detach')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('插件自带的页面：面板工作台与独立窗口是同一份', async () => {
    // 面板侧那半边是 Task 7 的活（面板工作台的 iframe）。
    // Task 7 落地后把这里的 `true` 改成 `false`，这条断言就该是绿的。
    test.skip(true, '面板侧的 iframe 是 Task 7 的活');
    await makeUserPluginWithPage();
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'e2e-page');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('e2e-page'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("测试页面")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'e2e-page', null, {
        timeout: 10000,
      });

      // 面板工作台里装的是插件自己的页面。
      const frame = panel.frameLocator('#plugin-frame');
      await expect(frame.locator('#marker')).toHaveText('自定义页面');

      // 独立窗口里装的是**同一份**页面。
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');
      const winFrame = pluginWin.frameLocator('#plugin-frame');
      await expect(winFrame.locator('#marker')).toHaveText('自定义页面');

      // 用户插件的页面走的是 /__plugins__/ 前缀，不是 /plugins/。
      const src = await pluginWin.evaluate(() => {
        const el = document.querySelector('#plugin-frame');
        return el?.getAttribute('src') || '';
      });
      expect(src).toContain('/__plugins__/e2e-page/page.html');

      // 插件页面用助手把动作送到插件：iframe → 父页面 → IPC → 插件 → 回来。
      await frame.locator('#send').click();
      await expect(frame.locator('#received')).toHaveText('e2e');
    } finally {
      await app.close();
    }
  });

  test('独立窗口：插件自带的页面装在壳的 iframe 里（面板那侧是 Task 7）', async () => {
    await makeUserPluginWithPage();
    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'e2e-page');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('e2e-page'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("测试页面")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'e2e-page', null, {
        timeout: 10000,
      });

      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');

      // 壳里装的是插件自己的页面（壳的标题栏还在）。
      const winFrame = pluginWin.frameLocator('#plugin-frame');
      await expect(winFrame.locator('#marker')).toHaveText('自定义页面');
      await expect(pluginWin.locator('#head')).toBeVisible();

      // 用户插件的页面走的是 /__plugins__/ 前缀，不是 /plugins/。
      const src = await pluginWin.evaluate(() => {
        const el = document.querySelector('#plugin-frame');
        return el?.getAttribute('src') || '';
      });
      expect(src).toContain('/__plugins__/e2e-page/page.html');

      // iframe 自己的地址要带着 plugin=<id>：
      // 插件页面靠它认出「自己是谁」（见 src/renderer/ui/pluginPage.js）。
      const frameUrl = pluginWin.frames().find((f) => f.url().includes('page.html'))?.url() || '';
      expect(frameUrl).toContain('plugin=e2e-page');

      // iframe 里**没有 preload**：插件页面只能用父页面的能力（parent.plugin）。
      // 这一步走通，说明 iframe → 父页面 → IPC → 插件 → 回来整条链是通的。
      await winFrame.locator('#send').click();
      await expect(winFrame.locator('#received')).toHaveText('e2e');

      // 跨帧的**回调**方向：主进程推来的数据要能穿过壳到达到插件页面。
      // （插件页面订阅的是 parent.plugin.onData——壳的 preload 代收。）
      await expect(winFrame.locator('#pushed')).toHaveText('from-plugin-data');

      // 周期推的数据走同一条路（onTick）。
      await expect(winFrame.locator('#ticked')).toHaveText('from-plugin-tick');

      // 插件页面把底部那行字交给壳（postMessage）。
      await expect(pluginWin.locator('#status')).toHaveText('来自插件页面的状态');
    } finally {
      await app.close();
    }
  });

  test('插件自带的页面加载失败：独立窗口退回积木界面，不能白屏', async () => {
    const dir = join(USER_DATA, 'plugins', 'e2e-broken');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'e2e-broken',
        name: '坏页面',
        icon: '💥',
        description: '页面路径写错了',
        keywords: ['坏页面', 'huai', 'broken'],
        entry: 'main.js',
        window: { page: 'not-there.html', title: '坏页面', width: 380, height: 300 },
      }),
      'utf8'
    );
    await writeFile(
      join(dir, 'main.js'),
      `export default function createPlugin() {
  return {
    page() {
      return {
        pluginId: 'e2e-broken',
        title: '坏页面',
        blocks: [{ kind: 'text', text: '积木界面还在' }],
      };
    },
  };
}
`,
      'utf8'
    );

    const { app, pet } = await launch();
    try {
      const panel = await openPanel(app, pet);
      await panel.fill('#query', 'huai');
      await panel.waitForFunction(() => window.__panel?.resultIds?.includes('e2e-broken'), null, {
        timeout: 10000,
      });
      await panel.click('#results li:has-text("坏页面")');
      await panel.waitForFunction(() => window.__panel?.pluginId === 'e2e-broken', null, {
        timeout: 10000,
      });

      // 页面路径写错了 → 独立窗口里不该白屏，要退回积木界面。
      await panel.evaluate(() => document.querySelector('#detach')?.click());
      const pluginWin = await findWindow(app, '/renderer/plugin-window/index.html');
      expect(pluginWin, '插件的独立窗口没有出现').not.toBeNull();
      await pluginWin.waitForLoadState('domcontentloaded');
      await expect(pluginWin.locator('#body')).toContainText('积木界面还在');
      // 壳里不该有 iframe（页面不存在，装了也是白屏）。
      await expect(pluginWin.locator('#plugin-frame')).toBeHidden();
    } finally {
      await app.close();
    }
  });
});
