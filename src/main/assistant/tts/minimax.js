import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TTS_HOSTS } from '../../../shared/assistant.js';

/**
 * MiniMax 语音合成（T2A v2）客户端。
 *
 * 接口形态：
 *   POST {host}/v1/t2a_v2
 *   Authorization: Bearer <API_KEY>
 *   { model, text, stream:false, voice_setting:{...}, audio_setting:{...}, output_format:"hex" }
 *
 * 三个容易踩的坑：
 *
 * 1. **HTTP 200 不等于成功**：真正的状态码在 `base_resp.status_code` 里，
 *    不为 0 就是失败（1004 = 鉴权失败，1002 = 限流，2013 = 参数非法）。
 * 2. **音频是 hex 字符串**：`data.audio` 是一串十六进制，
 *    要 `Buffer.from(hex, 'hex')` 才是 MP3 字节。直接当 base64 解会得到垃圾。
 * 3. **域名不唯一**：`minimaxi` 是中国大陆、`minimax` 是国际，
 *    同一个 key 在不同账号下能用的域名不一定相同——所以要探测，不要写死。
 */

/** 接口的错误码里，我们真正需要区分的几个。 */
export const TTS_ERRORS = Object.freeze({
  TIMEOUT: 1001,
  RATE_LIMIT: 1002,
  AUTH: 1004,
  TPM_LIMIT: 1039,
  ILLEGAL_CHARACTERS: 1042,
  INVALID_PARAMS: 2013,
  // 「音色 id 不存在」：接口**收到了**请求，只是这个音色没有。
  // 它是请求级错误——换域名也不会有别的音色。
  VOICE_NOT_EXIST: 2054,
});

export class TtsError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.status = status;
  }
}

/** 组装请求体。 */
export function buildRequestBody({
  text,
  voiceId,
  model = 'speech-02-hd',
  speed = 1,
  vol = 1,
  pitch = 0,
  emotion = '',
} = {}) {
  const body = {
    model,
    text: String(text ?? ''),
    stream: false,
    voice_setting: {
      voice_id: voiceId || '',
      speed,
      vol,
      pitch,
    },
    language_boost: 'Chinese',
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
    output_format: 'hex',
  };
  // emotion 只有部分模型支持；传一个模型不认的字段会让整个请求失败。
  if (emotion) body.voice_setting.emotion = emotion;
  return body;
}

/**
 * 调用一次接口合成语音。
 *
 * @returns {Promise<{audio: Buffer, mime: string, durationMs: number|null}>}
 */
export async function synthesize(
  { text, apiKey, host, voiceId, model, speed, vol, pitch },
  fetchImpl = fetch,
) {
  if (!apiKey) throw new TtsError('没有配置 API Key');
  if (!host) throw new TtsError('没有可用的接口域名');
  if (!String(text ?? '').trim()) throw new TtsError('没有要合成的文本');

  let res;
  try {
    res = await fetchImpl(`${host}/v1/t2a_v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody({ text, voiceId, model, speed, vol, pitch })),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    // 网络错误/超时：消息里不要带 key。
    throw new TtsError(`请求失败：${err?.message || err}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TtsError(`接口返回 HTTP ${res.status}`, { status: res.status, body });
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new TtsError(`接口返回的不是 JSON：${err?.message || err}`);
  }

  const code = data?.base_resp?.status_code;
  if (code !== 0) {
    const msg = data?.base_resp?.status_msg || `接口返回错误码 ${code}`;
    throw new TtsError(msg, { code });
  }

  const hex = data?.data?.audio;
  if (typeof hex !== 'string' || hex === '') {
    throw new TtsError('接口没有返回音频');
  }
  const audio = Buffer.from(hex, 'hex');
  if (audio.length === 0) throw new TtsError('音频内容为空');

  return {
    audio,
    mime: data?.extra_info?.audio_format || 'mp3',
    durationMs: Number.isFinite(data?.extra_info?.audio_length) ? data.extra_info.audio_length : null,
    traceId: data?.trace_id || null,
  };
}

/**
 * 依次探测域名，返回第一个能用的。
 *
 * 哪些错误值得换域名再试：
 * - **鉴权失败（1004）**：key 是**分区域**的（大陆 key 在国际域名上会失败），
 *   换个域名说不定就对了——要继续试。
 * - **网络错误 / HTTP 错误**：这个域名不通，换一个。
 * - **瞬时错误（1xxx：超时 1001、限流 1002、TPM 上限 1039）**：
 *   这个域名现在不伺候我们，换一个可能就通了——也继续试。
 * - **请求级错误（2xxx，如 2054 音色 id 不存在）**：接口已经收到并处理了请求，
 *   只是内容有问题。换域名也是同样的结果——立刻失败，把错误原样报给用户。
 */
export async function synthesizeWithProbe(params, { fetchImpl = fetch, hosts = TTS_HOSTS } = {}) {
  const tried = [];
  for (const host of hosts) {
    try {
      const result = await synthesize({ ...params, host }, fetchImpl);
      return { ...result, host };
    } catch (err) {
      tried.push(`${host}（${err?.message || err}）`);
      // 2xxx 才是「请求本身有问题」：换域名不会有别的结果。
      if (err instanceof TtsError && typeof err.code === 'number' && err.code >= 2000) {
        throw err;
      }
    }
  }
  throw new TtsError(`没有可用的接口域名：${tried.join('；')}`);
}

/** 缓存键：同一段文本 + 同一套音色参数 → 同一个音频。 */
export function cacheKey({ text, voiceId, model, speed, vol, pitch } = {}) {
  return createHash('sha256')
    .update([text, voiceId, model, speed, vol, pitch].join('|'))
    .digest('hex');
}

/**
 * 缓存目录里的文件太多就删掉最老的。
 *
 * 不限量的话，缓存会随着使用一直涨——每条不同的报时都是一份新文件。
 */
export async function pruneCache(dir, maxFiles = 100) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const files = entries.filter((f) => f.endsWith('.mp3'));
  if (files.length <= maxFiles) return;
  const withTime = [];
  for (const f of files) {
    const full = join(dir, f);
    try {
      const s = await stat(full);
      withTime.push({ full, mtime: s.mtimeMs });
    } catch {
      /* 文件可能刚好被删了 */
    }
  }
  withTime.sort((a, b) => a.mtime - b.mtime);
  const excess = withTime.slice(0, withTime.length - maxFiles);
  for (const f of excess) {
    await unlink(f.full).catch(() => {});
  }
}

/**
 * 合成并缓存。
 *
 * 缓存是按内容哈希存的：报时是每小时同一句话，
 * 缓存命中就不用每次都花一次接口调用与一份流量。
 */
export async function synthesizeCached(params, { cacheDir, fetchImpl = fetch, hosts } = {}) {
  if (cacheDir) {
    const key = cacheKey(params);
    const file = join(cacheDir, `${key}.mp3`);
    try {
      const data = await readFile(file);
      if (data.length > 0) {
        return { audio: data, mime: 'mp3', cached: true, host: params.host || '' };
      }
    } catch {
      /* 没有缓存，继续合成 */
    }
    const result = await synthesizeWithProbe(params, { fetchImpl, hosts });
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(file, result.audio);
      await pruneCache(cacheDir);
    } catch {
      // 缓存写不进去不影响合成结果——只是下次还要再合成一次。
    }
    return { ...result, cached: false };
  }
  return synthesizeWithProbe(params, { fetchImpl, hosts });
}
