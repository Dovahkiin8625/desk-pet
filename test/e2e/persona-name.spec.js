// 人设名的动态替换（默认「小桌」）。
//
// 钉两件事：
//   1. 页面上凡是原先写「桌宠」的地方，都换成人设名；
//   2. 改了人设名之后，已经打开的页面里的文字**立刻**跟着换。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-persona-name');

async function launch() {
  await mkdir(USER_DATA, { recursive: true });
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
}

async function findWindow(app, part, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(part)) return w;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('人设名：页面文字都换成人设名，改名字后立刻跟着换', async () => {
  const app = await launch();
  try {
    const pet = await app.firstWindow();
    await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
    await pet.evaluate(() => window.pet.openSettings());
    const settings = await findWindow(app, '/src/settings/index.html');
    expect(settings, '设置窗口没打开').toBeTruthy();
    await settings.waitForLoadState('domcontentloaded');

    // 1) 默认人设名：界面上不该再有一个「桌宠」，都换成「小桌」
    const bodyText = await settings.evaluate(() => document.body.textContent);
    expect(bodyText).toContain('小桌能做什么');
    expect(bodyText).toContain('点小桌时说话');
    expect(bodyText).toContain('呼出 / 隐藏小桌');
    expect(bodyText).not.toContain('桌宠');
    expect(bodyText).not.toContain('桌面宠物');
    expect(bodyText).not.toContain('{name}');

    // 2) 改人设名：settings 与面板里的文字都应立刻跟着换
    await settings.click('#tab-chat');
    await settings.click('#chat-tab-persona');
    await settings.waitForSelector('#chat-sub-persona:not([hidden])');
    await settings.fill('#llmPersonaName', '小黑');
    await settings.press('#llmPersonaName', 'Tab'); // change 事件落盘

    // 设置窗口自己的文字跟着换
    await settings.waitForFunction(
      () => document.body.textContent.includes('点小黑时说话'),
      null,
      { timeout: 10000 }
    );
    const renamed = await settings.evaluate(() => document.body.textContent);
    expect(renamed).not.toContain('桌宠');
    expect(renamed).not.toContain('小桌');

    // 面板（占位符属性也跟着换）
    await pet.evaluate(() => window.pet.openPanel());
    const panel = await findWindow(app, '/renderer/panel/index.html');
    expect(panel, '面板没打开').toBeTruthy();
    await panel.waitForLoadState('domcontentloaded');
    // 面板页加载后才异步取人设名并重新替换，等它换完
    await panel.waitForFunction(
      () => document.querySelector('#query')?.getAttribute('placeholder')?.includes('小黑'),
      null,
      { timeout: 10000 }
    );
    const placeholder = await panel.locator('#query').getAttribute('placeholder');
    expect(placeholder).toContain('跟小黑说点什么');
    expect(placeholder).not.toContain('{name}');
    expect(placeholder).not.toContain('桌宠');
  } finally {
    await app.close();
    await rm(USER_DATA, { recursive: true, force: true });
  }
});
