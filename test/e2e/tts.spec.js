import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchWithMenuProbe, collectErrors } from './helpers.js';

/**
 * 语音播报（MiniMax TTS）与口型同步。
 *
 * 这里**不打真实接口**：本地起一个桩服务冒充 MiniMax，
 * 返回一段真实可解码的 WAV（hex 编码，与接口的格式一致）。
 * 真实接口只在人工验证时用一次。
 */

/** 造一段 0.5 秒的单声道正弦波 WAV（16 位 8kHz）。 */
function makeWav(seconds = 0.5, sampleRate = 8000) {
  const samples = Math.floor(seconds * sampleRate);
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
    const v = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** 起一个假的 MiniMax 服务。 */
async function startStubTts() {
  const wavHex = makeWav().toString('hex');
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: { audio: wavHex, status: 2 },
          extra_info: { audio_length: 500, audio_format: 'mp3' },
          base_resp: { status_code: 0, status_msg: 'success' },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('语音能合成、送到渲染层播放，并驱动口型', async () => {
  const stub = await startStubTts();
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-tts-'));
  const userDataDir = join(dir, 'userData');
  await mkdir(userDataDir, { recursive: true });
  // 预置：语音开着，域名指向桩服务。
  await writeFile(
    join(userDataDir, 'assistant.json'),
    JSON.stringify({
      version: 1,
      tts: { enabled: true, voiceId: 'female-shaonv', model: 'speech-02-hd', host: stub.url },
    }),
    'utf8'
  );

  const ctx = await launchWithMenuProbe({
    userDataDir,
    env: {
      MINIMAX_API_KEY: 'sk-test-local-stub',
      DESK_PET_TTS_HOSTS: stub.url,
    },
  });
  const errors = collectErrors(ctx.win);
  try {
    // 启动问候语会在 3 秒后触发一次语音合成。
    await ctx.win.waitForFunction(() => window.__pet.speechCount > 0, null, { timeout: 20000 });

    const state = await ctx.win.evaluate(() => ({
      speechCount: window.__pet.speechCount,
      lastSpeechBytes: window.__pet.lastSpeechBytes,
    }));
    expect(state.speechCount, '应当收到一段语音').toBeGreaterThan(0);
    expect(state.lastSpeechBytes, '语音内容不应当是空的').toBeGreaterThan(1000);

    // 桩服务确实被调用了，且带了 Bearer 认证头。
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests[0].url).toContain('/v1/t2a_v2');
    expect(stub.requests[0].auth).toBe('Bearer sk-test-local-stub');

    // 口型：播放期间幅度要动过。
    await ctx.win.waitForFunction(() => window.__pet.mouthAmplitude > 0, null, { timeout: 10000 });
    const mouth = await ctx.win.evaluate(() => window.__pet.mouthAmplitude);
    expect(mouth).toBeGreaterThan(0);

    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('语音没开时不合成任何东西', async () => {
  const stub = await startStubTts();
  const ctx = await launchWithMenuProbe({
    env: {
      MINIMAX_API_KEY: 'sk-test-local-stub',
      DESK_PET_TTS_HOSTS: stub.url,
    },
  });
  try {
    // 等过启动问候语的时间点。
    await new Promise((r) => setTimeout(r, 6000));
    const count = await ctx.win.evaluate(() => window.__pet.speechCount);
    expect(count, '语音没开时不该合成').toBe(0);
    expect(stub.requests.length, '语音没开时不该请求接口').toBe(0);
  } finally {
    await ctx.close();
    await stub.close();
  }
});

test('桌宠说话接在主增益上，所以它也受总音量控制', async () => {
  const stub = await startStubTts();
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-tts-'));
  const userDataDir = join(dir, 'userData');
  await mkdir(userDataDir, { recursive: true });
  // 预置：语音开着，域名指向桩服务，音量调到 0.3。
  await writeFile(
    join(userDataDir, 'assistant.json'),
    JSON.stringify({
      version: 1,
      tts: { enabled: true, voiceId: 'female-shaonv', model: 'speech-02-hd', host: stub.url },
      sound: { enabled: true, volume: 0.3 },
    }),
    'utf8'
  );

  const ctx = await launchWithMenuProbe({
    userDataDir,
    env: {
      MINIMAX_API_KEY: 'sk-test-local-stub',
      DESK_PET_TTS_HOSTS: stub.url,
    },
  });
  try {
    // 音量到了渲染层。
    await ctx.win.waitForFunction(() => window.__pet.volume === 0.3, null, { timeout: 10000 });

    // 语音**接在主增益上**，而不是直接接扬声器——
    // 接错了的话「桌宠说话」这一路就不受音量控制。
    await ctx.win.waitForFunction(
      () => window.__pet.speechOutput === 'masterGain',
      null,
      { timeout: 20000 },
    );
  } finally {
    await ctx.close();
    await stub.close();
    await rm(dir, { recursive: true, force: true });
  }
});
