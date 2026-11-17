/**
 * 视频形象的清单契约（主进程与渲染层共用）。
 *
 * 与 shared/spine.js 同一个道理：两边必须一致。
 * 主进程导入时按它写清单（type: 'video'），
 * 渲染层加载时按它决定用视频播放器而不是 Cubism Core。
 *
 * 视频形象 = 一个目录：
 *   avatar.json   清单（配置）
 *   videos/*.webm 视频（透明 WebM VP9，带 alpha）
 */

/** 清单里的模型类型：视频。 */
export const VIDEO_TYPE = 'video';

/** 配置文件名（固定，不推导）。 */
export const AVATAR_JSON = 'avatar.json';

/** 消费侧只认 `videos[]`：数组里每一项是一个「动作」。 */
export function isVideoManifest(manifest) {
  return !!manifest && manifest.type === VIDEO_TYPE && Array.isArray(manifest.videos);
}

// 应用会自动接线的语义键：idle/tapHead/tapBody/drag 是交互语义；
// happy/smile/shy/surprised/sad/angry/tired/normal 是情绪/表情语义——
// 视频形象没有脸，这些地方播对应 clip 代替「套表情」。
// 与 live2d / spine 的降级规则一致：语义缺失 → 不播动作，不报错。
export const VIDEO_SEMANTIC_KEYS = new Set([
  'idle',
  'tapHead',
  'tapBody',
  'drag',
  'happy',
  'smile',
  'shy',
  'surprised',
  'sad',
  'angry',
  'tired',
  'normal',
]);

/**
 * 规整 avatar.json 里的 videos 列表。
 *
 * 每项：{ key, file, label, loop, sound, semantic }
 *   key      动作标识：唯一；既是右键菜单里的 group 名，也是 motion() 的参数
 *   file     相对模型目录的路径（videos/xxx.webm）；null = 缺失（本条目标记为未提供）
 *   label    菜单显示名
 *   loop     true = 循环播放（待机类）；false/缺省 = 一次性
 *   sound    true = 播放原声（默认静音）
 *   semantic 语义绑定（见 VIDEO_SEMANTIC_KEYS），交互键 idle/tapHead/tapBody/drag、
 *   情绪/表情键 happy/smile/…；缺省 = 仅菜单。
 *   idle 可以绑**多条**（这些条目的集合是「待机池」，播完随机/按序换下一条）；
 *   其余语义键只取第一个。
 *
 * 规整只做**形状**校正，不替用户猜缺失的语义：
 * 缺失/坏掉的条目丢弃并计数，由调用方决定是警告还是报错。
 */
export function normalizeVideoList(input) {
  const out = [];
  const seen = new Set();
  const seenSemantic = new Set();
  let dropped = 0;
  if (!Array.isArray(input)) return { videos: out, dropped: 0, invalid: true };
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      dropped += 1;
      continue;
    }
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    const file = typeof raw.file === 'string' && raw.file.trim() !== '' ? raw.file.trim() : null;
    const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : key;
    const entry = {
      key,
      file,
      label,
      loop: raw.loop === true,
      sound: raw.sound === true,
    };
    // semantic 只认应用真正会接线的键。idle 允许多条（待机池）；
    // 其余键一个语义只绑第一个，后面的退回「仅菜单可见」，不覆盖前面那条。
    const semantic = typeof raw.semantic === 'string' ? raw.semantic.trim() : '';
    if (VIDEO_SEMANTIC_KEYS.has(semantic) && (semantic === 'idle' || !seenSemantic.has(semantic))) {
      entry.semantic = semantic;
      seenSemantic.add(semantic);
    }
    out.push(entry);
  }
  return { videos: out, dropped, invalid: false };
}

/** 由规整后的视频列表推导：语义键 → { group, index }。 */
export function deriveVideoMotions(videos) {
  const motions = {};
  const motionGroups = {};
  const motionNames = {};
  for (const v of videos) {
    if (!v.file) continue;
    motionGroups[v.key] = 1;
    motionNames[v.key] = [v.label];
    // 语义绑定**第一个**赢：idle 可能绑多条（待机池），
    // 其余键在 normalizeVideoList 里已经去过重，这里只是兜底。
    if (v.semantic && !motions[v.semantic]) motions[v.semantic] = { group: v.key, index: 0 };
  }
  return { motions, motionGroups, motionNames };
}
