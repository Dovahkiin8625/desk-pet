// 「可点击区域与拖动边界由桌宠形象决定」的端到端验证。
//
// 两个现象：
//   1. 小模型往屏幕上方拖时**拖不到顶**——窗口的上半截是贴图的透明留白，
//      而主进程按**整块窗口**夹紧位置，角色因此永远差一截；
//   2. 点形象上方的透明处也会弹出输入框——点击判定用的是包围盒，
//      包围盒里也有一大片透明。
//
// 这里验证的是「按形象算」之后的行为：
//   - 形象之外的点不算点击（不弹面板、不触发反应）；
//   - 形象之内才算点击（单击摸头，双击才弹面板）；
//   - 往上拖时形象能贴到屏幕顶（窗口允许有一部分在屏幕外）。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-visible-area');

/** 启动一个干净的桌宠。 */
async function launch() {
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
}

/** 等模型上屏、轮廓量出来。 */
async function waitForPet(pet) {
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.waitForFunction(() => window.__pet?.silhouetteReady === true, null, { timeout: 30000 });
  // 再等一会儿：模型刚挂上时参数还在从「静止姿势」淡入，
  // 那段时间量到的轮廓是静止姿势的（比真正显示出来的宽一倍）。
  // 轮廓稳定下来才量得到「角色真正的样子」。
  await pet.waitForTimeout(700);
}

/**
 * 在形象里找一个**确实不透明**的点。
 *
 * 不能直接用包围盒的正中：两只手之间可能是空的。
 */
async function findSolidPoint(pet) {
  return pet.evaluate(() => {
    const r = window.__pet.contentRect;
    for (let gy = 0.1; gy <= 0.95; gy += 0.05) {
      for (let gx = 0.1; gx <= 0.95; gx += 0.05) {
        const x = r.x + r.width * gx;
        const y = r.y + r.height * gy;
        if (window.__pet.isOnFigure(x, y)) return { x, y };
      }
    }
    return null;
  });
}

/**
 * 等插件面板那个窗口出现。
 *
 * **不能**用「等任意一个新窗口」：点一下桌宠会冒出气泡窗口
 *（念台词的那一行），它可能比面板先出现。认准地址栏。
 */
async function waitForPanel(app, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const panel = app.windows().find((w) => w.url().includes('/renderer/panel/index.html'));
    if (panel) return panel;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test.describe('形象决定可点击区域与拖动边界', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('形象之外的点不算点击：输入框不弹，反应也不触发', async () => {
    const app = await launch();
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      // 画布左上角是贴图的透明留白——「形象之外」的确定样本。
      const blank = await pet.evaluate(() => ({
        x: 2,
        y: 2,
        onFigure: window.__pet.isOnFigure(2, 2),
      }));
      expect(blank.onFigure).toBe(false);

      await pet.mouse.click(blank.x, blank.y);
      await pet.waitForTimeout(800);

      // 没有命中任何语义区（摸头/身体），也没有弹出插件面板。
      expect(await pet.evaluate(() => window.__pet.lastZone)).toBeNull();
      expect(app.windows().length).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('形象上的点照常响应：单击摸头，双击才弹出插件面板', async () => {
    const app = await launch();
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      const solid = await findSolidPoint(pet);
      expect(solid).toBeTruthy();

      // **单击**：摸头，但不弹面板（输入框是双击才弹的）。
      await pet.mouse.click(solid.x, solid.y);
      await pet.waitForFunction(() => window.__pet.lastZone !== null, null, { timeout: 10000 });
      await pet.waitForTimeout(600);
      // 认准面板那个窗口：单击可能冒出气泡窗口（念台词的那一行）。
      expect(await waitForPanel(app, 300), '单击不该弹出插件面板').toBeNull();

      // **双击**：插件面板（带搜索框的那个窗口）被叫出来了。
      await pet.mouse.dblclick(solid.x, solid.y);
      const panel = await waitForPanel(app);
      expect(panel, '双击桌宠应该弹出插件面板').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');
      expect(await pet.evaluate(() => window.__pet.doubleTaps)).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  test('光标在形象外时，窗口不吃鼠标事件（透明处让开点击）', async () => {
    const app = await launch();
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      // 光标移到形象之外的透明留白上。
      await pet.mouse.move(2, 2);
      await pet.waitForFunction(() => window.__pet.clickThrough === true, null, { timeout: 10000 });
      // 主进程那边确实把窗口设成了「不吃鼠标事件」——
      // 点击于是落到桌面上，而不是被桌宠窗口吃掉。
      const state = await pet.evaluate(() => window.pet.getSystemState());
      expect(state.pixelClickThrough).toBe(true);

      // 移回形象上 → 恢复可点（桌宠必须还能被点、被拖）。
      const solid = await findSolidPoint(pet);
      await pet.mouse.move(solid.x, solid.y);
      await pet.waitForFunction(() => window.__pet.clickThrough === false, null, { timeout: 10000 });
      const state2 = await pet.evaluate(() => window.pet.getSystemState());
      expect(state2.pixelClickThrough).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('往上拖能贴到屏幕顶：按形象算，不按窗口算', async () => {
    const app = await launch();
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      const rect = await pet.evaluate(() => window.__pet.contentRect);
      const before = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const [x, y] = win.getPosition();
        const [w, h] = win.getSize();
        return { x, y, w, h };
      });

      // 形象比窗口矮：窗口上半截是空的（这正是「拖不到顶」的成因）。
      expect(rect.height).toBeLessThan(before.h);

      // 模拟「一直往上拖」：渲染层把增量递给主进程，主进程负责夹紧。
      // 走的是拖拽用的那条 IPC，夹紧逻辑与真拖一模一样。
      for (let i = 0; i < 20; i++) {
        await pet.evaluate(() => window.pet.moveWindowBy(0, -100));
        await pet.waitForTimeout(20);
      }

      const after = await app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const [x, y] = win.getPosition();
        const wa = screen.getPrimaryDisplay().workArea;
        return { x, y, workTop: wa.y, workLeft: wa.x };
      });

      // 形象本身完整留在屏幕里，而且**贴着顶**（不再差一截）。
      const figureTop = after.y + rect.y;
      expect(Math.abs(figureTop - after.workTop)).toBeLessThan(4);
      // 窗口的上半截（透明留白）在屏幕外——旧行为下窗口必须整个留在屏幕内，
      // 角色因此永远差一截才贴得到边。
      expect(after.y).toBeLessThan(after.workTop);
    } finally {
      await app.close();
    }
  });
});
