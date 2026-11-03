import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TTS_ERRORS,
  TtsError,
  buildRequestBody,
  cacheKey,
  pruneCache,
  synthesize,
  synthesizeCached,
  synthesizeWithProbe,
} from '../../src/main/assistant/tts/minimax.js';

/** 造一个假的 fetch：返回指定的响应，并记录被调用了几次。 */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init?.body || '{}') });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch 没有更多响应了');
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status || 200,
      json: async () => next.json,
      text: async () => JSON.stringify(next.json || {}),
    };
  };
  impl.calls = calls;
  return impl;
}

/** 一份成功的响应：data.audio 是 hex（这里是 'deadbeef' → 4 字节）。 */
function okResponse(hex = 'deadbeef') {
  return {
    json: {
      data: { audio: hex, status: 2 },
      extra_info: { audio_length: 2520, audio_format: 'mp3' },
      trace_id: 'trace-1',
      base_resp: { status_code: 0, status_msg: 'success' },
    },
  };
}

test('请求体的形状', () => {
  const body = buildRequestBody({
    text: '你好',
    voiceId: 'female-shaonv',
    model: 'speech-02-hd',
    speed: 1.2,
    vol: 1,
    pitch: 0,
  });
  assert.equal(body.model, 'speech-02-hd');
  assert.equal(body.text, '你好');
  assert.equal(body.stream, false);
  assert.equal(body.voice_setting.voice_id, 'female-shaonv');
  assert.equal(body.voice_setting.speed, 1.2);
  assert.equal(body.audio_setting.format, 'mp3');
  assert.equal(body.output_format, 'hex');
  // 没给 emotion 时**不**带这个字段：
  // 有些模型不认它，带上去会让整个请求失败。
  assert.equal('emotion' in body.voice_setting, false);
});

test('给了 emotion 才带上它', () => {
  const body = buildRequestBody({ text: 'x', voiceId: 'v', emotion: 'happy' });
  assert.equal(body.voice_setting.emotion, 'happy');
});

test('音频是 hex 字符串，要解码成字节', () => {
  // 这是最容易踩的坑：把 hex 当 base64 解会得到一堆垃圾。
  const body = buildRequestBody({ text: 'x', voiceId: 'v' });
  assert.equal(body.output_format, 'hex');
});

test('合成成功：hex 解码成字节', async () => {
  const fetchImpl = fakeFetch([okResponse('deadbeef')]);
  const r = await synthesize(
    { text: '你好', apiKey: 'sk-test', host: 'https://api.minimaxi.com', voiceId: 'v' },
    fetchImpl
  );
  assert.equal(r.audio.length, 4);
  assert.equal(r.audio.toString('hex'), 'deadbeef');
  assert.equal(r.mime, 'mp3');
  assert.equal(r.durationMs, 2520);
  // 认证头要用 Bearer
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.match(fetchImpl.calls[0].url, /\/v1\/t2a_v2$/);
});

test('HTTP 200 不等于成功：base_resp 里的错误码才算数', async () => {
  const fetchImpl = fakeFetch([
    { json: { base_resp: { status_code: 1004, status_msg: 'login fail' } } },
  ]);
  await assert.rejects(
    () =>
      synthesize(
        { text: 'x', apiKey: 'bad', host: 'https://api.minimaxi.com', voiceId: 'v' },
        fetchImpl
      ),
    (err) => {
      assert.ok(err instanceof TtsError);
      assert.equal(err.code, TTS_ERRORS.AUTH);
      return true;
    }
  );
});

test('音色不存在时给出对应的错误码', async () => {
  const fetchImpl = fakeFetch([
    { json: { base_resp: { status_code: 2054, status_msg: 'voice id not exist' } } },
  ]);
  await assert.rejects(
    () =>
      synthesize(
        { text: 'x', apiKey: 'k', host: 'https://api.minimaxi.com', voiceId: 'nope' },
        fetchImpl
      ),
    (err) => {
      assert.equal(err.code, TTS_ERRORS.VOICE_NOT_EXIST);
      return true;
    }
  );
});

test('HTTP 错误也要报出来', async () => {
  const fetchImpl = fakeFetch([{ status: 500, json: {} }]);
  await assert.rejects(
    () =>
      synthesize(
        { text: 'x', apiKey: 'k', host: 'https://api.minimaxi.com', voiceId: 'v' },
        fetchImpl
      ),
    (err) => {
      assert.equal(err.status, 500);
      return true;
    }
  );
});

test('没有 key / 没有域名 / 没有文本都要拒绝', async () => {
  await assert.rejects(
    () => synthesize({ text: 'x', apiKey: '', host: 'h', voiceId: 'v' }, fakeFetch([])),
    /没有配置 API Key/
  );
  await assert.rejects(
    () => synthesize({ text: 'x', apiKey: 'k', host: '', voiceId: 'v' }, fakeFetch([])),
    /没有可用的接口域名/
  );
  await assert.rejects(
    () => synthesize({ text: '  ', apiKey: 'k', host: 'h', voiceId: 'v' }, fakeFetch([])),
    /没有要合成的文本/
  );
});

test('域名探测：第一个能用的就返回它', async () => {
  const fetchImpl = fakeFetch([{ throw: 'connect ECONNREFUSED' }, okResponse()]);
  const r = await synthesizeWithProbe(
    { text: 'x', apiKey: 'k', voiceId: 'v' },
    { fetchImpl, hosts: ['https://a.example', 'https://b.example'] }
  );
  assert.equal(r.host, 'https://b.example');
  assert.equal(fetchImpl.calls.length, 2);
});

test('域名探测：请求级错误（音色不存在）不再换域名', async () => {
  // 接口已经答复了「音色 id 不存在」——换域名也是同样的结果。
  const fetchImpl = fakeFetch([
    { json: { base_resp: { status_code: 2054, status_msg: 'voice id not exist' } } },
  ]);
  await assert.rejects(
    () =>
      synthesizeWithProbe(
        { text: 'x', apiKey: 'k', voiceId: 'nope' },
        { fetchImpl, hosts: ['https://a.example', 'https://b.example'] }
      ),
    (err) => {
      assert.equal(err.code, TTS_ERRORS.VOICE_NOT_EXIST);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1, '请求级错误不该再试别的域名');
});

test('域名探测：鉴权失败要继续换域名', async () => {
  // key 是分区域的：大陆 key 在国际域名上会鉴权失败，换一个就对了。
  const fetchImpl = fakeFetch([
    { json: { base_resp: { status_code: 1004, status_msg: 'login fail' } } },
    okResponse(),
  ]);
  const r = await synthesizeWithProbe(
    { text: 'x', apiKey: 'k', voiceId: 'v' },
    { fetchImpl, hosts: ['https://a.example', 'https://b.example'] }
  );
  assert.equal(r.host, 'https://b.example');
  assert.equal(fetchImpl.calls.length, 2);
});

test('所有域名都不可用时给出可读的错误', async () => {
  const fetchImpl = fakeFetch([{ throw: 'boom' }, { throw: 'boom' }]);
  await assert.rejects(
    () =>
      synthesizeWithProbe(
        { text: 'x', apiKey: 'k', voiceId: 'v' },
        { fetchImpl, hosts: ['https://a.example', 'https://b.example'] }
      ),
    /没有可用的接口域名/
  );
});

test('缓存键由文本与音色参数决定', () => {
  const a = cacheKey({ text: '你好', voiceId: 'v', model: 'm', speed: 1, vol: 1, pitch: 0 });
  const b = cacheKey({ text: '你好', voiceId: 'v', model: 'm', speed: 1, vol: 1, pitch: 0 });
  const c = cacheKey({ text: '你好', voiceId: 'other', model: 'm', speed: 1, vol: 1, pitch: 0 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('缓存命中时不再请求接口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-tts-'));
  try {
    const fetchImpl = fakeFetch([okResponse('aabbccdd')]);
    const params = { text: '你好', apiKey: 'k', voiceId: 'v', model: 'm', speed: 1, vol: 1, pitch: 0 };
    const first = await synthesizeCached(params, { cacheDir: dir, fetchImpl, hosts: ['https://a'] });
    assert.equal(first.cached, false);
    assert.equal(fetchImpl.calls.length, 1);

    // 第二次：同样的内容 → 命中缓存，不再请求。
    const second = await synthesizeCached(params, { cacheDir: dir, fetchImpl, hosts: ['https://a'] });
    assert.equal(second.cached, true);
    assert.equal(second.audio.toString('hex'), 'aabbccdd');
    assert.equal(fetchImpl.calls.length, 1, '命中缓存时不该再调接口');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缓存目录超量时会删掉最老的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-pet-tts-'));
  try {
    // 造 5 个文件，mtime 递增。
    const { writeFile, utimes } = await import('node:fs/promises');
    for (let i = 0; i < 5; i += 1) {
      const file = join(dir, `f${i}.mp3`);
      await writeFile(file, 'x');
      await utimes(file, new Date(1000 + i * 1000), new Date(1000 + i * 1000));
    }
    await pruneCache(dir, 3);
    const left = (await readdir(dir)).filter((f) => f.endsWith('.mp3'));
    assert.equal(left.length, 3);
    // 最老的两个被删了
    assert.equal(left.includes('f0.mp3'), false);
    assert.equal(left.includes('f1.mp3'), false);
    assert.equal(left.includes('f4.mp3'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('域名探测：限流/超时这类瞬时错误要继续换域名', async () => {
  // 1002 = 限流、1001 = 超时：都是「这个域名现在不伺候我们」，
  // 换一个可能就通了——不能一遇到就放弃。
  const fetchImpl = fakeFetch([
    { json: { base_resp: { status_code: 1002, status_msg: 'rate limited' } } },
    { json: { base_resp: { status_code: 1001, status_msg: 'timeout' } } },
    okResponse(),
  ]);
  const r = await synthesizeWithProbe(
    { text: 'x', apiKey: 'k', voiceId: 'v' },
    { fetchImpl, hosts: ['https://a.example', 'https://b.example', 'https://c.example'] }
  );
  assert.equal(r.host, 'https://c.example');
  assert.equal(fetchImpl.calls.length, 3);
});

test('域名探测：只有 2xxx（请求级）错误才中止', async () => {
  // 2054 = 音色 id 不存在：接口答复了，换域名也是同样的结果。
  const fetchImpl = fakeFetch([
    { json: { base_resp: { status_code: 2054, status_msg: 'voice id not exist' } } },
  ]);
  await assert.rejects(
    () =>
      synthesizeWithProbe(
        { text: 'x', apiKey: 'k', voiceId: 'nope' },
        { fetchImpl, hosts: ['https://a.example', 'https://b.example'] }
      ),
    (err) => {
      assert.equal(err.code, TTS_ERRORS.VOICE_NOT_EXIST);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1);
});
