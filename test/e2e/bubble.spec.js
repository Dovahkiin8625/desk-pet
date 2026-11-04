// 桌宠气泡的端到端验证。
//
// 气泡是**透明**窗口：影子与小尾巴都画在气泡盒子的外面，
// 靠窗口四周那一圈留白（body 的内边距）撑着。
// 窗口是按内容尺寸开出来的——留白算少了，气泡就会被窗口边切掉：
// 小尾巴少一截、影子被削平。桌面小部件与插件面板踩过同样的坑。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-bubble');

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
 * 在所有窗口里按 URL 找某一个。
 *
 * **不能**用 `waitForEvent('window')`：桌宠打招呼时会冒出一个气泡窗口，
 * 那个事件可能先到。
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

test.describe('桌宠气泡', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('影子与小尾巴都完整：不被窗口边切掉', async () => {
    const { app } = await launch();
    try {
      const bubble = await findWindow(app, '/renderer/bubble/index.html');
      if (!bubble) throw new Error('气泡窗口没有出现');
      await bubble.waitForLoadState('domcontentloaded');
      // 等气泡真的画出内容：空壳没有影子，也没有尾巴。
      await bubble.waitForFunction(
        () => (document.getElementById('text')?.textContent || '').length > 0,
        null,
        { timeout: 15000 },
      );
      await new Promise((r) => setTimeout(r, 500));

      const geo = await bubble.evaluate(() => {
        const el = document.getElementById('bubble');
        const tail = document.getElementById('tail');
        const r = el.getBoundingClientRect();
        const t = tail.getBoundingClientRect();
        // boxShadow 的长度依次是：x 偏移、y 偏移、模糊半径、扩散。
        const px = (getComputedStyle(el).boxShadow.match(/(-?\d+(?:\.\d+)?)px/g) || []).map(
          parseFloat
        );
        const offsetX = px[0] || 0;
        const offsetY = px[1] || 0;
        const blur = px[2] || 0;
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          bubble: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
          tail: { top: t.top, bottom: t.bottom, left: t.left, right: t.right },
          // 影子铺到哪儿：盒子往外推「下偏移 + 模糊半径」。
          shadow: {
            top: r.top + offsetY - blur,
            bottom: r.bottom + offsetY + blur,
            left: r.left + offsetX - blur,
            right: r.right + offsetX + blur,
          },
        };
      });

      // 影子整个落在窗口里：哪一边都不许被削掉。
      expect(geo.shadow.top, '影子的上沿被切了').toBeGreaterThanOrEqual(-0.5);
      expect(geo.shadow.left, '影子的左沿被切了').toBeGreaterThanOrEqual(-0.5);
      expect(geo.shadow.bottom, '影子的下沿被切了').toBeLessThanOrEqual(geo.innerHeight + 0.5);
      expect(geo.shadow.right, '影子的右沿被切了').toBeLessThanOrEqual(geo.innerWidth + 0.5);

      // 小尾巴整个落在窗口里：它是指向桌宠的那根箭头，缺一截就不好看了。
      expect(geo.tail.top, '小尾巴的上沿被切了').toBeGreaterThanOrEqual(-0.5);
      expect(geo.tail.left, '小尾巴的左沿被切了').toBeGreaterThanOrEqual(-0.5);
      expect(geo.tail.bottom, '小尾巴的下沿被切了').toBeLessThanOrEqual(geo.innerHeight + 0.5);
      expect(geo.tail.right, '小尾巴的右沿被切了').toBeLessThanOrEqual(geo.innerWidth + 0.5);
    } finally {
      await app.close();
    }
  });
});
