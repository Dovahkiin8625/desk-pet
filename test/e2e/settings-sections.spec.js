// 设置页的分区与「它记住的事」的端到端验证。
//
// 这里钉三件事：
//   1. 分区是七个：形象与大小在「外观」，它什么时候出声在「声音」；
//   2. 记忆能**逐条**删——删一条不牵连别的，聊天记录也不受影响；
//   3. 「先应一声」的等待时长能改，改了落盘。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-settings-sections');

const FACTS = ['用户喜欢喝美式咖啡', '用户的猫叫阿花', '用户每周三加班'];

/** 摆一份助理状态：带三条事实与一条聊天记录。 */
async function writeAssistantState(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: { enabled: false, voiceId: 'female-shaonv', speed: 1, vol: 1, pitch: 0, host: '' },
        tapTalk: { enabled: false, modelSound: false, lines: [] },
        llm: { enabled: true, backend: 'chat' },
        chat: {
          messages: [{ id: 'm1', at: 1, kind: 'user', role: 'user', text: '你好' }],
          facts: FACTS,
        },
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

/** 打开设置窗口。 */
async function openSettings(app) {
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.evaluate(() => window.pet.openSettings());
  const settings = await findWindow(app, '/src/settings/index.html');
  expect(settings, '设置窗口没有出现').toBeTruthy();
  await settings.waitForLoadState('domcontentloaded');
  return settings;
}

/** 从磁盘上读回助理状态。 */
async function readStoredState(dir) {
  return JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}'));
}

test.describe('设置页分区与记忆', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('分区是七个：形象与大小在「外观」，出声的时机在「声音」', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openSettings(app);

      const labels = await settings.evaluate(() =>
        Array.from(document.querySelectorAll('#nav .nav-tab .nav-label')).map((el) => el.textContent.trim())
      );
      expect(labels, '分区和设计对不上').toEqual(['外观', '声音', '对话', '后台任务', '记忆', '插件', '系统']);
      // 「桌宠」那一节已经没了。
      expect(await settings.locator('#tab-pet').count(), '还有「桌宠」这一节').toBe(0);

      // 「外观」这一节里是形象、它的大小、主题与明暗。
      await settings.click('#tab-appearance');
      await settings.waitForSelector('#panel-appearance:not([hidden])', { timeout: 10000 });
      expect(await settings.isVisible('#model'), '外观这一节里没有形象').toBe(true);
      expect(await settings.isVisible('#scale'), '外观这一节里没有缩放').toBe(true);
      expect(await settings.isVisible('#opacity'), '外观这一节里没有透明度').toBe(true);
      expect(await settings.locator('input[name="mode"]').count(), '外观这一节里没有明暗').toBe(3);
      expect(await settings.locator('#themeSelect option').count(), '外观这一节里没有主题清单').toBeGreaterThan(0);

      // 「声音」这一节里管它什么时候出声。整点报时已经挪进「对话 → 搭话」了。
      await settings.click('#tab-voice');
      await settings.waitForSelector('#panel-voice:not([hidden])', { timeout: 10000 });
      expect(await settings.isVisible('#chime'), '整点报时还在声音这一节里').toBe(false);
      expect(await settings.isVisible('#greeting'), '声音这一节里没有启动问候').toBe(true);
      expect(await settings.isVisible('#sound'), '声音这一节里没有提示音').toBe(true);

      // 搭话、自发反应、整点报时是一伙的事：都在「对话 → 搭话」里。
      await settings.click('#tab-chat');
      await settings.waitForSelector('#panel-chat:not([hidden])', { timeout: 10000 });
      await settings.click('#chat-tab-proactive');
      await settings.waitForSelector('#chat-sub-proactive:not([hidden])', { timeout: 10000 });
      expect(await settings.isVisible('#llmProactive'), '搭话这一页没有主动搭话').toBe(true);
      expect(await settings.isVisible('#llmProactiveInterval'), '搭话这一页没有搭话间隔').toBe(true);
      expect(await settings.isVisible('#llmAmbient'), '搭话这一页没有自发反应').toBe(true);
      expect(await settings.isVisible('#llmAmbientInterval'), '搭话这一页没有自发反应间隔').toBe(true);
      expect(await settings.isVisible('#chime'), '搭话这一页没有整点报时').toBe(true);

      // 插件的事归插件自己管：设置页里不再重复一份提示。
      const bodyText = await settings.textContent('body');
      expect(bodyText).not.toContain('双击一下桌宠');
      expect(bodyText).not.toContain('插件的设置归插件自己管');
    } finally {
      await app.close();
    }
  });

  test('记忆能逐条删：删一条不牵连别的，聊天记录也不动', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openSettings(app);
      await settings.click('#tab-memory');
      await settings.waitForSelector('#panel-memory:not([hidden])', { timeout: 10000 });
      await settings.waitForFunction(
        () => document.querySelectorAll('#llmFacts li').length === 3,
        null,
        { timeout: 10000 }
      );

      // 删掉第一条。
      await settings.locator('#llmFacts li .fact-del').first().click();

      const stored = await waitUntil(async () => {
        const state = await readStoredState(USER_DATA);
        const facts = state?.chat?.facts || [];
        return facts.length === 2 ? state : null;
      });
      expect(stored, '删掉的那条没有落盘').toBeTruthy();
      expect(stored.chat.facts).not.toContain(FACTS[0]);
      expect(stored.chat.facts, '别的记忆被牵连了').toEqual([FACTS[1], FACTS[2]]);
      // 聊天记录不能被顺手清掉——用户没点「忘掉这些」。
      expect(stored.chat.messages?.length ?? 0, '聊天记录被清了').toBe(1);

      // 界面上也只剩两条。
      expect(await settings.locator('#llmFacts li').count()).toBe(2);
    } finally {
      await app.close();
    }
  });

  test('「先应一声」的等待时长能改，改了落盘', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openSettings(app);
      await settings.click('#tab-chat');
      await settings.waitForSelector('#panel-chat:not([hidden])', { timeout: 10000 });
      await settings.click('#chat-tab-proactive');
      await settings.waitForSelector('#chat-sub-proactive:not([hidden])', { timeout: 10000 });

      // 选「2 秒」。
      await settings.selectOption('#llmAckDelay', '2000');
      const stored = await waitUntil(async () => {
        const state = await readStoredState(USER_DATA);
        return state?.llm?.ackDelayMs === 2000 ? state : null;
      });
      expect(stored, '等待时长没有落盘').toBeTruthy();
      expect(stored.llm.ackEnabled, '选的是时长，应答却是关着的').toBe(true);

      // 选「关闭」：应答彻底不响了。
      await settings.selectOption('#llmAckDelay', 'off');
      const off = await waitUntil(async () => {
        const state = await readStoredState(USER_DATA);
        return state?.llm?.ackEnabled === false ? state : null;
      });
      expect(off, '「关闭」没有落盘').toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test('设置里没有「对话后端」下拉了', async () => {
    await writeAssistantState(USER_DATA);
    const app = await launch(USER_DATA);
    try {
      const settings = await openSettings(app);
      // 前台恒定走交互层，没得选了——留着就是个骗人的控件。
      await expect(settings.locator('#llmBackend')).toHaveCount(0);
      // **别把整块面板删了**：这一节里该有的还在。
      await expect(settings.locator('#llmBaseUrl')).toHaveCount(1);
      await expect(settings.locator('#llmModel')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
});
