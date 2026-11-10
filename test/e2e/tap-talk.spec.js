// 「点桌宠时念台词」的端到端验证。
//
// 这个功能最容易出的两个问题都在这里验：
//
//   1. **点击时不该再调接口**。台词的语音是**事先**合成好的，
//      点击时只读本地缓存——所以点击之后，桩服务的调用次数不能变。
//      （每次点击都调一次接口：慢、吵、还花钱。）
//   2. **模型自带的声音要让位**。开了「点桌宠时说话」之后，
//      点击就该念生成的台词，模型自带的 wav 不该再响；
//      把它放回随机池（设置里那个开关）之后，它才重新参与抽签。
//
// 语音走**本地桩服务**（DESK_PET_TTS_HOSTS），不打真实接口。
import { test, expect, _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-tap-talk');

/** 一段真的能解码的音频（WAV）：渲染层要拿它解码，坏文件会掩盖问题。 */
function makeWav() {
  const sampleRate = 8000;
  const samples = 800;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  }
  return buf;
}

/** 一个假的 TTS 接口：回一段固定音频，并记录被叫了几次、叫了些什么。 */
async function startStub() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* 桩服务不挑食 */
      }
      calls.push(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          base_resp: { status_code: 0, status_msg: '' },
          data: { audio: makeWav().toString('hex') },
          extra_info: { audio_format: 'mp3', audio_length: 100 },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { calls, server, url: `http://127.0.0.1:${port}` };
}

/** 摆一份助理状态（点桌宠时说什么）。 */
async function writeAssistantState(dir, tapTalk, tts = {}, { withKey = true } = {}) {
  await mkdir(dir, { recursive: true });
  if (withKey) {
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({ minimaxApiKey: 'test-key' }, null, 2)
    );
  }
  await writeFile(
    join(dir, 'assistant.json'),
    JSON.stringify(
      {
        greeting: { enabled: false },
        tts: {
          enabled: true,
          model: 'speech-02-hd',
          voiceId: 'female-shaonv',
          speed: 1,
          vol: 1,
          pitch: 0,
          host: '',
          ...tts,
        },
        tapTalk,
      },
      null,
      2
    )
  );
}

/** 启动桌宠；语音接口指向桩服务。 */
async function launch(stubUrl, userData = USER_DATA) {
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: userData,
      DESK_PET_E2E: '1',
      DESK_PET_TTS_HOSTS: stubUrl,
    },
  });
}

/** 等模型上屏、轮廓量出来。 */
async function waitForPet(pet) {
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  await pet.waitForFunction(() => window.__pet?.silhouetteReady === true, null, { timeout: 30000 });
  await pet.waitForTimeout(700);
}

/** 在形象里找一个确实不透明的点。 */
async function findSolidPoint(pet) {
  return pet.evaluate(() => {
    const r = window.__pet.contentRect;
    for (let gy = 0.1; gy <= 0.95; gy += 0.05) {
      for (let gx = 0.1; gx <= 0.95; gx += 0.05) {
        const x = r.x + r.width * gx;
        const y = r.y + r.height * gy;
        if (window.__pet.isOnFigure(x, y)) return { x, y };
      }
    }
    return null;
  });
}

/** 在所有窗口里按 URL 找某一个（气泡、面板都是独立窗口）。 */
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
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test.describe('点桌宠时念台词', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await writeAssistantState(USER_DATA, {
      enabled: true,
      modelSound: false,
      lines: ['你好呀'],
    });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('台词语音事先合成好，点击时不再调接口', async () => {
    const stub = await startStub();
    const app = await launch(stub.url);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      // 预生成：台词的语音在后台就合成好了（走的是同一个桩服务）。
      const cacheDir = join(USER_DATA, 'tts-cache', 'tap');
      const warmed = await waitUntil(async () => {
        const files = await readdir(cacheDir).catch(() => []);
        return files.filter((f) => f.endsWith('.mp3')).length > 0;
      });
      expect(warmed, '台词语音没有预生成').toBe(true);
      expect(stub.calls.length).toBeGreaterThan(0);
      const callsAfterPrewarm = stub.calls.length;

      // 点一下桌宠。
      const solid = await findSolidPoint(pet);
      expect(solid).toBeTruthy();
      await pet.mouse.click(solid.x, solid.y);
      await pet.waitForFunction(() => window.__pet.lastTapDecision === 'voice', null, {
        timeout: 10000,
      });

      // 念了：语音播放了（口型也跟着走）。
      await pet.waitForFunction(() => window.__pet.speechCount > 0, null, { timeout: 10000 });

      // **点击没有再调接口**：音频是从缓存里读的。
      await pet.waitForTimeout(500);
      expect(stub.calls.length, '点击时又调了一次接口').toBe(callsAfterPrewarm);
    } finally {
      await app.close();
      stub.server.close();
    }
  });

  test('念出来的台词显示在气泡里，摆在脚下', async () => {
    const stub = await startStub();
    const app = await launch(stub.url);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);
      const cacheDir = join(USER_DATA, 'tts-cache', 'tap');
      await waitUntil(async () => {
        const files = await readdir(cacheDir).catch(() => []);
        return files.filter((f) => f.endsWith('.mp3')).length > 0;
      });

      // 桌宠默认在屏幕底部：那儿放不下「脚下」的气泡。
      // 把它挪到屏幕中间——上下都放得下，气泡摆哪边就只取决于
      // 「这条消息指定了摆脚下」这一条，而不是「别的边放不下」。
      await pet.evaluate(() => window.pet.moveWindowBy(0, -350));
      await pet.waitForTimeout(600);

      const solid = await findSolidPoint(pet);
      await pet.mouse.click(solid.x, solid.y);

      const bubble = await findWindow(app, '/renderer/bubble/index.html');
      expect(bubble, '没有气泡窗口').toBeTruthy();
      await bubble.waitForFunction(
        () => (document.getElementById('text')?.textContent || '').includes('你好呀'),
        null,
        { timeout: 15000 }
      );
      // 摆在脚下：点桌宠时插件面板在头顶，两者不能重叠。
      await bubble.waitForFunction(() => !!document.getElementById('bubble')?.dataset.placement, null, {
        timeout: 10000,
      });
      const placement = await bubble.evaluate(
        () => document.getElementById('bubble').dataset.placement
      );
      expect(placement).toBe('bottom');
    } finally {
      await app.close();
      stub.server.close();
    }
  });

  test('「点击桌宠时说话」关着：模型自带的声音照旧（今天的行为）', async () => {
    const dir = join(ROOT, '.tmp-e2e-tap-talk-off');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, { enabled: false, modelSound: false, lines: ['你好呀'] });
    const stub = await startStub();
    const app = await launch(stub.url, dir);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      const solid = await findSolidPoint(pet);
      await pet.mouse.click(solid.x, solid.y);
      await pet.waitForFunction(() => window.__pet.lastTapDecision !== null, null, { timeout: 10000 });
      // 生成的语音顶不上来 → 模型自带的声音顶上（不该让人平白少一个声音）。
      expect(await pet.evaluate(() => window.__pet.lastTapDecision)).toBe('model');
      expect(await pet.evaluate(() => window.__pet.speechCount)).toBe(0);
    } finally {
      await app.close();
      stub.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('没配 API Key：模型自带的声音照旧，桌宠没有被「静音」', async () => {
    const dir = join(ROOT, '.tmp-e2e-tap-talk-nokey');
    await rm(dir, { recursive: true, force: true });
    // 有状态、有台词，但**没有 Key**。
    await writeAssistantState(
      dir,
      { enabled: true, modelSound: false, lines: ['你好呀'] },
      {},
      { withKey: false }
    );
    const stub = await startStub();
    const app = await launch(stub.url, dir);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      const solid = await findSolidPoint(pet);
      await pet.mouse.click(solid.x, solid.y);
      await pet.waitForFunction(() => window.__pet.lastTapDecision !== null, null, { timeout: 10000 });
      expect(await pet.evaluate(() => window.__pet.lastTapDecision)).toBe('model');
      expect(await pet.evaluate(() => window.__pet.speechCount)).toBe(0);
      // 也没去打扰接口。
      expect(stub.calls.length).toBe(0);
    } finally {
      await app.close();
      stub.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('模型自带的声音放回随机池：点击时它也可能被抽中', async () => {
    const dir = join(ROOT, '.tmp-e2e-tap-talk-model');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, {
      enabled: false,
      modelSound: true,
      lines: ['你好呀'],
    });
    const stub = await startStub();
    const app = await launch(stub.url, dir);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      const solid = await findSolidPoint(pet);
      await pet.mouse.click(solid.x, solid.y);
      await pet.waitForFunction(() => window.__pet.lastTapDecision !== null, null, { timeout: 10000 });
      // 模型自带的声音在池子里 → 这次由模型自己出声。
      expect(await pet.evaluate(() => window.__pet.lastTapDecision)).toBe('model');
      expect(await pet.evaluate(() => window.__pet.speechCount)).toBe(0);
    } finally {
      await app.close();
      stub.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('刚填上 API Key：台词的语音立刻生成好', async () => {
    const dir = join(ROOT, '.tmp-e2e-tap-talk-key');
    await rm(dir, { recursive: true, force: true });
    // 有状态，但**还没有 Key**。
    await writeAssistantState(
      dir,
      { enabled: true, modelSound: false, lines: ['你好呀'] },
      {},
      { withKey: false }
    );
    const stub = await startStub();
    const app = await launch(stub.url, dir);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);
      // 没有 Key → 生成不出来，也不该去打扰接口。
      expect(stub.calls.length).toBe(0);

      // 在设置窗口里填上 Key。
      await pet.evaluate(() => window.pet.openSettings());
      const settings = await findWindow(app, '/src/settings/index.html');
      expect(settings, '设置窗口没有出现').toBeTruthy();
      await settings.waitForLoadState('domcontentloaded');
      await settings.click('#tab-voice');
      await settings.fill('#apiKey', 'test-key');
      await settings.click('#saveKey');

      // 台词的语音生成好了。
      const cacheDir = join(dir, 'tts-cache', 'tap');
      const warmed = await waitUntil(async () => {
        const files = await readdir(cacheDir).catch(() => []);
        return files.filter((f) => f.endsWith('.mp3')).length > 0;
      });
      expect(warmed, '填了 Key 之后台词没有生成').toBe(true);
    } finally {
      await app.close();
      stub.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('双击桌宠不念台词：双击是「我要搜索」，不是「摸一下」', async () => {
    const stub = await startStub();
    const app = await launch(stub.url);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);
      const cacheDir = join(USER_DATA, 'tts-cache', 'tap');
      await waitUntil(async () => {
        const files = await readdir(cacheDir).catch(() => []);
        return files.filter((f) => f.endsWith('.mp3')).length > 0;
      });

      const solid = await findSolidPoint(pet);
      expect(solid).toBeTruthy();
      await pet.mouse.dblclick(solid.x, solid.y);

      // 双击被认出来了（不然这条用例就是白过）。
      await pet.waitForFunction(() => window.__pet.doubleTaps > 0, null, { timeout: 10000 });
      // 等过双击窗口：押着的台词要是没作废，这时候就该念出来了。
      await pet.waitForTimeout(1500);
      expect(await pet.evaluate(() => window.__pet.speechCount)).toBe(0);
    } finally {
      await app.close();
      stub.server.close();
    }
  });

  test('设置窗口的「语音」分区里能改这些开关', async () => {
    const dir = join(ROOT, '.tmp-e2e-tap-talk-settings');
    await rm(dir, { recursive: true, force: true });
    await writeAssistantState(dir, {
      enabled: true,
      modelSound: false,
      lines: ['你好呀'],
    });
    const stub = await startStub();
    const app = await launch(stub.url, dir);
    try {
      const pet = await app.firstWindow();
      await waitForPet(pet);

      await pet.evaluate(() => window.pet.openSettings());
      const settings = await findWindow(app, '/src/settings/index.html');
      expect(settings, '设置窗口没有出现').toBeTruthy();
      await settings.waitForLoadState('domcontentloaded');
      await settings.click('#tab-voice');
      await settings.waitForSelector('#panel-voice:not([hidden])', { timeout: 10000 });

      // 台词框里是当前的那几句。
      await settings.waitForFunction(
        () => (document.getElementById('tapTalkLines')?.value || '').includes('你好呀'),
        null,
        { timeout: 10000 }
      );

      // 改台词：填别的、勾上「也用模型自带的声音」。
      await settings.fill('#tapTalkLines', '第一句\n第二句');
      await settings.click('#tapTalkModelSound');
      await settings.dispatchEvent('#tapTalkLines', 'change');

      // 真的落盘了（读回磁盘上的 assistant.json）。
      const saved = await waitUntil(async () => {
        const raw = JSON.parse(
          await readFile(join(dir, 'assistant.json'), 'utf8').catch(() => '{}')
        );
        return raw.tapTalk?.modelSound === true &&
          Array.isArray(raw.tapTalk?.lines) &&
          raw.tapTalk.lines.join('|') === '第一句|第二句'
          ? raw.tapTalk
          : null;
      });
      expect(saved, '设置没有落盘').toBeTruthy();

      // 改完立刻生效：主进程把新的「池子成分」推给了桌宠窗口。
      await pet.waitForFunction(() => window.__pet?.tapVoice?.modelSound === true, null, {
        timeout: 10000,
      });
    } finally {
      await app.close();
      stub.server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
