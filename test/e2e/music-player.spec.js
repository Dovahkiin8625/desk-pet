// 音乐播放器插件的端到端验证。
//
// 验的是**用户在界面上真能办的事**：
// - 选好的音乐文件夹进了曲库，歌单里看得见；
// - 点一首歌就放它，界面上的歌名跟着变；
// - 桌面小部件能开出来，显示的是同一首歌；
// - 桌面歌词窗能开出来，并且跟着歌走。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-music');
const MUSIC = join(ROOT, '.tmp-e2e-music-library');

/**
 * 造一个能放的小 WAV（一秒的 440Hz 正弦波）。
 *
 * 真 WAV：Chromium 认这个格式，播放头会照着走。
 */
function makeWav(seconds = 3, rate = 8000) {
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
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
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
    env: { ...process.env, DESK_PET_USER_DATA: USER_DATA, DESK_PET_E2E: '1' },
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

test.describe('音乐播放器插件', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(MUSIC, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await mkdir(MUSIC, { recursive: true });
    await writeFile(join(MUSIC, '测试歌手 - 测试歌曲.wav'), makeWav());
    await writeFile(join(MUSIC, '测试歌曲.lrc'), '[00:00.00]第一句歌词\n[00:01.00]第二句歌词\n');
    // 音乐库指到临时目录；音量调到 0，测试时不至于吵。
    await writeFile(
      join(USER_DATA, 'plugins.json'),
      JSON.stringify(
        {
          disabled: [],
          config: {
            'music-player': {
              musicFolder: MUSIC,
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

  test('曲库里看得见文件夹里的歌', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });
      await expect(frame.locator('#list .label')).toHaveText('测试歌曲');
      await expect(frame.locator('#list .artist')).toHaveText('测试歌手');
      await expect(frame.locator('#lib-count')).toHaveText('曲库 1 首');
    } finally {
      await app.close();
    }
  });

  test('点一首歌就放它，界面上的歌名跟着变', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });

      await frame.locator('#list li').first().click();
      await expect(frame.locator('#np-title')).toHaveText('测试歌曲', { timeout: 20000 });
      await expect(frame.locator('#np-sub')).toContainText('测试歌手');

      // 真的在放：播放头往前走，时长也读得到。
      await expect(frame.locator('#dur')).toHaveText('00:03', { timeout: 20000 });
      await expect(frame.locator('#pos')).not.toHaveText('00:00', { timeout: 20000 });
      await expect(frame.locator('#play')).toHaveText('⏸');
    } finally {
      await app.close();
    }
  });

  test('桌面小部件能开出来，显示的是同一首歌', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });
      await frame.locator('#list li').first().click();
      await expect(frame.locator('#np-title')).toHaveText('测试歌曲', { timeout: 20000 });

      // 变成桌面小部件：页面原样加载，壳不参与。
      await panel.evaluate(() => document.querySelector('#widget')?.click());
      const widget = await findWindow(app, 'plugins/music-player/pages/widget.html');
      expect(widget, '小部件窗口没有出现').toBeTruthy();
      await widget.waitForLoadState('domcontentloaded');
      await expect(widget.locator('#title')).toHaveText('测试歌曲', { timeout: 20000 });

      // 小部件自己能收起：头上那个 ✕ 就是干这个的。
      await widget.locator('#close').click();
      await expect.poll(() => widget.isClosed(), { timeout: 10000 }).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('桌面歌词窗能开出来，并且跟着歌走', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });
      await frame.locator('#list li').first().click();
      await expect(frame.locator('#np-title')).toHaveText('测试歌曲', { timeout: 20000 });

      // 歌词窗是插件自己开的窗（宿主那套容不下它）。
      await frame.locator('#lyrics').click();
      const lyrics = await findWindow(app, 'pages/lyrics.html');
      expect(lyrics, '桌面歌词窗没有出现').toBeTruthy();
      await lyrics.waitForLoadState('domcontentloaded');
      await expect(lyrics.locator('.line.current')).toHaveText('第一句歌词', { timeout: 20000 });
    } finally {
      await app.close();
    }
  });
});
