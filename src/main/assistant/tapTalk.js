import { join } from 'node:path';
import { synthesizeCached } from './tts/minimax.js';
import { pickTapLine } from '../../shared/tapVoice.js';

/**
 * 点桌宠时念的台词：**预先**合成好，点击时只读缓存。
 *
 * 为什么不用现成的「消息语音」那条路：那条路每次都要走一遍
 * `synthesizeCached`——虽然命中缓存时不会打接口，但点击那一刻
 * 还要等一次磁盘读；台词这种**高频**的东西该在空闲时就备好。
 *
 * 缓存目录与消息语音的分开（`tts-cache` vs `tts-cache/tap`）：
 * 消息语音的缓存会被 `pruneCache` 按「最新的 100 个」清理，
 * 台词音频是启动时生成的老文件——混在一起会被当成旧文件删掉。
 *
 * 这个模块**不引 electron**：`assistant/index.js` 引了（剪贴板、电源事件），
 * 在纯 node 的单元测试里 import 不了。台词这件事要能单测，就得独立。
 */

/** 台词音频的缓存目录。 */
export function tapCacheDir(userDataDir) {
  return join(userDataDir, 'tts-cache', 'tap');
}

/**
 * 预先把台词合成好。
 *
 * 已经是缓存里的直接跳过（`synthesizeCached` 自己会读缓存，
 * 命中时**不**打接口）。某一句失败只记一笔，不影响其它句，
 * 也不抛错——预生成是后台的活，不该把整个应用带崩。
 *
 * @returns {Promise<{generated: number, cached: number, failed: number}>}
 */
export async function prewarmTapAudio({
  lines = [],
  tts = {},
  cacheDir = '',
  fetchImpl = fetch,
  hosts,
  concurrency = 2,
  onError,
} = {}) {
  const result = { generated: 0, cached: 0, failed: 0 };
  const usable = (Array.isArray(lines) ? lines : []).filter(
    (l) => typeof l === 'string' && l.trim() !== ''
  );
  // 没有台词、没有缓存目录、没有 Key：没什么可做的。
  if (usable.length === 0 || !cacheDir || !tts.apiKey) return result;

  const queue = [...usable];
  const worker = async () => {
    while (queue.length > 0) {
      const text = queue.shift();
      try {
        const r = await synthesizeCached(
          {
            text,
            apiKey: tts.apiKey,
            voiceId: tts.voiceId,
            model: tts.model,
            speed: tts.speed,
            vol: tts.vol,
            pitch: tts.pitch,
          },
          { cacheDir, fetchImpl, hosts }
        );
        if (r?.cached) result.cached += 1;
        else result.generated += 1;
      } catch (err) {
        result.failed += 1;
        onError?.(err, text);
      }
    }
  };

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return result;
}

/**
 * 「点桌宠时念台词」这件事。
 *
 * @param {object} deps
 * @param {() => object} deps.getState  助理状态
 * @param {(text: string, options: object) => void} deps.say  说一句话（气泡 + 语音）
 * @param {string} deps.userDataDir
 * @param {() => Promise<string|null>} deps.loadApiKey  读 key
 * @param {(tts: object) => string[]} deps.resolveHosts  TTS 域名顺序
 * @param {typeof fetch} deps.fetchImpl
 * @param {(err: Error, text: string) => void} deps.onError
 */
export function createTapTalk({
  getState,
  say,
  userDataDir,
  loadApiKey,
  resolveHosts,
  fetchImpl = fetch,
  onError,
} = {}) {
  /**
   * 预先把台词合成好（后台，不阻塞启动）。
   *
   * 台词音频是**事先**备好的：点桌宠时要立刻出声，
   * 不能等一次网络往返。缓存键是内容哈希（台词+音色+语速+音量+音高），
   * 所以换了音色会自动重生成——旧文件自然作废。
   */
  async function prewarm() {
    const state = getState?.();
    const tapTalk = state?.tapTalk;
    if (!tapTalk?.enabled || !state?.tts?.enabled) return;
    const lines = Array.isArray(tapTalk.lines) ? tapTalk.lines : [];
    if (lines.length === 0) return;
    const apiKey = await loadApiKey?.();
    if (!apiKey) return;
    const tts = state.tts;
    try {
      const r = await prewarmTapAudio({
        lines,
        tts: {
          apiKey,
          voiceId: tts.voiceId,
          model: tts.model,
          speed: tts.speed,
          vol: tts.vol,
          pitch: tts.pitch,
        },
        cacheDir: tapCacheDir(userDataDir),
        fetchImpl,
        hosts: resolveHosts?.(tts),
        onError: (err, text) => onError?.(err, text),
      });
      if (r.generated > 0) {
        console.log(`[desk-pet] 台词语音预生成：新增 ${r.generated} 句，命中缓存 ${r.cached} 句`);
      }
    } catch (err) {
      onError?.(err, '');
    }
  }

  /**
   * 点桌宠：念一句台词。
   *
   * 只负责挑一句并让它走现成的那条语音通道（气泡 + 口型同步）；
   * 音频本身是**预先**合成好的（见 prewarm），所以这里读的是缓存——
   * 没有接口调用，也没有等待。
   */
  function tapTalk() {
    const state = getState?.();
    if (!state?.tapTalk?.enabled) return { ok: false, reason: 'disabled' };
    if (!state?.tts?.enabled) return { ok: false, reason: 'tts-off' };
    const lines = Array.isArray(state.tapTalk.lines) ? state.tapTalk.lines : [];
    const text = pickTapLine(lines);
    if (!text) return { ok: false, reason: 'no-lines' };
    // 气泡摆在脚下：点桌宠时插件面板在头顶，两者不重叠。
    say(text, {
      speak: true,
      showBubble: true,
      side: 'bottom',
      cacheDir: tapCacheDir(userDataDir),
    });
    return { ok: true, text };
  }

  return { prewarm, tapTalk };
}
