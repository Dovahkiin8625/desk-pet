// 音乐播放器插件的端到端验证。
//
// 验的是**用户在界面上真能办的事**：
// - 左边是歌单列表（默认列表 + 自己建的歌单），点一个才进去；
// - 进歌单之后才有加歌的按钮：📁 把文件夹里的歌加进来，♫ 从本地挑歌加进来；
// - 点一首歌就放它，界面上的歌名跟着变；
// - 桌面小部件能开出来，显示的是同一首歌；
// - 桌面歌词窗能开出来，并且跟着歌走；
// - 音量滑块拖完之后不会被周期刷新顶回去；
// - 点底部的播放区能弹出这一首的播放页面（封面与歌词）；
// - 能建歌单、往歌单里加歌、放歌单里的歌，也能删掉歌单；
// - 歌单的封面取的是第一首歌里内嵌的那张图。
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  header.writeUInt16LE(16, 16);
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

/**
 * 造一个带内嵌封面的 mp3。
 *
 * 只有 ID3v2 的 APIC 帧（里面塞一张 1×1 的 png）——封面是从这里认出来的。
 */
function makeMp3WithCover() {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const apic = Buffer.concat([
    Buffer.from([0]), // 编码
    Buffer.from('image/png\0', 'latin1'),
    Buffer.from([3]), // 图片类型
    Buffer.from([0]), // 描述（空）
    png,
  ]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write('APIC', 0, 'latin1');
  frameHeader.writeUInt32BE(apic.length, 4);
  const frame = Buffer.concat([frameHeader, apic]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3;
  header[4] = 0;
  header[5] = 0;
  header[6] = (frame.length >> 21) & 0x7f;
  header[7] = (frame.length >> 14) & 0x7f;
  header[8] = (frame.length >> 7) & 0x7f;
  header[9] = frame.length & 0x7f;
  return Buffer.concat([header, frame]);
}

/** 启动桌宠。 */
async function launch(folder = MUSIC, files = '') {
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
      DESK_PET_E2E_MUSIC_FOLDER: folder,
      DESK_PET_E2E_MUSIC_FILES: files,
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

/**
 * 点开一个歌单。
 *
 * 窄版（面板里）默认只显示歌单列表，歌曲列表要点开歌单才出来。
 */
async function openPlaylist(frame, name) {
  await frame.locator(`#playlists li:has-text("${name}") .name`).click();
  await expect(frame.locator('#main')).toBeVisible({ timeout: 10000 });
}

test.describe('音乐播放器插件', () => {
  test.beforeEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
    await rm(MUSIC, { recursive: true, force: true });
    await mkdir(USER_DATA, { recursive: true });
    await mkdir(MUSIC, { recursive: true });
    await writeFile(join(MUSIC, '测试歌手 - 测试歌曲.wav'), makeWav());
    await writeFile(join(MUSIC, '测试歌曲.lrc'), '[00:00.00]第一句歌词\n[00:01.00]第二句歌词\n');
    // 音量调到 0，测试时不至于吵。
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

  test('左边是歌单列表，默认列表在最前面', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#playlists li')).toHaveCount(1, { timeout: 20000 });
      await expect(frame.locator('#playlists li').first().locator('.name')).toHaveText('默认列表');
      await expect(frame.locator('#main-name')).toHaveText('默认列表');
      await expect(frame.locator('#main-count')).toHaveText('0 首');
    } finally {
      await app.close();
    }
  });

  test('窄版里默认只显示歌单列表，点开歌单才出歌曲列表', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#playlists li')).toHaveCount(1, { timeout: 20000 });

      // 默认：只有歌单列表，歌曲那一块不在这儿。
      await expect(frame.locator('#main')).toBeHidden();
      await expect(frame.locator('#list')).toBeHidden();

      // 加歌的按钮作用域是歌单：还没进歌单就不该露出来。
      await expect(frame.locator('#pl-song')).toBeHidden();
      await expect(frame.locator('#pl-folder')).toBeHidden();

      // 点开歌单：歌曲列表出来，还能退回去。
      await openPlaylist(frame, '默认列表');
      await expect(frame.locator('#list')).toBeVisible();
      await expect(frame.locator('#pl-song')).toBeVisible();
      await expect(frame.locator('#pl-folder')).toBeVisible();
      await frame.locator('#back').click();
      await expect(frame.locator('#main')).toBeHidden();
      await expect(frame.locator('#playlists')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('进歌单后，📁 把文件夹里的歌加进当前列表', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#playlists li')).toHaveCount(1, { timeout: 20000 });

      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });
      await expect(frame.locator('#list .label')).toHaveText('测试歌曲');
      await expect(frame.locator('#list .artist')).toHaveText('测试歌手');
      await expect(frame.locator('#main-count')).toHaveText('1 首');
    } finally {
      await app.close();
    }
  });

  test('♫ 从本地挑几首歌加进当前歌单', async () => {
    const song = join(MUSIC, '测试歌手 - 测试歌曲.wav');
    const { app, pet } = await launch(MUSIC, song);
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await expect(frame.locator('#playlists li')).toHaveCount(1, { timeout: 20000 });

      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-song').click();
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });
      await expect(frame.locator('#list .label')).toHaveText('测试歌曲');
      await expect(frame.locator('#list .artist')).toHaveText('测试歌手');
      await expect(frame.locator('#main-count')).toHaveText('1 首');
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
      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
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
      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
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
      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
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

  test('音量滑块：拖完之后不会被周期刷新顶回去', async () => {
    const { app, pet } = await launch();
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });
      await frame.locator('#list li').first().click();
      // 播放头在走：说明周期刷新确实在往界面推东西。
      await expect(frame.locator('#pos')).not.toHaveText('00:00', { timeout: 20000 });

      // 起始音量是 0（测试配置里写的）。
      await expect(frame.locator('#vol')).toHaveValue('0');

      // 用户把滑块拖到 42。拖的过程中主进程还在每 500ms 推一次状态。
      await frame.locator('#vol').evaluate((input) => {
        input.value = '42';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await panel.waitForTimeout(1200);
      await expect(frame.locator('#vol')).toHaveValue('42');

      // 松手：主进程要真的收到这个音量。
      await frame.locator('#vol').evaluate((input) => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect
        .poll(
          async () => {
            const prefs = JSON.parse(await readFile(join(USER_DATA, 'plugins.json'), 'utf8'));
            return prefs.config?.['music-player']?.volume;
          },
          { timeout: 10000 },
        )
        .toBe(42);
    } finally {
      await app.close();
    }
  });

  test('点底部的播放区：弹出这一首的播放页面（封面与歌词）', async () => {
    const { app, pet } = await launch();
    try {
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

      // 播放页面默认不在这儿。
      await expect(frame.locator('#song-page')).toBeHidden();

      await frame.locator('#now').click();
      await expect(frame.locator('#song-page')).toBeVisible();
      await expect(frame.locator('#song-name')).toHaveText('测试歌曲');
      await expect(frame.locator('#song-artist')).toHaveText('测试歌手');
      // 歌词在这儿，唱到哪行哪行是高亮的。
      await expect(frame.locator('#song-lyrics .line')).toHaveCount(2);
      await expect(frame.locator('#song-lyrics .line').first()).toHaveText('第一句歌词');
      await expect(frame.locator('#song-lyrics .line.on')).toHaveCount(1);

      // 关掉就回到歌单那一页。
      await frame.locator('#song-close').click();
      await expect(frame.locator('#song-page')).toBeHidden();
    } finally {
      await app.close();
    }
  });

  test('能建歌单、往里加歌、放歌单里的歌，也能删掉歌单', async () => {
    const song = join(MUSIC, '测试歌手 - 测试歌曲.wav');
    const { app, pet } = await launch(MUSIC, song);
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
      await expect(frame.locator('#list li')).toHaveCount(1, { timeout: 20000 });

      // 新建歌单：建好之后它就是当前放的那一份。
      await frame.locator('#back').click();
      await frame.locator('#pl-new').click();
      await frame.locator('#pl-name').fill('通勤');
      await frame.locator('#pl-name-ok').click();
      await expect(frame.locator('#playlists li')).toHaveCount(2, { timeout: 10000 });
      await expect(frame.locator('#main-name')).toHaveText('通勤');
      await expect(frame.locator('#main-count')).toHaveText('0 首');
      await expect(frame.locator('#list li')).toHaveCount(0);

      // 从本地挑一首歌加进歌单。
      await openPlaylist(frame, '通勤');
      await frame.locator('#pl-song').click();
      await expect(frame.locator('#main-count')).toHaveText('1 首', { timeout: 10000 });

      // 歌单里的歌能放。
      await expect(frame.locator('#list li')).toHaveCount(1);
      await frame.locator('#list li').first().click();
      await expect(frame.locator('#np-title')).toHaveText('测试歌曲', { timeout: 20000 });

      // 歌单落盘了。
      const saved = JSON.parse(await readFile(join(USER_DATA, 'music-playlists.json'), 'utf8'));
      expect(saved.playlists.length, '歌单没存到盘上').toBe(2);
      const commute = saved.playlists.find((p) => p.name === '通勤');
      expect(commute, '通勤没存到盘上').toBeTruthy();
      expect(commute.tracks.length).toBe(1);

      // 删歌单要点两下（头一下是问「真删？」）。删的按钮悬停时才露出来。
      // 窄版里得先回到歌单列表——歌单那一块在那儿才看得见。
      await frame.locator('#back').click();
      const row = frame.locator('#playlists li:has-text("通勤")');
      await row.hover();
      await row.locator('.rm').click();
      await row.locator('.rm').click();
      await expect(frame.locator('#playlists li')).toHaveCount(1, { timeout: 10000 });
      await expect(frame.locator('#main-name')).toHaveText('默认列表');
    } finally {
      await app.close();
    }
  });

  test('歌单的封面取第一首歌里内嵌的那张图', async () => {
    const folder = join(ROOT, '.tmp-e2e-music-cover');
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '封面歌手 - 封面歌曲.mp3'), makeMp3WithCover());
    const { app, pet } = await launch(folder);
    try {
      await pet.evaluate(() => window.pet.openPanel());
      const panel = await findWindow(app, '/renderer/panel/index.html');
      expect(panel, '面板窗口没有出现').toBeTruthy();
      await panel.waitForLoadState('domcontentloaded');

      const frame = await openMusicPlugin(panel);
      await openPlaylist(frame, '默认列表');
      await frame.locator('#pl-folder').click();
      await expect(frame.locator('#playlists li.on .cover img')).toHaveCount(1, { timeout: 20000 });

      // 封面是从文件里认出来的，慢一点：等它推过来。
      await expect(frame.locator('#main-cover img')).toBeVisible({ timeout: 20000 });

      // 播放页面里放的是**这一首**自己的封面。
      await frame.locator('#list li').first().click();
      await frame.locator('#now').click();
      await expect(frame.locator('#song-cover img')).toBeVisible({ timeout: 20000 });
    } finally {
      await app.close();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
