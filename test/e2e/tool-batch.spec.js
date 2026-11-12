// 「工具」页批量管理的端到端验证。
//
// 钉四件事：
//   1. 每个工具左边有选择框，页面上有「全选」；
//   2. 勾上几个之后能**批量关闭 / 批量开启**，而且落盘；
//   3. 能**批量设审批等级**（以后不问 / 每次询问）；
//   4. 没选工具时批量按钮是灰的——点了没反应比点了报错好。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-tool-batch');

/** 摆一份助理状态：agent 的默认设置（工具都开着、都没永久放行）。 */
async function writeAssistantState(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        llm: { enabled: false },
        agent: { approval: { policy: 'graded', allowAlways: [] }, tools: { disabled: [] } },
      },
      null,
      2
    )
  );
}

/** 启动桌宠。 */
async function launch(userData = USER_DATA) {
  return electron.launch({
    args: [ROOT],
    env: { ...process.env, DESK_PET_USER_DATA: userData, DESK_PET_E2E: '1' },
  });
}

/** 在所有窗口里按 URL 找某一个。 */
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

/** 等某个条件成立。 */
async function waitUntil(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** 从磁盘上读回助理状态。 */
async function readStoredState(dir) {
  return JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}'));
}

/** 打开设置窗口并切到「对话 → 工具」。 */
async function openToolsPage(app) {
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  await settings.click('#tab-chat');
  await settings.waitForSelector('#panel-chat:not([hidden])', { timeout: 10000 });
  await settings.click('#chat-tab-tools');
  await settings.waitForSelector('#chat-sub-tools:not([hidden])', { timeout: 10000 });
  // 工具清单是异步拉来的：等第一行出现再动。
  await settings.waitForSelector('#toolGroups li[data-tool-name]', { timeout: 10000 });
  return settings;
}

test.describe('工具页的批量管理', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('每个工具左边有选择框，页面上有「全选」', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openToolsPage(app);

      // 全选在页面上。
      await expect(settings.locator('#toolSelectAll')).toHaveCount(1);

      // 每个工具行左边都有一个选择框。
      const rows = settings.locator('#toolGroups li[data-tool-name]');
      const count = await rows.count();
      expect(count, '工具清单是空的').toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        await expect(rows.nth(i).locator('.tool-select'), '有一行没有选择框').toHaveCount(1);
      }

      // 没选工具时批量按钮是灰的。
      await expect(settings.locator('#toolBatchEnable')).toBeDisabled();
      await expect(settings.locator('#toolBatchDisable')).toBeDisabled();
      await expect(settings.locator('#toolBatchApproval')).toBeDisabled();
    } finally {
      await app.close();
    }
  });

  test('勾上工具能批量关闭、批量开启，并落盘', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openToolsPage(app);

      // 勾上两个工具。
      for (const name of ['fs.read', 'fs.write']) {
        await settings.locator(`#toolGroups li[data-tool-name="${name}"] .tool-select`).check();
      }
      await expect(settings.locator('#toolSelectedCount')).toContainText('已选 2 个');
      await expect(settings.locator('#toolBatchDisable')).toBeEnabled();

      // 批量关闭。
      await settings.click('#toolBatchDisable');
      const closed = await waitUntil(async () => {
        const s = await readStoredState(USER_DATA);
        const disabled = s?.agent?.tools?.disabled || [];
        return disabled.includes('fs.read') && disabled.includes('fs.write') ? s : null;
      });
      expect(closed, '批量关闭没有落盘').toBeTruthy();

      // 界面上那两行压暗了。
      await expect(
        settings.locator('#toolGroups li[data-tool-name="fs.write"]')
      ).toHaveClass(/off/);

      // 批量开启：又都回来了。
      await settings.click('#toolBatchEnable');
      const opened = await waitUntil(async () => {
        const s = await readStoredState(USER_DATA);
        return (s?.agent?.tools?.disabled || []).length === 0 ? s : null;
      });
      expect(opened, '批量开启没有落盘').toBeTruthy();
      await expect(
        settings.locator('#toolGroups li[data-tool-name="fs.write"]')
      ).not.toHaveClass(/off/);
    } finally {
      await app.close();
    }
  });

  test('勾上工具能批量设审批等级，并落盘', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openToolsPage(app);

      await settings.locator('#toolGroups li[data-tool-name="fs.write"] .tool-select').check();
      await expect(settings.locator('#toolSelectedCount')).toContainText('已选 1 个');

      // 设成「以后不问」。
      await settings.selectOption('#toolBatchApproval', 'always');
      const always = await waitUntil(async () => {
        const s = await readStoredState(USER_DATA);
        return s?.agent?.approval?.allowAlways?.includes('fs.write') ? s : null;
      });
      expect(always, '批量设「以后不问」没有落盘').toBeTruthy();

      // 改回「每次询问」。
      await settings.selectOption('#toolBatchApproval', 'ask');
      const ask = await waitUntil(async () => {
        const s = await readStoredState(USER_DATA);
        return (s?.agent?.approval?.allowAlways || []).length === 0 ? s : null;
      });
      expect(ask, '批量设「每次询问」没有落盘').toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test('「全选」选的是当前筛选下看得见的那些工具', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openToolsPage(app);

      const rows = settings.locator('#toolGroups li[data-tool-name]');
      const total = await rows.count();
      expect(total, '工具清单是空的').toBeGreaterThan(1);

      // 全选：每个看得见的工具都被选上。
      await settings.check('#toolSelectAll');
      const picked = await settings.$$eval('#toolGroups li[data-tool-name] .tool-select', (list) =>
        list.filter((el) => el.checked).length
      );
      expect(picked, '全选没把看得见的工具都选上').toBe(total);

      // 取消全选：一个都不剩。
      await settings.uncheck('#toolSelectAll');
      const left = await settings.$$eval('#toolGroups li[data-tool-name] .tool-select', (list) =>
        list.filter((el) => el.checked).length
      );
      expect(left, '取消全选后还有选中的').toBe(0);
      await expect(settings.locator('#toolBatchEnable')).toBeDisabled();
    } finally {
      await app.close();
    }
  });
});
