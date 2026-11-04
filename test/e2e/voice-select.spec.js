// 音色下拉框的端到端验证。
//
// 这个功能出过一个问题：音色列表原来是 <input list> + <datalist>，
// 而 Chromium 的 datalist 弹层**按输入框当前的内容过滤**——
// 字段预填着当前音色 id 时，几十条里只显示前缀匹配的那几条，
// 看着就像「音色没加上」（清单里明明有 37 条）。
//
// 所以这里钉住两件事：
//   1. 下拉框里是**全部**验过的音色（不是前缀匹配出来的几条）；
//   2. 下拉框和自定义输入框，改了都落盘，且优先级说得清。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SUGGESTED_VOICES } from '../../src/main/assistant/tts/voices.js';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-voice-select');

/** 摆一份助理状态。 */
async function writeAssistantState(dir, tts = {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: {
          enabled: false,
          model: 'speech-02-hd',
          voiceId: 'female-shaonv',
          speed: 1,
          vol: 1,
          pitch: 0,
          host: '',
          ...tts,
        },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
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

/** 打开设置窗口，停在「语音」分区。 */
async function openVoicePanel(app) {
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  await settings.click('#tab-voice');
  await settings.waitForSelector('#panel-voice:not([hidden])', { timeout: 10000 });
  // 选项是异步填进来的（要等主进程把清单发过来）。
  await settings.waitForFunction(
    (n) => document.getElementById('voiceSelect')?.options?.length === n,
    SUGGESTED_VOICES.length,
    { timeout: 10000 }
  );
  return settings;
}

/** 从磁盘上读回存着的音色 id。 */
async function readStoredVoiceId(dir) {
  const raw = JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}'));
  return raw.tts?.voiceId;
}

test.describe('音色下拉框', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('下拉框里是全部验过的音色，不是前缀匹配出来的几条', async () => {
    const dir = join(ROOT, '.tmp-e2e-voice-select-list');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { voiceId: 'female-shaonv' });
    const app = await launch(dir);
    try {
      const settings = await openVoicePanel(app);

      const options = await settings.evaluate(() =>
        Array.from(document.getElementById('voiceSelect').options).map((o) => o.value)
      );
      expect(options.length, '下拉框里的音色条数不对').toBe(SUGGESTED_VOICES.length);
      expect(options).toEqual(SUGGESTED_VOICES.map((v) => v.id));

      // 存着的那个音色在清单里 → 下拉框选中它，自定义框留空。
      expect(await settings.inputValue('#voiceSelect')).toBe('female-shaonv');
      expect(await settings.inputValue('#voiceId')).toBe('');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('换音色：下拉框选一条就落盘', async () => {
    const dir = join(ROOT, '.tmp-e2e-voice-select-pick');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { voiceId: 'female-shaonv' });
    const app = await launch(dir);
    try {
      const settings = await openVoicePanel(app);

      await settings.selectOption('#voiceSelect', 'Chinese (Mandarin)_News_Anchor');

      const stored = await waitUntil(async () => {
        const id = await readStoredVoiceId(dir);
        return id === 'Chinese (Mandarin)_News_Anchor' ? id : null;
      });
      expect(stored, '选中的音色没有落盘').toBeTruthy();
      // 选了清单里的音色，自定义框就该让位。
      expect(await settings.inputValue('#voiceId')).toBe('');
      // 「当前生效」显示的就是真正会发去接口的那个 id。
      expect(await settings.textContent('#voiceCurrent')).toBe('Chinese (Mandarin)_News_Anchor');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('自定义音色 id：填了以它为准', async () => {
    const dir = join(ROOT, '.tmp-e2e-voice-select-custom');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { voiceId: 'female-shaonv' });
    const app = await launch(dir);
    try {
      const settings = await openVoicePanel(app);

      await settings.fill('#voiceId', 'my-own-voice');
      await settings.dispatchEvent('#voiceId', 'change');

      const stored = await waitUntil(async () => {
        const id = await readStoredVoiceId(dir);
        return id === 'my-own-voice' ? id : null;
      });
      expect(stored, '自定义音色 id 没有落盘').toBeTruthy();
      expect(await settings.textContent('#voiceCurrent')).toBe('my-own-voice');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('存着一个清单外的 id：它得留在屏幕上', async () => {
    const dir = join(ROOT, '.tmp-e2e-voice-select-unknown');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { voiceId: 'my-own-voice' });
    const app = await launch(dir);
    try {
      const settings = await openVoicePanel(app);

      // 不能被悄悄换成清单里的别的音色。
      expect(await settings.inputValue('#voiceId')).toBe('my-own-voice');
      expect(await settings.textContent('#voiceCurrent')).toBe('my-own-voice');
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
