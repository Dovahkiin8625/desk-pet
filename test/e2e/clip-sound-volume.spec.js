// clip 的原声在「别的声音正在响」时折半的端到端验证。
//
// 场景：音乐插件在放歌时，切到 sound:true 的 clip，
// 它的原声按总音量的一半出声；音乐停了再切一次，恢复总音量。
//
// 两条链路都要走通才算数：
//   音乐引擎（插件藏起来的窗口）→ 主进程盯住 playing → 推给宠物窗口；
//   宠物窗口切 clip → playItem 按「别的声音在不在响」折半。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-clip-volume');
const MUSIC = join(ROOT, '.tmp-e2e-clip-volume-library');

/**
 * 造一个能放的小 WAV（六秒的 440Hz 正弦波）。
 * 六秒比整个用例都长：音乐不会在中间自己放完。
 */
function makeWav(seconds = 6, rate = 8000) {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.sin((2 * Math.PI * 440 * i) / rate) * 6000;
    data.writeInt16LE(Math.round(value), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt16LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 启动桌宠。 */
async function launch() {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
      DESK_PET_E2E_MUSIC_FOLDER: MUSIC,
    },
  });
  const pet = await app.firstWindow();
  await pet.waitForFunction(() => window.__pet?.modelLoaded === true, null, { timeout: 30000 });
  return { app, pet };
}

/** 在所有窗口里按 URL 找某一个。 */
async function findWindow(app, part, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
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

/** 打开面板并走到音乐播放器的页面，返回装着插件页面的 iframe。 */
async function openMusicPlugin(panel) {
  await panel.fill('#query', '音乐');
  await panel.waitForFunction(() => window.__panel?.resultIds?.includes('music-player'), null, {
    timeout: 10000,
  });
  await panel.click('#results li:has-text("音乐播放器")');
  await panel.waitForFunction(() => window.__panel?.pluginId === 'music-player', null, {
    timeout: 10000,
  });
  return panel.frameLocator('#plugin-frame');
}

/** 点开歌单（窄版面板里歌曲列表默认收着）。 */
async function openPlaylist(frame, name) {
  await frame.locator(`#playlists li:has-text("${name}") .name`).click();
  await expect(frame.locator('#main')).toBeVisible({ timeout: 10000 });
}

/** 切到 miya 并等它真的挂上。 */
async function switchToMiya(pet) {
  const ok = await pet.evaluate(async () => window.__pet.switchModel('miya'));
  expect(ok, 'miya 挂不上').toBe(true);
  await pet.waitForFunction(() => window.__pet?.modelId === 'miya', null, { timeout: 30000 });
}

/** 读某个 clip 的 <video> 音量。 */
function clipVolume(pet, clipId) {
  return pet.evaluate(
    (id) =>
      window.__pet.model.__videoItems.find((i) => i.clip.id === id)?.video.volume,
    clipId
  );
}

test.describe('clip 原声折半', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(MUSIC, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await mkdir(MUSIC, { recursive: true });
    await writeFile(join(MUSIC, '测试歌手 - 测试歌曲.wav'), makeWav());
    // 语音关着：免得合成语音自己插进「别的声音」里，把断言搅混。
    // 总音量 0.6：能与默认的 0.8 区分开，证明推送真的生效了。
    await writeFile(
      join(USER_DATA, 'assistant.json'),
      JSON.stringify(
        {
          greeting: { enabled: false },
          tts: { enabled: false },
          sound: { enabled: true, volume: 0.6 },
        },
        null,
        2
      )
    );
    // 音量调到 0：测试时不至于吵。
    await writeFile(
      join(USER_DATA, 'plugins.json'),
      JSON.stringify(
        {
          disabled: [],
          config: {
            'music-player': {
              volume: 0,
              playMode: '顺序播放',
              lyricsOn: false,
            },
          },
        },
        null,
        2
      )
    );
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(MUSIC, { recursive: true, force: true });
  });

  test('音乐在放时切到 sound:true 的 clip，原声折半；音乐停了再切，恢复总音量', async () => {
    const { app, pet } = await launch();
    try {
      await switchToMiya(pet);
      // 总音量真的传到了宠物窗口（助理状态里写的是 0.6）。
      await pet.waitForFunction(() => window.__pet?.volume === 0.6, null, {
        timeout: 10000,
      });

      // 加歌、点第一首：让音乐真的放起来。
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');
      const frame = await openMusicPlugin(panel);
      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });
      await frame.locator('#list li').first().click();
      await expect(frame.locator('#np-title')).toHaveText('测试歌曲', { timeout: 20000 });

      // 宠物窗口真的收到了「音乐在放」。
      await pet.waitForFunction(() => window.__pet?.musicPlaying === true, null, {
        timeout: 15000,
      });

      // 音乐在放时切到 laugh（sound:true）：原声按 0.6 的一半出声。
      await pet.evaluate(() => window.__pet.model.motion('laugh', 0));
      await pet.waitForFunction(
        () => window.__pet?.model?.__currentClip?.clip?.id === 'laugh',
        null,
        { timeout: 15000 }
      );
      expect(await clipVolume(pet, 'laugh')).toBeCloseTo(0.3, 2);

      // 暂停音乐：宠物窗口要知道。
      await frame.locator('#play').click();
      await pet.waitForFunction(() => window.__pet?.musicPlaying === false, null, {
        timeout: 15000,
      });

      // 音乐停了再切到 dance-spin（sound:true）：恢复总音量。
      await pet.evaluate(() => window.__pet.model.motion('dance-spin', 0));
      await pet.waitForFunction(
        () => window.__pet?.model?.__currentClip?.clip?.id === 'dance-spin',
        null,
        { timeout: 15000 }
      );
      expect(await clipVolume(pet, 'dance-spin')).toBeCloseTo(0.6, 2);
    } finally {
      await app.close();
    }
  });
});
