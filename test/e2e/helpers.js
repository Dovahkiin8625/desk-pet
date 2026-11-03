import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_MAIN = join(ROOT, 'src', 'main', 'index.js');

export async function launchApp(options = {}) {
  const userDataDir = options.userDataDir || (await mkdtemp(join(tmpdir(), 'desk-pet-e2e-')));
  const app = await electron.launch({
    args: [join(ROOT, 'src', 'main', 'index.js')],
    cwd: ROOT,
    env: {
      ...process.env,
      DESK_PET_E2E: '1',
      DESK_PET_USER_DATA: userDataDir,
      ...(options.env || {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__pet && window.__pet.ready === true, null, { timeout: 30000 });
  return {
    app,
    win,
    userDataDir,
    async close() {
      await app.close();
      if (!options.userDataDir) await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * 收集渲染层的未捕获异常与 console.error。
 *
 * 全局唯一的一份实现：这套夹具曾被抄成五份（acceptance / drag /
 * interaction / settings / switch），彼此的参数签名都不一样
 * （有的返回数组、有的往传进来的 bucket 里塞），抄出来的版本迟早漂移。
 *
 * @param {import('@playwright/test').Page} page 监听对象（渲染页或设置页）
 * @param {string[]} [bucket] 收集到哪个数组里；不传就新建一个
 * @returns {string[]} 收集到的错误列表
 */
export function collectErrors(page, bucket = []) {
  page.on('pageerror', (err) => bucket.push(`pageerror: ${err?.message || err}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.push(`console.error: ${msg.text()}`);
  });
  return bucket;
}

/**
 * 拖拽起点在**窗口内**的偏移。
 *
 * 写死是有意的：点击必须落在角色身上（角色的中心大致在窗口中部偏上），
 * 而不是随便一个空白角落。改这两个数会让拖拽从「抓角色」变成「拖空气」。
 */
const DRAG_START_X = 150;
const DRAG_START_Y = 300;

/**
 * 合成指针事件的 pointerId。
 *
 * **不能是 1**：真实鼠标的 pointerId 就是 1。
 * 窗口在静止的光标底下移动时，浏览器会补发**真实**的 pointermove——
 * 它们和合成事件混在一起，拖拽控制器就会算出乱七八糟的增量
 * （角色会突然跳到屏幕角落，再也回不来）。
 * 换一个真实鼠标不会用的 id，控制器按 pointerId 一挡，就干净了。
 */
export const SYNTHETIC_POINTER_ID = 99;

/**
 * 模拟一次拖拽：按下 → 分步移动 → 松手。
 *
 * 光标沿着**屏幕**上的一条直线移动；每一步都用窗口当前的屏幕原点
 * 把光标的屏幕坐标换算成窗口内坐标（clientX/clientY）。
 *
 * 必须这样换算：真实拖拽里窗口追着光标跑，窗口内坐标的增量会被窗口
 * 自己的移动吃掉一半——写死 clientX 增量等于假装「窗口没有动过」。
 * 换算用的 window.screenX 与渲染层算增量时读的是同一个值，
 * 所以光标的屏幕位移与窗口的位移在同一个坐标系里，累加结果才精确。
 */
export const dragBy = async (win, dx, dy, steps = 5) => {
  await win.evaluate(
    async ({ dx, dy, steps, startX, startY, pointerId }) => {
      const canvas = window.__pet.stage.app.view;
      const startScreen = { x: window.screenX + startX, y: window.screenY + startY };
      const opts = (sx, sy) => ({
        clientX: sx - window.screenX,
        clientY: sy - window.screenY,
        pointerId,
        button: 0,
        bubbles: true,
      });
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts(startScreen.x, startScreen.y)));
      for (let i = 1; i <= steps; i++) {
        const sx = startScreen.x + (dx * i) / steps;
        const sy = startScreen.y + (dy * i) / steps;
        canvas.dispatchEvent(new PointerEvent('pointermove', opts(sx, sy)));
        await new Promise((r) => setTimeout(r, 30));
      }
      canvas.dispatchEvent(new PointerEvent('pointerup', opts(startScreen.x + dx, startScreen.y + dy)));
      await new Promise((r) => setTimeout(r, 400));
    },
    { dx, dy, steps, startX: DRAG_START_X, startY: DRAG_START_Y, pointerId: SYNTHETIC_POINTER_ID }
  );
};

/**
 * 桌宠窗口的 URL 片段：主进程里按它认窗口。
 *
 * **不能**用 `getAllWindows()[0]`：桌宠现在有第二个窗口（说话气泡），
 * 它一出现，「第一个窗口」就不再一定是桌宠了。
 * 按 URL 找才稳——窗口的创建顺序不该成为测试的前提。
 */
export const PET_WINDOW_URL = '/src/renderer/index.html';

/** 插件面板窗口的 URL 片段。 */
export const PANEL_URL = '/src/renderer/panel/index.html';

/**
 * 点一下桌宠（左键）。
 *
 * 走的是渲染层**真实的指针事件路径**：pointerdown → pointerup，
 * 位移为 0——所以拖拽控制器把它当成「点击」而不是「拖拽」，
 * 于是既会触发摸头反应，也会让主进程弹出插件面板。
 */
export async function tapPet(ctx) {
  await ctx.win.evaluate(async (pointerId) => {
    const canvas = window.__pet.stage.app.view;
    const b = window.__pet.model.getBounds();
    const opts = {
      clientX: b.x + b.width / 2,
      clientY: b.y + b.height * 0.15,
      pointerId,
      button: 0,
      buttons: 1,
      bubbles: true,
      cancelable: true,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    await new Promise((r) => setTimeout(r, 200));
  }, SYNTHETIC_POINTER_ID);
}

/** 宠物窗口当前的屏幕坐标。 */
export const windowPos = (ctx) =>
  ctx.app.evaluate(({ BrowserWindow }, petUrl) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(petUrl));
    if (!w) return { x: 0, y: 0 };
    const [x, y] = w.getPosition();
    return { x, y };
  }, PET_WINDOW_URL);

/**
 * 把窗口挪到主显示器工作区的左上角，给「向右下拖」腾出空间。
 *
 * 必须挪：桌宠的默认位置就是主显示器右下角，而右下角**正好压在夹紧边界上**
 * （clampToDisplays 的 maxX/maxY 就是那个点）。在那里往右下拖，
 * 每一步都会被夹回原位，窗口纹丝不动——那不是「拖不动」，
 * 而是「已经在边界上」，测不出位移。
 *
 * setPosition 是异步落到原生窗口上的（Windows），所以要等**真正请求的那个位置**
 * 生效再返回——不能等一个写死的坐标：主显示器工作区不一定从 (0,0) 开始。
 */
export const moveToTopLeft = async (ctx) => {
  const target = await ctx.app.evaluate(({ BrowserWindow, screen }, petUrl) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(petUrl));
    if (!w) return null;
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + 20;
    const y = wa.y + 20;
    w.setPosition(x, y);
    return { x, y };
  }, PET_WINDOW_URL);
  if (!target) return { x: 0, y: 0 };
  const deadline = Date.now() + 5000;
  for (;;) {
    const pos = await windowPos(ctx);
    if (pos.x === target.x && pos.y === target.y) return pos;
    if (Date.now() >= deadline) return pos;
    await new Promise((r) => setTimeout(r, 50));
  }
};

// ---------------------------------------------------------------------------
// 菜单探针
//
// 托盘菜单与角色右键菜单都由 src/main/menu.js 生成，而托盘菜单只在启动时
// 构建一次——应用起来之后就再也拿不到它的模板了。
// 所以这里用一个**临时入口**包一层：先给 Menu.buildFromTemplate 装上探针，
// 再 import 真正的主进程入口，于是菜单模板在它被构建的那一刻就被抓了下来。
//
// 探针同时把「菜单项的 click 回调」原样留着，因此测试可以**真的去点它们**：
// 显示/隐藏、设置、退出、以及「小工具」里的每一项，走的都是真实路径
// （主进程 → 助理 → 气泡），不是替身。
//
// 全仓库只有这一份实现：acceptance.spec.js 与 assistant.spec.js 共用。
// ---------------------------------------------------------------------------

function menuProbeEntrySource() {
  const mainUrl = pathToFileURL(APP_MAIN).href;
  return `
import { Menu } from 'electron';

globalThis.__menuProbe = { templates: [], popupCount: 0, mainErrors: [] };

process.on('uncaughtException', (err) => {
  globalThis.__menuProbe.mainErrors.push('uncaughtException: ' + (err?.stack || err));
});
process.on('unhandledRejection', (reason) => {
  globalThis.__menuProbe.mainErrors.push('unhandledRejection: ' + (reason?.stack || reason));
});

const originalBuild = Menu.buildFromTemplate.bind(Menu);
Menu.buildFromTemplate = (template) => {
  globalThis.__menuProbe.templates.push({
    labels: template.map((item) => item.label || item.type),
    stack: new Error().stack || '',
    template,
  });
  return originalBuild(template);
};

// 真弹窗会挡住自动化：只记次数，不真的弹。
Menu.prototype.popup = function () {
  globalThis.__menuProbe.popupCount += 1;
};

await import(${JSON.stringify(mainUrl)});
`;
}

/**
 * 用菜单探针入口启动应用。
 *
 * 与 launchApp 的唯一区别是入口脚本不同；其余（E2E 标志、userData 目录、
 * 等待渲染层 ready）保持一致。
 */
export async function launchWithMenuProbe(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-menu-'));
  const entry = join(dir, 'entry.mjs');
  await writeFile(entry, menuProbeEntrySource(), 'utf8');

  const userDataDir = options.userDataDir || join(dir, 'userData');
  const app = await electron.launch({
    args: [entry],
    cwd: ROOT,
    env: {
      ...process.env,
      DESK_PET_E2E: '1',
      DESK_PET_USER_DATA: userDataDir,
      ...(options.env || {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__pet && window.__pet.ready === true, null, { timeout: 30000 });

  return {
    app,
    win,
    userDataDir,
    /** 读探针状态（模板摘要 + 弹窗次数 + 主进程错误）。 */
    async probe() {
      return app.evaluate(() => ({
        templates: globalThis.__menuProbe.templates.map((t) => ({ labels: t.labels, stack: t.stack })),
        popupCount: globalThis.__menuProbe.popupCount,
        mainErrors: globalThis.__menuProbe.mainErrors,
      }));
    },
    /** 点菜单里的一项（按标签）。模板里保留了真实的 click 回调。 */
    async clickMenuItem(label, index = 0) {
      // 注意：主进程求值的第一个参数是 electron 模块，第二个才是传入的参数。
      return app.evaluate(
        (_electron, { label, index }) => {
          const template = globalThis.__menuProbe.templates[index]?.template;
          const item = (template || []).find((i) => i.label === label);
          if (!item) throw new Error(`菜单里没有「${label}」`);
          item.click();
        },
        { label, index }
      );
    },
    async close() {
      try {
        await app.close();
      } catch {
        /* 应用可能已经自己退出了 */
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 按路径点菜单项：path 形如 ['小工具', '待办', '添加待办…']。
 *
 * 走的是**真实**的菜单项回调（主进程 → 助理 → 气泡），
 * 不是把功能重新实现一遍——那样测的就不是应用本身了。
 */
export async function clickMenuPath(ctx, path, index = -1) {
  return ctx.app.evaluate(
    (_electron, { path, index }) => {
      const templates = globalThis.__menuProbe.templates;
      const template = index >= 0 ? templates[index]?.template : templates[templates.length - 1]?.template;
      let items = template || [];
      let item = null;
      for (const label of path) {
        item = items.find((i) => i.label === label);
        if (!item) {
          throw new Error(
            `菜单路径「${path.join(' → ')}」在「${label}」处断了；` +
              `这一层的项是：${items.map((i) => i.label || i.type).join('、')}`
          );
        }
        items = item.submenu || [];
      }
      item.click();
      return true;
    },
    { path, index }
  );
}

/** 弹出桌宠的右键菜单（真弹窗被探针换成了计数桩）。 */
export async function openContextMenu(ctx) {
  // 托盘菜单在**启动时**就构建过一次，所以「已经有模板了」不代表右键菜单
  // 弹出来了。要等的是**模板数变多**。
  const before = (await ctx.probe()).templates.length;
  await ctx.win.evaluate(async () => {
    const canvas = window.__pet.stage.app.view;
    const b = window.__pet.model.getBounds();
    canvas.dispatchEvent(
      new MouseEvent('contextmenu', {
        clientX: b.x + b.width / 2,
        clientY: b.y + b.height * 0.15,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  // 菜单是异步弹出来的（要过一次 IPC），等它真的构建完。
  const deadline = Date.now() + 5000;
  for (;;) {
    const probe = await ctx.probe();
    if (probe.templates.length > before) return probe;
    if (Date.now() >= deadline) return probe;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * 预置一份 assistant.json 再启动应用。
 *
 * 顺序很重要：应用启动时就把状态**读进内存**了，
 * 启动之后再写文件，应用根本不知道——那条待办/提醒压根不会被加载。
 */
export async function launchWithAssistantState(state, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-state-'));
  const userDataDir = join(dir, 'userData');
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, 'assistant.json'), JSON.stringify(state), 'utf8');
  const ctx = await launchApp({ ...options, userDataDir });
  const close = ctx.close;
  ctx.close = async () => {
    await close();
    await rm(dir, { recursive: true, force: true });
  };
  return ctx;
}

/**
 * 等主进程里出现某个 URL 的窗口。
 *
 * ElectronApplication **只有** evaluate，没有 waitForFunction，
 * 所以这里自己轮询。返回窗口的可见性、点击穿透状态与边界；
 * 超时返回 null。
 */
export async function waitForWindow(ctx, urlPart, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = await ctx.app.evaluate(({ BrowserWindow }, part) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes(part));
      if (!w) return null;
      return {
        id: w.id,
        visible: w.isVisible(),
        bounds: w.getBounds(),
      };
    }, urlPart);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 找到某个 URL 对应的渲染页（Playwright 的页面对象）。 */
export function pageFor(ctx, urlPart) {
  return ctx.app.windows().find((p) => p.url().includes(urlPart));
}

/**
 * 等桌宠窗口变成可见 / 不可见。
 *
 * ElectronApplication 只有 evaluate，没有 waitForFunction，所以自己轮询。
 */
export async function waitForPetVisible(ctx, visible, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const isVisible = await ctx.app.evaluate(({ BrowserWindow }, petUrl) => {
      const w = BrowserWindow.getAllWindows().find((x) =>
        x.webContents.getURL().includes(petUrl)
      );
      return w ? w.isVisible() : null;
    }, PET_WINDOW_URL);
    if (isVisible === visible) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * 切到设置窗口的某个分区。
 *
 * 设置窗口是「左侧目录 + 一次只显示一节」：不在当前分区里的控件
 * 是 display:none 的，而 Playwright 的 waitForSelector / click 默认
 * 要求元素**可见**——所以每条要碰某个分区控件的用例都得先切过去。
 *
 * 点击的处理函数是同步的，切完 DOM 就已经更新，因此不必额外等待；
 * 但仍要确认面板真的可见，失败时给出的信息也更明确。
 *
 * @param {import('@playwright/test').Page} page 设置窗口的页面对象
 * @param {'appearance'|'assistant'|'voice'|'chat'|'memory'} key 分区 key
 */
export async function gotoSection(page, key) {
  await page.locator(`#nav .nav-tab[data-section="${key}"]`).click();
  await page.waitForSelector(`#panel-${key}`, { state: 'visible', timeout: 10000 });
}

