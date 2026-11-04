import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTapTalk, tapCacheDir } from '../../src/main/assistant/tapTalk.js';

/**
 * 「点桌宠念台词」的编排。
 *
 * 台词音频是**预先**合成好的：点击时读缓存，不调接口。
 * 这里验证的是接线——念哪一句、气泡摆哪边、音频从哪儿来。
 */

/** 一个假的 TTS 接口。 */
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

const TTS_STATE = {
  enabled: true,
  model: 'speech-02-hd',
  voiceId: 'female-shaonv',
  speed: 1,
  vol: 1,
  pitch: 0,
  host: '',
};

/** 摆一个临时的 userData 目录。 */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'desk-pet-taptalk-'));
}

/** 造一个「点桌宠念台词」的东西。 */
function makeTapTalk(state, { calls = [], said = [] } = {}) {
  const userDataDir = state.userDataDir;
  const tapTalker = createTapTalk({
    getState: () => state.state,
    say: (text, options) => said.push({ text, options }),
    userDataDir,
    loadApiKey: async () => 'test-key',
    resolveHosts: () => ['https://stub'],
    fetchImpl: fakeFetch(calls),
  });
  return { tapTalker, calls, said };
}

test('点桌宠：念一句台词，气泡摆在脚下，音频从台词自己的缓存目录来', async () => {
  const userDataDir = await tempDir();
  try {
    const state = {
      userDataDir,
      state: {
        tts: { ...TTS_STATE },
        tapTalk: { enabled: true, modelSound: false, lines: ['你好呀'] },
      },
    };
    const { tapTalker, said } = makeTapTalk(state);
    const result = tapTalker.tapTalk();
    assert.equal(result.ok, true);
    assert.equal(result.text, '你好呀');

    assert.equal(said.length, 1);
    assert.equal(said[0].text, '你好呀');
    assert.equal(said[0].options.side, 'bottom', '气泡要摆在脚下，别和面板重叠');
    assert.equal(said[0].options.speak, true);
    assert.equal(said[0].options.cacheDir, tapCacheDir(userDataDir));
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('点桌宠：台词从池子里随机挑一句', async () => {
  const userDataDir = await tempDir();
  try {
    const state = {
      userDataDir,
      state: {
        tts: { ...TTS_STATE },
        tapTalk: { enabled: true, modelSound: false, lines: ['一', '二', '三'] },
      },
    };
    const { tapTalker, said } = makeTapTalk(state);
    for (let i = 0; i < 20; i += 1) tapTalker.tapTalk();
    const texts = new Set(said.map((s) => s.text));
    assert.ok(texts.size > 1, '20 次不该次次都是同一句');
    for (const t of texts) assert.ok(['一', '二', '三'].includes(t));
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('预生成：台词音频落在台词自己的缓存目录里', async () => {
  const userDataDir = await tempDir();
  try {
    const state = {
      userDataDir,
      state: {
        tts: { ...TTS_STATE },
        tapTalk: { enabled: true, modelSound: false, lines: ['你好呀'] },
      },
    };
    const { tapTalker, calls } = makeTapTalk(state);
    await tapTalker.prewarm();
    assert.equal(calls.length, 1);
    const dir = tapCacheDir(userDataDir);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.mp3'));
    assert.equal(files.length, 1);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('预生成：语音总开关关着时不生成', async () => {
  const userDataDir = await tempDir();
  try {
    const state = {
      userDataDir,
      state: {
        tts: { ...TTS_STATE, enabled: false },
        tapTalk: { enabled: true, modelSound: true, lines: ['你好呀'] },
      },
    };
    const { tapTalker, calls } = makeTapTalk(state);
    await tapTalker.prewarm();
    assert.equal(calls.length, 0);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('点桌宠：语音总开关关着时不念（模型自带的声音照旧）', async () => {
  const userDataDir = await tempDir();
  try {
    const state = {
      userDataDir,
      state: {
        tts: { ...TTS_STATE, enabled: false },
        tapTalk: { enabled: true, modelSound: true, lines: ['你好呀'] },
      },
    };
    const { tapTalker, said } = makeTapTalk(state);
    const result = tapTalker.tapTalk();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'tts-off');
    assert.equal(said.length, 0);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('点桌宠：「点击桌宠时说话」关着时不念', async () => {
  const userDataDir = await tempDir();
  try {
    const state = {
      userDataDir,
      state: {
        tts: { ...TTS_STATE },
        tapTalk: { enabled: false, modelSound: true, lines: ['你好呀'] },
      },
    };
    const { tapTalker, said } = makeTapTalk(state);
    const result = tapTalker.tapTalk();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(said.length, 0);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('点桌宠：没有台词时不念', async () => {
  const userDataDir = await tempDir();
  try {
    const state = {
      userDataDir,
      state: {
        tts: { ...TTS_STATE },
        tapTalk: { enabled: true, modelSound: false, lines: [] },
      },
    };
    const { tapTalker, said } = makeTapTalk(state);
    const result = tapTalker.tapTalk();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-lines');
    assert.equal(said.length, 0);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
