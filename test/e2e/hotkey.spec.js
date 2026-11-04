// 「输入框快捷键」这个设置项的端到端验证。
//
// **全局快捷键本身按不了**：Playwright 的合成按键不经过 webContents 的
// before-input-event，而那正是唯一的按键入口（见 src/main/hotkeyCapture.js）。
// 所以这里验证的是**自动化够得着的那一半**：
//   1. 设置窗口里有这一项，值从磁盘读进来；
//   2. 「录制」按钮与主进程通得上（按钮进入录制态，再点一次取消）；
//   3. 「清除」能把它抹掉，并且落盘。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-hotkey');

/** 读磁盘上的设置（写入有 300ms 防抖，调用方要轮询）。 */
async function readSettings() {
  const text = await readFile(join(USER_DATA, 'settings.json'), 'utf8').catch(() => '{}');
  return JSON.parse(text);
}

/** 等设置落盘。 */
async function waitForSettings(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate(await readSettings())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * 在磁盘上摆一份设置：已经设了一个「唤醒输入框」的组合。
 *
 * 磁盘上已经设了一个「唤醒输入框」的组合：设置窗口要把它显示出来。
 */
async function seedSettings() {
  await writeFile(
    join(USER_DATA, 'settings.json'),
    JSON.stringify({
      version: 1,
      modelId: 'haru',
      hotkey: 'Control+Shift+D',
      panelHotkey: 'Control+Shift+F',
    }),
  );
}

test.describe('输入框快捷键', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await seedSettings();
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('设置窗口里有这一项，值从磁盘读进来，录制与清除都通得上', async () => {
    const app = await electron.launch({
      args: [ROOT],
      env: {
        ...process.env,
        DESK_PET_USER_DATA: USER_DATA,
        DESK_PET_E2E: '1',
      },
    });
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      await pet.evaluate(() => window.pet.openSettings());
      const settings = await app.waitForEvent('window');
      await settings.waitForLoadState('domcontentloaded');
      // 等初始化把系统状态拉回来。
      await settings.waitForFunction(
        () => document.getElementById('panelHotkeyValue')?.value === 'Control+Shift+F',
        null,
        { timeout: 15000 },
      );

      // 「呼出/隐藏桌宠」那个还在，两个快捷键各占一行。
      await expect(settings.locator('#hotkeyValue')).toHaveValue('Control+Shift+D');
      await expect(settings.locator('#panelHotkeyValue')).toHaveValue('Control+Shift+F');

      // 切到「系统」分区。
      await settings.click('#tab-system');
      await expect(settings.locator('#panelHotkeyValue')).toBeVisible();

      // 录制：点一下进入录制态（主进程接住了），再点一下取消。
      await settings.click('#recordPanelHotkey');
      await settings.waitForFunction(
        () => document.getElementById('recordPanelHotkey')?.textContent?.includes('请按下组合键'),
        null,
        { timeout: 10000 },
      );
      await settings.click('#recordPanelHotkey');
      await settings.waitForFunction(
        () => document.getElementById('recordPanelHotkey')?.textContent?.includes('录制'),
        null,
        { timeout: 10000 },
      );

      // 清除：框里的组合没了，磁盘上也没了。
      await settings.click('#clearPanelHotkey');
      await settings.waitForFunction(
        () => document.getElementById('panelHotkeyValue')?.value === '',
        null,
        { timeout: 10000 },
      );
      expect(await waitForSettings((s) => s.panelHotkey === '')).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('按下快捷键 → 输入框被唤醒，焦点落在框里', async () => {
    // 上一个用例把设置清掉了：这一条要重新摆一份。
    await seedSettings();
    const app = await electron.launch({
      args: [ROOT],
      env: {
        ...process.env,
        DESK_PET_USER_DATA: USER_DATA,
        DESK_PET_E2E: '1',
      },
    });
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });

      // 系统级的快捷键按不了（合成按键不经过系统层），
      // 但 E2E 下回调被记下来了——「按一下」就是调它。
      await app.evaluate(() => {
        const cb = globalThis.__e2eShortcuts?.get('Control+Shift+F');
        if (!cb) throw new Error('「唤醒输入框」的快捷键没有注册');
        cb();
      });

      // 插件面板被叫出来了。
      const panel = await app.waitForEvent('window');
      await panel.waitForLoadState('domcontentloaded');
      await panel.waitForFunction(() => window.__panel?.view === 'search', null, { timeout: 15000 });

      // **焦点在输入框里**：用户可以直接开始打字。
      await panel.waitForFunction(() => document.activeElement?.id === 'query', null, {
        timeout: 10000,
      });
    } finally {
      await app.close();
    }
  });
});
