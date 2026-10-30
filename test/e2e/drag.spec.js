import { test, expect } from '@playwright/test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers.js';

/**
 * 收集渲染层的未捕获异常与 console.error。
 * 与 interaction.spec.js 同款：拖拽是本次新增的代码路径，
 * 「渲染进程不得产生未捕获错误」必须在这里被断言。
 */
function collectErrors(win) {
  const errors = [];
  win.on('pageerror', (err) => errors.push(`pageerror: ${err?.message || err}`));
  win.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

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
const dragBy = async (win, dx, dy, steps = 5) => {
  await win.evaluate(
    async ({ dx, dy, steps }) => {
      const canvas = window.__pet.stage.app.view;
      const startScreen = { x: window.screenX + 150, y: window.screenY + 300 };
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
    { dx, dy, steps }
  );
};

/**
 * 一次**不松手**的连续拖拽：沿着一串偏移量移动光标，中途不抬起指针。
 *
 * offsets 是相对**按下点**的屏幕位移（像素）。光标的屏幕位置按窗口当前的
 * 屏幕原点换算成 clientX/clientY，所以拖到屏幕边缘时路径依然精确。
 *
 * 返回渲染层观察到的窗口屏幕位置轨迹：用来断言「窗口确实被钉在边缘上过」。
 */
const dragAlong = async (win, offsets) => {
  return win.evaluate(async (offsets) => {
    const canvas = window.__pet.stage.app.view;
    const start = { x: window.screenX + 150, y: window.screenY + 84 };
    const opts = (sx, sy) => ({
      clientX: sx - window.screenX,
      clientY: sy - window.screenY,
      pointerId: 1,
      button: 0,
      bubbles: true,
    });
    const trace = [];
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts(start.x, start.y)));
    for (const o of offsets) {
      canvas.dispatchEvent(new PointerEvent('pointermove', opts(start.x + o.x, start.y + o.y)));
      await new Promise((r) => setTimeout(r, 30));
      trace.push({ screenX: window.screenX, screenY: window.screenY });
    }
    const last = offsets[offsets.length - 1];
    canvas.dispatchEvent(new PointerEvent('pointerup', opts(start.x + last.x, start.y + last.y)));
    await new Promise((r) => setTimeout(r, 400));
    return trace;
  }, offsets);
};

const windowPos = (ctx) =>
  ctx.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const [x, y] = w.getPosition();
    return { x, y };
  });

/**
 * 读取主进程落盘的 settings.json。
 *
 * 文件在**测试进程**里读：Playwright 的 app.evaluate 求值上下文既没有 require，
 * 也没有可用的动态 import（`import()` 会抛 "A dynamic import callback was not specified"），
 * 所以读文件这件事没法在主进程里做。目录仍然取自主进程自己的 app.getPath('userData')，
 * 保证读到的是应用真正在用的那个目录。
 */
const readSettings = async (ctx) => {
  const userDataDir = await ctx.app.evaluate(({ app }) => app.getPath('userData'));
  const text = await readFile(join(userDataDir, 'settings.json'), 'utf8');
  return JSON.parse(text);
};

/**
 * 轮询读取 settings.json：persist() 有 300ms 防抖，
 * 文件不一定在拖拽结束的同一刻就已经落盘。
 */
const waitForSettings = async (ctx, predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      last = await readSettings(ctx);
      if (predicate(last)) return last;
    } catch (err) {
      last = { error: String(err?.message || err) };
    }
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
};

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
const moveToTopLeft = async (ctx) => {
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

test('拖拽角色会移动窗口并记住位置', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    // 先挪到工作区左上角：默认位置压在夹紧边界上，往右下拖是拖不动的。
    const before = await moveToTopLeft(ctx);
    await dragBy(ctx.win, 120, 60);
    const after = await windowPos(ctx);

    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);

    // 位移应当正好等于光标的屏幕位移：增量是逐段累加的，
    // 少一段窗口就跟光标脱节，多一段就会跑在光标前面。
    // 留 1px 容差：中间隔着一次 IPC 往返和一次原生窗口移动，
    // 任何一处的取整都可能带来 1px 误差。
    expect(Math.abs(after.x - before.x - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y - 60)).toBeLessThanOrEqual(1);

    const saved = await waitForSettings(ctx, (s) => !!s?.position);
    expect(saved.position).toBeTruthy();
    expect(typeof saved.position.x).toBe('number');
    expect(typeof saved.position.y).toBe('number');
    // 存下来的位置就是窗口现在的位置（saveSettings 会取整，容忍 1px）。
    expect(Math.abs(saved.position.x - after.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(saved.position.y - after.y)).toBeLessThanOrEqual(1);

    // 渲染层记录的增量确实被送出去了。
    const lastDelta = await ctx.win.evaluate(() => window.__pet.lastDragDelta);
    expect(lastDelta).toBeTruthy();
    expect(lastDelta.deltaX).toBeGreaterThan(0);
    expect(lastDelta.deltaY).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('真实指针拖拽时角色紧跟光标，不落后也不超前', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    await moveToTopLeft(ctx);
    const before = await windowPos(ctx);

    // 起点取角色头部所在的视口坐标
    const startViewport = await ctx.win.evaluate(() => {
      const b = window.__pet.model.getBounds();
      return { x: b.x + b.width / 2, y: b.y + b.height * 0.15 };
    });
    const origin = await windowPos(ctx);
    const screenStart = { x: origin.x + startViewport.x, y: origin.y + startViewport.y };

    const DX = 120;
    const DY = 60;
    const STEPS = 10;

    // 真实指针事件（受信任的）：走的是「光标在屏幕上动，窗口追着跑」这条路，
    // 而不是脚本写死窗口内坐标——后者测不出窗口与光标是否脱节。
    // CDP 只接受整数坐标，所以这里要取整。
    await ctx.win.mouse.move(Math.round(startViewport.x), Math.round(startViewport.y));
    await ctx.win.mouse.down();
    for (let i = 1; i <= STEPS; i++) {
      const target = {
        x: screenStart.x + (DX * i) / STEPS,
        y: screenStart.y + (DY * i) / STEPS,
      };
      // 窗口在拖拽途中会移动，所以每一步都要用**当前**的窗口原点
      // 把光标的屏幕坐标换算回视口坐标。
      const o = await windowPos(ctx);
      await ctx.win.mouse.move(Math.round(target.x - o.x), Math.round(target.y - o.y));
      await new Promise((r) => setTimeout(r, 40));
    }
    await ctx.win.mouse.up();
    await new Promise((r) => setTimeout(r, 400));

    const after = await windowPos(ctx);
    const movedX = after.x - before.x;
    const movedY = after.y - before.y;

    // 角色必须跟着光标走：不能落后（漏掉增量），也不能超前（重复累加）。
    // 容差 25%：查询窗口位置与事件派发之间有一帧的误差，
    // 但「只走了一半」这种级别的偏差仍然会被抓住。
    expect(movedX, '角色应紧跟光标，不能落后').toBeGreaterThan(DX * 0.75);
    expect(movedX, '角色应紧跟光标，不能超前').toBeLessThan(DX * 1.25);
    expect(movedY, '角色应紧跟光标，不能落后').toBeGreaterThan(DY * 0.75);
    expect(movedY, '角色应紧跟光标，不能超前').toBeLessThan(DY * 1.25);

    // 拖拽松手不产生点击反应。
    expect(await ctx.win.evaluate(() => window.__pet.lastZone)).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('拖到屏幕边缘被夹住后，光标往回走时角色回到光标下而不是跳到相反的边缘', async () => {
  const ctx = await launchApp();
  const errors = collectErrors(ctx.win);
  try {
    const before = await moveToTopLeft(ctx);

    // 工作区与窗口尺寸：往下拖多远才能顶到下边缘。
    const geom = await ctx.app.evaluate(({ BrowserWindow, screen }) => {
      const wa = screen.getPrimaryDisplay().workArea;
      const w = BrowserWindow.getAllWindows()[0];
      const [ww, wh] = w.getSize();
      return { wa, ww, wh };
    });
    const maxY = geom.wa.y + geom.wa.height - geom.wh;
    // 越过下边缘 200px，确保窗口确实被钉在边缘上。
    const step = Math.ceil((maxY - before.y + 200) / 6);

    // 一次不松手的拖拽：先一路往下顶到边缘，再原路拉回来。
    const offsets = [];
    for (let i = 1; i <= 6; i++) offsets.push({ x: 0, y: step * i });
    for (let i = 5; i >= 0; i--) offsets.push({ x: 0, y: step * i });
    const trace = await dragAlong(ctx.win, offsets);

    // 拖拽途中窗口确实被钉在了下边缘上。
    const pinned = Math.max(...trace.map((t) => t.screenY));
    expect(pinned, '拖到底时窗口应被夹在下边缘').toBeGreaterThan(maxY - 2);
    expect(pinned, '拖到底时窗口应被夹在下边缘').toBeLessThanOrEqual(maxY + 2);

    const after = await windowPos(ctx);

    // 光标回到起点后，窗口必须回到光标下面（≈ 起点位置）。
    // 若增量被累加到「已夹紧」的位置上，被边缘吃掉的增量就永久丢失，
    // 返回的增量会从钉住的位置全额施加——角色会跳到相反的边缘并停在那里。
    expect(Math.abs(after.y - before.y), '角色应回到光标下，而不是跳到相反的边缘').toBeLessThanOrEqual(2);
    expect(Math.abs(after.x - before.x), '横向不应漂移').toBeLessThanOrEqual(2);
    // 明确排除「跳到上边缘」这个回归形态。
    expect(after.y, '角色不应被丢到上边缘').toBeGreaterThan(geom.wa.y);

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('保存的位置所在显示器已不可用时，启动回落到主显示器右下角', async () => {
  // 模拟「上次所在的那块屏幕被拔掉了」：写一个落在所有显示器之外的位置。
  const userDataDir = await mkdtemp(join(tmpdir(), 'desk-pet-fallback-'));
  await writeFile(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      version: 1,
      position: { x: 99999, y: 99999 },
      modelId: 'haru',
      scale: 1,
      opacity: 1,
      visible: true,
    }),
    'utf8'
  );

  const ctx = await launchApp({ userDataDir });
  const errors = collectErrors(ctx.win);
  try {
    const pos = await windowPos(ctx);
    // 期望落在主显示器可见区域的右下角（display.js 的 defaultPosition）。
    const expected = await ctx.app.evaluate(({ BrowserWindow, screen }) => {
      const wa = screen.getPrimaryDisplay().workArea;
      const w = BrowserWindow.getAllWindows()[0];
      const [ww, wh] = w.getSize();
      return { x: wa.x + Math.max(0, wa.width - ww), y: wa.y + Math.max(0, wa.height - wh) };
    });
    expect(pos.x).toBe(expected.x);
    expect(pos.y).toBe(expected.y);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('重启后角色回到上次位置', async () => {
  // 显式指定并复用同一个 userData 目录，模拟重启。
  // helpers.js 在调用方传入 userDataDir 时不会删除该目录。
  const userDataDir = await mkdtemp(join(tmpdir(), 'desk-pet-persist-'));
  const first = await launchApp({ userDataDir });
  const errors = collectErrors(first.win);
  let savedPosition;
  try {
    await moveToTopLeft(first);
    await dragBy(first.win, 120, 60);
    const saved = await waitForSettings(first, (s) => !!s?.position);
    savedPosition = saved.position;
    expect(errors).toEqual([]);
  } finally {
    await first.close();
  }

  expect(savedPosition).toBeTruthy();

  const second = await launchApp({ userDataDir });
  try {
    const pos = await windowPos(second);
    // 位置应与保存值一致（落盘时取整过，窗口位置也是整数）。
    expect(pos.x).toBe(savedPosition.x);
    expect(pos.y).toBe(savedPosition.y);
  } finally {
    await second.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
