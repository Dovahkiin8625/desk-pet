/**
 * 提示音：全部用 WebAudio **现场合成**，不引入任何音频素材。
 *
 * 为什么不放素材文件：桌宠的模型资源是官方样例（限非商业），
 * 而提示音是我们自己的功能，加 mp3/wav 只会多出一堆二进制要维护；
 * 合成几个正弦波则一行素材都不用。
 *
 * 模型自带的声音（Haru 的 TapBody 动作在 model3.json 里带 Sound 字段）
 * 由 pixi-live2d-display 的 SoundManager 播放，与这里互不干扰：
 * 那是「角色的台词」，这里是「界面反馈」。
 */

import { DEFAULT_VOLUME } from '../../shared/volume.js';
import { createSpeechQueue } from './speechQueue.js';

let ctx = null;
let enabled = true;
let masterGain = null;
// 总音量：提示音与桌宠说话共用一个值（设置窗口的「音量」滑块）。
let volume = DEFAULT_VOLUME;
// 语音实际连到了哪个节点（null = 还没播过）。
let speechTarget = null;

// 语音队列：一次只播一段（见 speechQueue.js）。
const speechQueue = createSpeechQueue();

// 语音的诊断计数：同时在播几段、同时最多到过几段。
// 「两次回复的语音叠在一起」这件事，只有这个计数器能证伪。
let speaking = 0;
let speechStarted = 0;
let speechFinished = 0;
let speechMaxConcurrent = 0;

/**
 * 语音播放的统计。
 *
 * @returns {{speaking: number, started: number, finished: number, maxConcurrent: number}}
 */
export function getSpeechStats() {
  return {
    speaking,
    started: speechStarted,
    finished: speechFinished,
    maxConcurrent: speechMaxConcurrent,
  };
}

function audioContext() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
    return null;
  }
  masterGain = ctx.createGain();
  masterGain.gain.value = volume;
  masterGain.connect(ctx.destination);
  return ctx;
}

/** 提示音总开关（设置里可关）。 */
export function setAudioEnabled(value) {
  enabled = Boolean(value);
}

export function isAudioEnabled() {
  return enabled;
}

/**
 * 设总音量。
 *
 * 提示音与语音都接在 masterGain 上，所以这一个值管住两种声音。
 * 语音原来直连 ac.destination —— 那条路绕过了主增益，
 * 于是「提示音有音量控制、桌宠说话没有」。总音量要成立就得把它接回来。
 */
export function setMasterVolume(value) {
  const n = typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : DEFAULT_VOLUME;
  volume = n;
  if (masterGain) masterGain.gain.value = n;
  return volume;
}

/** 当前总音量。 */
export function getMasterVolume() {
  return volume;
}

/**
 * 语音输出接到了哪个节点：'masterGain' / 'destination' / null（还没播过）。
 *
 * 有了它，「桌宠说话也受音量控制」才有可断言的出口——
 * 否则那只是一行 `source.connect(...)`，改了也没人看得出来。
 */
export function getSpeechOutput() {
  if (!speechTarget) return null;
  return speechTarget === masterGain ? 'masterGain' : 'destination';
}

/**
 * 合成一个短音。
 *
 * 参数刻意保守：音量小、时长短。桌宠是常驻在桌面上的，
 * 一声刺耳的「叮」会毁掉整个体验。
 */
function blip({
  freq = 660,
  duration = 0.12,
  type = 'sine',
  gain = 0.05,
  sweep = 0,
  delay = 0,
}) {
  if (!enabled) return;
  const ac = audioContext();
  if (!ac) return;
  // 浏览器可能因为还没有用户交互而挂起音频上下文：唤醒它，失败就算了。
  if (ac.state === 'suspended') ac.resume?.().catch(() => {});
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweep !== 0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + duration);
  }
  // 用指数衰减收尾，避免「嗒」的一声爆音。
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(env).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

/** 点击反馈：一声短促的「啵」。 */
export function playTap() {
  blip({ freq: 520, sweep: 360, duration: 0.1, type: 'sine', gain: 0.045 });
}

/** 成功反馈：两声上行的小铃音。 */
export function playSuccess() {
  blip({ freq: 880, duration: 0.12, type: 'triangle', gain: 0.05 });
  blip({ freq: 1320, duration: 0.16, type: 'triangle', gain: 0.045, delay: 0.1 });
}

/** 提醒/闹钟：三声钟响，音高下移，听起来像「铛——」。 */
export function playAlarm() {
  blip({ freq: 1046, duration: 0.22, type: 'sine', gain: 0.06 });
  blip({ freq: 880, duration: 0.24, type: 'sine', gain: 0.055, delay: 0.22 });
  blip({ freq: 784, duration: 0.34, type: 'sine', gain: 0.05, delay: 0.46 });
}

/** 出错/失败：一声低沉的闷响。 */
export function playError() {
  blip({ freq: 220, sweep: -80, duration: 0.22, type: 'sawtooth', gain: 0.035 });
}

/**
 * 播放合成好的语音，并把响度包络交给回调（用来驱动口型）。
 *
 * 口型不是靠「正在播放」这个布尔值做的——那样嘴会一开一合地抽搐；
 * 要按**每一刻的响度**来动，嘴才会跟着语音的开合走。
 *
 * **一次只播一段**：后来的语音排在前面那段播完之后（见 speechQueue.js）。
 * 不排的话，前台回复还没念完，后台那件事做完又报一句，两句话叠在一起。
 *
 * @param {Uint8Array|Buffer} bytes MP3 字节
 * @param {(amplitude: number) => void} onAmplitude 每帧回调，0..1
 * @returns {Promise<void>} 这一段播完（或播不成）时兑现
 */
export function playSpeech(bytes, onAmplitude) {
  return speechQueue.run(() => playSpeechNow(bytes, onAmplitude));
}

/** 真正播一段语音（队列内部用）。 */
async function playSpeechNow(bytes, onAmplitude) {
  const ac = audioContext();
  if (!ac || !bytes || bytes.length === 0) return;
  if (ac.state === 'suspended') {
    try {
      await ac.resume();
    } catch {
      /* 恢复不了就当没声音 */
    }
  }

  let decoded;
  try {
    // decodeAudioData 需要一个**独立的** ArrayBuffer：
    // 直接把 Buffer 的底层 buffer 丢过去会连带整个视图，Chromium 会拒绝。
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    decoded = await ac.decodeAudioData(copy);
  } catch (err) {
    console.warn('[desk-pet] 语音解码失败：', err?.message || err);
    onAmplitude?.(0);
    return;
  }

  const envelope = computeEnvelope(decoded);
  const source = ac.createBufferSource();
  source.buffer = decoded;
  // 接主增益，不接 destination：不然语音不受总音量控制。
  //
  // 连什么、记什么必须是同一件事——所以把赋值写在 connect 的参数里。
  //
  // 写成两个平行表达式（connect 一行、诊断一行）的话，将来有人只改了
  // connect 那行，诊断位还报 'masterGain'，那条 e2e 就挡不住它本该挡的回归。
  // 写成这样之后：connect 的参数一旦不是 masterGain，speechTarget 就不会被赋值，
  // 诊断位停在 null，e2e 立刻红。
  source.connect((speechTarget = masterGain || ac.destination));
  const startedAt = ac.currentTime;
  let stopped = false;
  // 计数：这一段开始播了。
  speaking += 1;
  speechStarted += 1;
  speechMaxConcurrent = Math.max(speechMaxConcurrent, speaking);
  // **播完才 resolve**：主进程在等这个信号——
  // 「先应一声」要等应答念完，才把答案气泡放出来。
  let guard = null;
  let settled = false;
  const finished = new Promise((resolve) => {
    const done = () => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      stopped = true;
      onAmplitude?.(0);
      resolve();
    };
    source.onended = done;
    // 兜底：音频上下文被挂起时 onended 可能永远不来。
    // 那样这一段会一直占着队列，后面的语音都发不出声——
    // 所以到点就把这一段掐掉，让队列往前走。
    guard = setTimeout(() => {
      try {
        source.stop();
      } catch {
        /* 已经停了 */
      }
      done();
    }, (decoded.duration + 1) * 1000);
  });
  source.start();

  const tick = () => {
    if (stopped) return;
    const t = ac.currentTime - startedAt;
    onAmplitude?.(sampleEnvelope(envelope, t));
    if (t < decoded.duration) requestAnimationFrame(tick);
    else onAmplitude?.(0);
  };
  requestAnimationFrame(tick);

  try {
    await finished;
  } finally {
    speaking -= 1;
    speechFinished += 1;
  }
}

/**
 * 算音频的响度包络。
 *
 * 每 20 毫秒一帧，取该帧的 RMS。
 * 语音的响度变化比「有声音/没声音」丰富得多，
 * 而 RMS 比峰值更接近人耳对响度的感受（峰值容易被瞬态拉高）。
 */
export function computeEnvelope(audioBuffer, frameSeconds = 0.02) {
  const frameSize = Math.max(1, Math.round(audioBuffer.sampleRate * frameSeconds));
  const channel = audioBuffer.getChannelData(0);
  const frames = Math.max(1, Math.ceil(channel.length / frameSize));
  const envelope = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f += 1) {
    const start = f * frameSize;
    const end = Math.min(channel.length, start + frameSize);
    let sum = 0;
    for (let i = start; i < end; i += 1) {
      sum += channel[i] * channel[i];
    }
    const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
    envelope[f] = rms;
    if (rms > peak) peak = rms;
  }
  // 归一化：安静的录音也要有明显的口型起伏。
  if (peak > 0) {
    for (let f = 0; f < frames; f += 1) envelope[f] /= peak;
  }
  return envelope;
}

/** 按时间查包络（线性插值）。 */
export function sampleEnvelope(envelope, seconds) {
  if (!envelope || envelope.length === 0) return 0;
  const frameSeconds = 0.02;
  const pos = seconds / frameSeconds;
  const i = Math.floor(pos);
  if (i < 0) return envelope[0];
  if (i >= envelope.length - 1) return envelope[envelope.length - 1] || 0;
  const frac = pos - i;
  return envelope[i] * (1 - frac) + envelope[i + 1] * frac;
}
