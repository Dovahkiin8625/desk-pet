// 「对话后端」下拉框的端到端验证。
//
// 这个功能是 agent 运行时（L2）落到设置页上的入口：
// 用户在这里把后端从「普通对话」切到「agent 模式」，
// 桌宠下一轮对话就走多步循环（能调工具的那条路）。
//
// 所以这里钉住两件事：
//   1. 下拉框里的选项来自 shared/assistant.js 的 LLM_BACKENDS（只有一份定义）；
//   2. 选了就落盘，且**说明文字跟着换**（用户是在盲切时最需要这句提示）。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LLM_BACKENDS } from '../../src/shared/assistant.js';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-backend-select');

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

/** 从磁盘上读回存着的后端。 */
async function readStoredBackend(dir) {
  const raw = JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}'));
  return raw.llm?.backend;
}

test.describe('对话后端下拉框', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('下拉框里的选项就是共享契约里的那一份', async () => {
    const dir = join(ROOT, '.tmp-e2e-backend-select-list');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { backend: 'chat' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      const options = await settings.evaluate(() =>
        Array.from(document.getElementById('llmBackend').options).map((o) => o.value)
      );
      expect(options, '下拉框里的后端和共享契约对不上').toEqual([...LLM_BACKENDS]);
      // 存着哪个就选中哪个。
      expect(await settings.inputValue('#llmBackend')).toBe('chat');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('切到 agent 模式：落盘，且说明跟着换', async () => {
    const dir = join(ROOT, '.tmp-e2e-backend-select-pick');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { backend: 'chat' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      const before = await settings.textContent('#llmBackendHint');
      await settings.selectOption('#llmBackend', 'agent');

      const stored = await waitUntil(async () => {
        const b = await readStoredBackend(dir);
        return b === 'agent' ? b : null;
      });
      expect(stored, '选中的后端没有落盘').toBeTruthy();

      // 说明文字得跟着换：用户是在盲切，说明是他唯一的提示。
      const after = await settings.textContent('#llmBackendHint');
      expect(after, '说明没有跟着换').not.toBe(before);
      expect(after, 'agent 模式的说明里没有说清它会动手').toMatch(/工具/);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('磁盘上的后端认不出来：退回普通对话', async () => {
    const dir = join(ROOT, '.tmp-e2e-backend-select-unknown');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { backend: 'bogus' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      // 主进程的状态清洗会把它退回「普通对话」，
      // 设置页显示的必须是清洗后的值（不是磁盘上那个）。
      expect(await settings.inputValue('#llmBackend')).toBe('chat');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
