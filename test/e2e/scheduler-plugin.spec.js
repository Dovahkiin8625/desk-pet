// 定时任务插件的端到端验证。
//
// 验的是**用户在界面上真能看见的东西**：
// - 面板里能填一条定时任务并存下；
// - 存下的任务出现在列表里，标着是什么活、什么时候跑；
// - 「立即运行」真的把命令跑起来了，结果摆在条目上；
// - 设置在右边的抽屉里。
import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-scheduler');

/**
 * 启动桌宠。
 *
 * 每条用例一份自己的 userData：定时任务是**存盘**的，
 * 共用一个目录的话，前一条用例留下的任务会跑到下一条里去。
 */
async function launch(name) {
  const userData = join(USER_DATA, name);
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: userData, DESK_PET_E2E: '1' },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        if (w.url().includes(part)) return w;
      } catch {
        /* 窗口刚关掉 */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 打开面板并走到定时任务的页面。 */
async function openSchedulerPlugin(app, pet) {
  await pet.evaluate(() => window.pet.openPanel());
  const panel = await findWindow(app, '/renderer/panel/index.html');
  expect(panel, '面板窗口没有出现').toBeTruthy();
  await panel.waitForLoadState('domcontentloaded');
  await panel.fill('#query', '定时任务');
  await panel.waitForFunction(() => window.__panel?.resultIds?.includes('scheduler'), null, {
    timeout: 10000,
  });
  await panel.click('#results li:has-text("定时任务")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'scheduler', null, { timeout: 10000 });
  return panel;
}

test.describe('定时任务插件', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('面板里能加一条命令型任务', async () => {
    const { app, pet } = await launch(test.info().title);
    try {
      const panel = await openSchedulerPlugin(app, pet);
      const frame = panel.frameLocator('#plugin-frame');

      await expect(frame.locator('#fName')).toBeVisible({ timeout: 20000 });
      await frame.locator('#fName').fill('测试任务');
      await frame.locator('#fContent').fill('node -e console.log(42)');
      await frame.locator('#fSave').click();

      await expect(frame.locator('.task')).toHaveCount(1, { timeout: 10000 });
      await expect(frame.locator('.task .name')).toHaveText('测试任务');
      await expect(frame.locator('.task .badge')).toHaveText('命令');
      await expect(frame.locator('.task .meta')).toContainText('每隔 30 分钟');
    } finally {
      await app.close();
    }
  });

  test('立即运行真的把命令跑起来了', async () => {
    const { app, pet } = await launch(test.info().title);
    try {
      const panel = await openSchedulerPlugin(app, pet);
      const frame = panel.frameLocator('#plugin-frame');

      await expect(frame.locator('#fName')).toBeVisible({ timeout: 20000 });
      await frame.locator('#fName').fill('测试任务');
      await frame.locator('#fContent').fill('node -e console.log(42)');
      await frame.locator('#fSave').click();
      await expect(frame.locator('.task')).toHaveCount(1, { timeout: 10000 });

      await frame.locator('.task button[data-act="run"]').click();
      await expect(frame.locator('.task .result')).toContainText('42', { timeout: 20000 });
    } finally {
      await app.close();
    }
  });

  test('派单型任务写的是要做什么，不是命令', async () => {
    const { app, pet } = await launch(test.info().title);
    try {
      const panel = await openSchedulerPlugin(app, pet);
      const frame = panel.frameLocator('#plugin-frame');

      await expect(frame.locator('#fName')).toBeVisible({ timeout: 20000 });
      await frame.locator('#fType button[data-v="agent"]').click();
      await expect(frame.locator('#fContentLabel')).toHaveText('要做什么');
      await frame.locator('#fName').fill('整理文件');
      await frame.locator('#fContent').fill('把下载目录里一周没动过的文件挪到归档目录');
      await frame.locator('#fSched button[data-v="daily"]').click();
      await frame.locator('#fSave').click();

      await expect(frame.locator('.task')).toHaveCount(1, { timeout: 10000 });
      await expect(frame.locator('.task .badge')).toHaveText('派单');
      await expect(frame.locator('.task .meta')).toContainText('每天 09:00');
    } finally {
      await app.close();
    }
  });

  test('设置在右边的抽屉里', async () => {
    const { app, pet } = await launch(test.info().title);
    try {
      const panel = await openSchedulerPlugin(app, pet);
      const frame = panel.frameLocator('#plugin-frame');

      await expect(frame.locator('#fName')).toBeVisible({ timeout: 20000 });
      await expect(frame.locator('#notifyOnFinish')).toBeHidden();

      await frame.locator('#gearBtn').click();
      await expect(frame.locator('#notifyOnFinish')).toBeVisible({ timeout: 10000 });
      await expect(frame.locator('.dp-field').first()).toContainText('跑完告诉我一声');
      await expect(frame.locator('.dp-field').nth(1)).toContainText('命令最长跑多久');
    } finally {
      await app.close();
    }
  });

  test('抽屉里的开关存进了插件自己的配置', async () => {
    const { app, pet } = await launch(test.info().title);
    try {
      const panel = await openSchedulerPlugin(app, pet);
      const frame = panel.frameLocator('#plugin-frame');

      await expect(frame.locator('#fName')).toBeVisible({ timeout: 20000 });
      await frame.locator('#gearBtn').click();
      await expect(frame.locator('#notifyOnFinish')).toBeVisible({ timeout: 10000 });
      await frame.locator('#notifyOnFinish').uncheck();

      // 存进了宿主的 plugins.json（插件自己的配置，不在桌宠的【设置】里）。
      await expect
        .poll(async () => {
          const text = await readFile(
            join(USER_DATA, test.info().title, 'plugins.json'),
            'utf8'
          ).catch(() => '{}');
          return JSON.parse(text).config?.scheduler?.notifyOnFinish;
        }, { timeout: 10000 })
        .toBe(false);
    } finally {
      await app.close();
    }
  });
});
