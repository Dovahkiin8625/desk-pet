// 「桌宠能做什么」下拉框的端到端验证。
//
// 这个下拉框是两层 agent 的**能力开关**：
// 用户在这里选「只聊天」，桌宠就不派后台任务了。
//
// 所以这里钉住两件事：
//   1. 下拉框里的选项来自 shared/assistant.js 的 DISPATCH_MODES（只有一份定义）；
//   2. 选了就落盘，且**说明文字跟着换**（用户是在盲切时最需要这句提示）。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DISPATCH_MODES } from '../../src/shared/assistant.js';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-dispatch-mode');

/** 摆一份助理状态。 */
async function writeAssistantState(dir, agent = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
        llm: { enabled: true, model: 'stub-model', temperature: 0.7, maxTokens: 800 },
        agent: { dispatch: 'auto', ...agent },
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

/** 从磁盘上读回存着的派单模式。 */
async function readStoredDispatch(dir) {
  const raw = JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}'));
  return raw.agent?.dispatch;
}

test.describe('桌宠能做什么下拉框', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('下拉框里的选项就是共享契约里的那一份', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-list');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { dispatch: 'auto' });
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);

      const options = await settings.evaluate(() =>
        Array.from(document.getElementById('llmDispatch').options).map((o) => o.value)
      );
      expect(options, '下拉框里的模式和共享契约对不上').toEqual([...DISPATCH_MODES]);
      // 存着哪个就选中哪个。
      expect(await settings.inputValue('#llmDispatch')).toBe('auto');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('切到「只聊天」：落盘，且说明跟着换', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-pick');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { dispatch: 'auto' });
    const app = await launch(dir);
    try {
      // **切「只聊天」要问一声**：原生对话框不在测试范围里（Playwright 不拦它），
      // 桩成「用户点头」。
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = () => Promise.resolve({ response: 1, checkboxChecked: false });
      });
      const settings = await openChatPanel(app);

      const before = await settings.textContent('#llmDispatchHint');
      await settings.selectOption('#llmDispatch', 'off');

      const stored = await waitUntil(async () => {
        const d = await readStoredDispatch(dir);
        return d === 'off' ? d : null;
      });
      expect(stored, '选中的模式没有落盘').toBeTruthy();

      // 说明文字得跟着换：用户是在盲切，说明是他唯一的提示。
      const after = await settings.textContent('#llmDispatchHint');
      expect(after, '说明没有跟着换').not.toBe(before);
      expect(after, '「只聊天」的说明里没有说清它不派活').toMatch(/只|不/);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('老配置（llm.backend=agent）读起来是「能派活」', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-migrate');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'assistant.json'),
      JSON.stringify(
        {
          greeting: { enabled: false },
          tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
          tapTalk: { enabled: false, modelSound: false, lines: [] },
          llm: { enabled: true, backend: 'agent', model: 'stub-model' },
        },
        null,
        2
      )
    );
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);
      // 主进程的状态清洗会迁移它：设置页显示的必须是迁移后的值。
      expect(await settings.inputValue('#llmDispatch')).toBe('auto');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('老配置（llm.backend=chat）读起来是「只聊天」', async () => {
    const dir = join(ROOT, '.tmp-e2e-dispatch-mode-migrate-chat');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'assistant.json'),
      JSON.stringify(
        {
          greeting: { enabled: false },
          tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
          tapTalk: { enabled: false, modelSound: false, lines: [] },
          llm: { enabled: true, backend: 'chat', model: 'stub-model' },
        },
        null,
        2
      )
    );
    const app = await launch(dir);
    try {
      const settings = await openChatPanel(app);
      expect(await settings.inputValue('#llmDispatch')).toBe('off');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
