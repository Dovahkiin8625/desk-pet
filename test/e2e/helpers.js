import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    async ({ dx, dy, steps, startX, startY }) => {
      const canvas = window.__pet.stage.app.view;
      const startScreen = { x: window.screenX + startX, y: window.screenY + startY };
      const opts = (sx, sy) => ({
        clientX: sx - window.screenX,
        clientY: sy - window.screenY,
        pointerId: 1,
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
    { dx, dy, steps, startX: DRAG_START_X, startY: DRAG_START_Y }
  );
};

/** 宠物窗口当前的屏幕坐标。 */
export const windowPos = (ctx) =>
  ctx.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const [x, y] = w.getPosition();
    return { x, y };
  });

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
  const target = await ctx.app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + 20;
    const y = wa.y + 20;
    w.setPosition(x, y);
    return { x, y };
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    const pos = await windowPos(ctx);
    if (pos.x === target.x && pos.y === target.y) return pos;
    if (Date.now() >= deadline) return pos;
    await new Promise((r) => setTimeout(r, 50));
  }
};
