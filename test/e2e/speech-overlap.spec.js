// 「两次回复的语音不该叠在一起」的端到端验证。
//
// 用户抱怨的是：跟桌宠说一件要花点时间的事，说到一半事情做完了，
// 桌宠又报一句——两次回复的语音同时响，糊成一团。
//
// 这里盯的是**播放端**：渲染层一次只播一段语音。
// 两段语音在主进程那头几乎同时送过来（相隔 300 毫秒），
// 渲染层必须把后面那段排到前面那段播完之后。
import { test, expect, _electron as electron } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const USER_DATA = join(ROOT, '.tmp-e2e-speech-overlap');

/** 启动桌宠（语音、对话都不开：这里只验渲染层的播放）。 */
async function launch() {
  return electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      DESK_PET_USER_DATA: USER_DATA,
      DESK_PET_E2E: '1',
    },
  });
}

test.describe('语音不重叠', () => {
  test.beforeAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test.afterAll(async () => {
    await rm(USER_DATA, { recursive: true, force: true });
  });

  test('后面那段语音等前面那段播完才开始', async () => {
    const app = await launch();
    try {
      const pet = await app.firstWindow();
      await pet.waitForFunction(() => window.__pet?.ready === true, null, { timeout: 30000 });

      // 主进程连着送两段语音（主进程那头就是主进程做的事：
      // 前台回复与后台那件事的报信，撞在一起送）。
      await app.evaluate(async ({ BrowserWindow }) => {
        // 一段真的能解码的音频（WAV）：渲染层要拿它解码，坏文件会掩盖问题。
        const makeWav = () => {
          const sampleRate = 8000;
          const samples = 8000 * 2; // 两秒
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
          return new Uint8Array(buf);
        };

        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/src/renderer/index.html')
        );
        win.webContents.send('pet:speak', { audio: makeWav(), mime: 'audio/wav', id: 1 });
        // 第二段在第一段**还在播**的时候送到。
        await new Promise((r) => setTimeout(r, 300));
        win.webContents.send('pet:speak', { audio: makeWav(), mime: 'audio/wav', id: 2 });
      });

      // 两段都播完了。
      await pet.waitForFunction(
        () => (window.__pet?.speechStats?.finished || 0) >= 2,
        null,
        { timeout: 20000 }
      );

      const stats = await pet.evaluate(() => window.__pet.speechStats);
      // **同时最多只播一段**：两段语音叠在一起的话，这里会是 2。
      expect(stats.maxConcurrent, '两段语音叠在一起播了').toBe(1);
      expect(stats.started, '两段语音没有都播').toBe(2);
    } finally {
      await app.close();
    }
  });
});
