/**
 * 「点桌宠时的声音」的池子。
 *
 * 池子里有两种东西：
 * - **生成台词**：设置里那几行字，用设置中的音色**预先**合成好（见
 *   src/main/assistant/tapTalk.js），点击时读缓存播放，不调接口；
 * - **模型自带声音**：Live2D 动作里带的那个 wav（Haru 的 TapBody）。
 *
 * 为什么抽签在**渲染层**做：静音模型声音的决定必须赶在动作启动**之前**
 * ——第三方库是在 `startMotion()` 里**同步**读 `config.sound` 的
 * （第一个 await 之前），而动作是点击那一刻同步触发的。
 * 主进程来不及回话，所以渲染层必须自己抽。
 *
 * 因此这个文件是**纯逻辑**：主进程只负责把「池子里有什么」推给渲染层，
 * 渲染层照着这些参数抽签。两边共用同一份判定，免得各写一套算出不同结果。
 */

/** 台词最多几句。多了没必要——预生成要花接口调用，点击时也轮不到几句。 */
export const MAX_TAP_LINES = 20;

/** 每句台词最长多少字。太长的句子合成出来又慢又啰嗦。 */
export const MAX_TAP_LINE_LENGTH = 60;

/**
 * 两次「念台词」之间的最小间隔（毫秒）。
 *
 * 连点的时候不念第二句：语音会叠在一起，而且缓存命中也得等上一句播完。
 */
export const TAP_VOICE_COOLDOWN_MS = 3000;

/**
 * 把设置窗口文本框里的内容解析成台词数组。
 *
 * 一行一句；去掉首尾空白与空行；重复的只留第一句。
 */
export function parseTapLines(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim().slice(0, MAX_TAP_LINE_LENGTH);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= MAX_TAP_LINES) break;
  }
  return out;
}

/** 从池子里挑一句。 */
export function pickTapLine(lines, random = Math.random) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const index = Math.floor(random() * lines.length);
  // random() 理论上不会返回 1，但越界了也不能取到 undefined。
  const safe = Math.min(Math.max(index, 0), lines.length - 1);
  return lines[safe] || '';
}

/**
 * 这一次点击该出什么声。
 *
 * **模型自带的声音是兜底**：只有生成的语音顶上来时，它才可能被替换掉。
 * 没配 Key、语音没开、台词为空——这些情况下桌宠的行为和这个功能
 * 存在之前一模一样（模型自己出声），不让用户平白少一个声音。
 *
 * @param {object} opts
 * @param {boolean} opts.voiceEnabled 能不能念生成台词（语音开着、有 Key、开关开着）
 * @param {boolean} opts.modelSound   模型自带的声音是否**加进**随机池
 * @param {number} opts.lineCount     池子里生成台词的条数
 * @param {number} opts.cooldownMs    冷却时长
 * @param {number} opts.now           当前时刻
 * @param {number|null} opts.lastVoiceAt 上一次触发念台词的时刻（null = 从来没念过）
 * @param {() => number} opts.random  随机源（测试里换成确定性的）
 * @returns {'voice'|'model'|'none'} 念台词 / 让模型自己出声 / 不出声
 */
export function decideTapVoice({
  voiceEnabled = false,
  modelSound = false,
  lineCount = 0,
  cooldownMs = TAP_VOICE_COOLDOWN_MS,
  now = 0,
  lastVoiceAt = null,
  random = Math.random,
} = {}) {
  // 生成的语音顶不上来（没 Key / 语音没开 / 没有台词）：
  // 桌宠照旧用模型自带的声音——这个功能不该让人平白少一个声音。
  if (!voiceEnabled || lineCount <= 0) return 'model';

  // 冷却期内不念台词：语音会叠在一起。
  if (Number.isFinite(lastVoiceAt) && now - lastVoiceAt < cooldownMs) {
    return modelSound ? 'model' : 'none';
  }

  // 等概率抽：N 句台词 + （开着的话）模型自带声音 1 项。
  const chance = modelSound ? 1 / (lineCount + 1) : 0;
  if (chance > 0 && random() < chance) return 'model';
  return 'voice';
}

/**
 * 改动之后要不要重新预生成台词音频。
 *
 * 缓存键是「台词+音色+语速+音量+音高」的内容哈希，
 * 所以这五样里任何一样变了，缓存就作废了，得重新生成。
 *
 * 「模型自带的声音」开关**不在其中**：它只影响抽签，不影响音频。
 */
export function tapTalkNeedsPrewarm(before = {}, after = {}) {
  const b = before.tts || {};
  const a = after.tts || {};
  if (
    b.voiceId !== a.voiceId ||
    b.model !== a.model ||
    b.speed !== a.speed ||
    b.vol !== a.vol ||
    b.pitch !== a.pitch
  ) {
    return true;
  }
  const bt = before.tapTalk || {};
  const at = after.tapTalk || {};
  if (bt.enabled !== at.enabled) return true;
  const bl = Array.isArray(bt.lines) ? bt.lines : [];
  const al = Array.isArray(at.lines) ? at.lines : [];
  return bl.length !== al.length || bl.some((line, i) => line !== al[i]);
}

/**
 * 主进程推给渲染层的「池子成分」。
 *
 * 渲染层照着它抽签——所以这里算出来的每个字段都必须与渲染层用到的
 * 一致：台词条数、模型声音在不在、能不能念、冷却多长。
 */
export function buildTapVoicePayload({
  tapTalk = null,
  ttsEnabled = false,
  hasKey = false,
  cooldownMs = TAP_VOICE_COOLDOWN_MS,
} = {}) {
  const lines = Array.isArray(tapTalk?.lines) ? tapTalk.lines : [];
  return {
    // 三个条件缺一不可：语音总开关开、有 Key、「点击桌宠时说话」开着。
    voiceEnabled: Boolean(tapTalk?.enabled) && Boolean(ttsEnabled) && Boolean(hasKey),
    modelSound: Boolean(tapTalk?.modelSound),
    lineCount: lines.length,
    cooldownMs,
  };
}
