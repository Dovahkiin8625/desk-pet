import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prewarmTapAudio, tapCacheDir } from '../../src/main/assistant/tapTalk.js';

/**
 * 台词音频的**预生成**。
 *
 * 点桌宠时要立刻出声，所以音频必须**事先**合成好放在缓存里；
 * 点击时只读本地文件，不再调接口。
 *
 * 缓存键是内容哈希（台词+音色+语速+音量+音高），
 * 所以换音色会自动作废重建——用户不用手动清缓存。
 */

/** 一个假的 TTS 接口：回一段固定的 hex 音频。 */
function fakeFetch(calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        base_resp: { status_code: 0, status_msg: '' },
        data: { audio: Buffer.from('fake-mp3-bytes').toString('hex') },
        extra_info: { audio_format: 'mp3', audio_length: 120 },
      }),
    };
  };
}

/** 一个总是失败的接口。 */
function failingFetch(calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        base_resp: { status_code: 1002, status_msg: '限流' },
      }),
    };
  };
}

const TTS = {
  apiKey: 'test-key',
  voiceId: 'female-shaonv',
  model: 'speech-02-hd',
  speed: 1,
  vol: 1,
  pitch: 0,
};

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'desk-pet-taptalk-'));
}

test('预生成：每句台词都合成出一个缓存文件', async () => {
  const dir = await tempDir();
  try {
    const calls = [];
    const result = await prewarmTapAudio({
      lines: ['你好', '世界'],
      tts: TTS,
      cacheDir: dir,
      fetchImpl: fakeFetch(calls),
      hosts: ['https://stub'],
    });
    assert.equal(result.generated, 2);
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 2);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.mp3'));
    assert.equal(files.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('预生成：已经缓存过的不会再调接口', async () => {
  const dir = await tempDir();
  try {
    const first = [];
    await prewarmTapAudio({
      lines: ['你好'],
      tts: TTS,
      cacheDir: dir,
      fetchImpl: fakeFetch(first),
      hosts: ['https://stub'],
    });
    assert.equal(first.length, 1);

    const second = [];
    const result = await prewarmTapAudio({
      lines: ['你好'],
      tts: TTS,
      cacheDir: dir,
      fetchImpl: fakeFetch(second),
      hosts: ['https://stub'],
    });
    assert.equal(second.length, 0, '缓存命中就不该再打接口');
    assert.equal(result.generated, 0);
    assert.equal(result.cached, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('预生成：换了音色就重新生成（缓存键跟着变）', async () => {
  const dir = await tempDir();
  try {
    const first = [];
    await prewarmTapAudio({
      lines: ['你好'],
      tts: TTS,
      cacheDir: dir,
      fetchImpl: fakeFetch(first),
      hosts: ['https://stub'],
    });

    const second = [];
    const result = await prewarmTapAudio({
      lines: ['你好'],
      tts: { ...TTS, voiceId: 'male-qn-qingse' },
      cacheDir: dir,
      fetchImpl: fakeFetch(second),
      hosts: ['https://stub'],
    });
    assert.equal(second.length, 1, '音色变了就该重新合成');
    assert.equal(result.generated, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('预生成：某一句失败不影响其它句，也不抛错', async () => {
  const dir = await tempDir();
  try {
    const calls = [];
    const result = await prewarmTapAudio({
      lines: ['会失败'],
      tts: TTS,
      cacheDir: dir,
      fetchImpl: failingFetch(calls),
      hosts: ['https://stub'],
    });
    assert.equal(result.failed, 1);
    assert.equal(result.generated, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('预生成：没有 Key 或没有台词时什么都不做', async () => {
  const dir = await tempDir();
  try {
    const calls = [];
    const noKey = await prewarmTapAudio({
      lines: ['你好'],
      tts: { ...TTS, apiKey: '' },
      cacheDir: dir,
      fetchImpl: fakeFetch(calls),
      hosts: ['https://stub'],
    });
    assert.equal(noKey.generated, 0);
    assert.equal(calls.length, 0);

    const noLines = await prewarmTapAudio({
      lines: [],
      tts: TTS,
      cacheDir: dir,
      fetchImpl: fakeFetch(calls),
      hosts: ['https://stub'],
    });
    assert.equal(noLines.generated, 0);
    assert.equal(calls.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缓存目录：台词的音频单独放一个目录', () => {
  assert.equal(tapCacheDir('/data'), join('/data', 'tts-cache', 'tap'));
});
