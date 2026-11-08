// 「think 模式」开关与深度的端到端验证。
//
// 用户在这里决定桌宠调大模型时要不要先想一想、以及想多深。
// 所以这里钉住三件事：
//   1. 开关关着时，深度那一栏是灰的（别让用户以为「中」正在生效）；
//   2. 开关与深度都落盘；
//   3. 磁盘上的深度认不出来时，页面上显示的是合法档位（不是磁盘上那个）。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { THINK_LEVELS } from '../../src/shared/assistant.js';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-think-mode');

/** 摆一份助理状态。 */
async function writeAssistantState(dir, llm = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
        llm: { enabled: true, backend: 'chat', ...llm },
      },
      null,
      2
    )
  );
}

/** 启动桌宠。 */
async function launch(userData) {
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
async function waitUntil(fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** 打开设置窗口，停在「对话」分区。 */
async function openChatPanel(app) {
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  await settings.click('#tab-chat');
  await settings.waitForSelector('#panel-chat:not([hidden])', { timeout: 10000 });
  return settings;
}

/** 从磁盘上读回存着的 think 设置。 */
async function readStoredThink(dir) {
  const raw = JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}'));
  return raw.llm ?? {};
}

test.describe('think 模式开关与深度', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('深度那栏的选项就是共享契约里的那一份', async () => {
    const dir = join(ROOT, '.tmp-e2e-think-mode-list');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { think: true, thinkLevel: 'high' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      const options = await settings.evaluate(() =>
        Array.from(document.getElementById('llmThinkLevel').options).map((o) => o.value)
      );
      expect(options, '深度选项和共享契约对不上').toEqual([...THINK_LEVELS]);
      // 存着哪个就选中哪个。
      expect(await settings.inputValue('#llmThinkLevel')).toBe('high');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('开关关着时深度是灰的，打开后才可选', async () => {
    const dir = join(ROOT, '.tmp-e2e-think-mode-toggle');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { think: false, thinkLevel: 'medium' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      expect(await settings.isChecked('#llmThink')).toBe(false);
      expect(await settings.isDisabled('#llmThinkLevel'), '关着时深度还能选，用户会以为它在生效').toBe(true);

      await settings.check('#llmThink');
      expect(await settings.isDisabled('#llmThinkLevel')).toBe(false);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('打开开关并选深度：落盘', async () => {
    const dir = join(ROOT, '.tmp-e2e-think-mode-pick');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { think: false, thinkLevel: 'medium' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      await settings.check('#llmThink');
      await settings.selectOption('#llmThinkLevel', 'high');

      const stored = await waitUntil(async () => {
        const llm = await readStoredThink(dir);
        return llm.think === true && llm.thinkLevel === 'high' ? llm : null;
      });
      expect(stored, 'think 设置没有落盘').toBeTruthy();
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('磁盘上的深度认不出来：退回「中」', async () => {
    const dir = join(ROOT, '.tmp-e2e-think-mode-unknown');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { think: true, thinkLevel: '胡说' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      // 主进程的状态清洗会把它退回「中」，
      // 设置页显示的必须是清洗后的值（不是磁盘上那个）。
      expect(await settings.inputValue('#llmThinkLevel')).toBe('medium');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
