/**
 * 视频形象的清单契约（主进程与渲染层共用）。
 *
 * 视频形象 = 一个目录：
 *   avatar.json   清单（配置）
 *   webm/*.webm   视频（透明 WebM VP9，带 alpha）
 *
 * ## 两种
 *
 * - **语义绑定（仅交互键）**：clips[].semantic 只接受 `idle` / `tapHead` / `tapBody` / `drag`——
 *   给待机池与摸头/点身体/拖拽这些不经过模型的反应接线。
 *   情绪事件**不再自动播 clip**：视频形象没有脸，情绪只调心情值；
 *   「笑/拍手/跳舞」全由模型按 id=label 在 `<<META>>` 里点播。
 * - **显式点播**：clips[].id 是给模型点名的编号——
 *   提示词里列出全部可用的 id 与 label，模型想做哪个动作就在
 *   <<META>> 里写 "action":"<id>"，由它自主决定，不做任何场景绑定。
 *
 * ## 分类（category）
 *
 * 素材按用途分成四类，纯属组织手段：
 *   idle    待机循环（待机池）
 *   emotion 情绪/表情类（一次性，给模型的 emotion/action 用）
 *   action  动作/手势类（一次性）
 *   special 特殊/稀有类（一次性）
 * 分类不影响播放方式，只影响提示词里的分组呈现与清单的可读性。
 */

/** 清单里的模型类型：视频。 */
export const VIDEO_TYPE = 'video';

/** 配置文件名（固定，不推导）。 */
export const AVATAR_JSON = 'avatar.json';

/** 消费侧只认 `clips[]`：数组里每一项是一个「动作」。 */
export function isVideoManifest(manifest) {
  return !!manifest && manifest.type === VIDEO_TYPE && Array.isArray(manifest.clips);
}

// 应用会自动接线的语义键：只有交互类（idle/tapHead/tapBody/drag）——
// 待机池与摸头/点身体/拖拽不经过模型，必须有确定性接线。
// 情绪事件不接线：视频形象没有脸，情绪只调心情值，
// 播不播「笑/拍手」由模型自己按 id=label 点名。
// 与 live2d / spine 的降级规则一致：语义缺失 → 不播动作，不报错。
export const VIDEO_SEMANTIC_KEYS = new Set([
  'idle',
  'tapHead',
  'tapBody',
  'drag',
]);

/** clip 的四个分类：idle / emotion / action / special。 */
export const VIDEO_CLIP_CATEGORIES = Object.freeze(['idle', 'emotion', 'action', 'special']);

const CATEGORY_SET = new Set(VIDEO_CLIP_CATEGORIES);

/** 分类的中文名（提示词与清单校验共用）。 */
export const CLIP_CATEGORY_LABELS = Object.freeze({
  idle: '待机',
  emotion: '情绪表情',
  action: '动作手势',
  special: '特殊',
});

/**
 * 规整 avatar.json 里的 clips 列表。
 *
 * 每项：{ id, file, label, category, loop, sound, semantic }
 *   id       动作标识：唯一；既是右键菜单里的 group 名，也是 motion() 的参数，
 *            还是模型点播时写给程序看的编号
 *   file     相对模型目录的路径（webm/xxx.webm）；null = 缺失（本条目标记为未提供）
 *   label    菜单与提示词显示名
 *   category 分类（见 VIDEO_CLIP_CATEGORIES）；缺省/非法 → action
 *   loop     true = 循环播放（待机类）；false/缺省 = 一次性
 *   sound    true = 播放原声（默认静音）
 *   semantic 语义绑定（见 VIDEO_SEMANTIC_KEYS）。idle 可以绑**多条**
 *            （待机池）；其余语义键只取第一个。缺省 = 仅供显式点播。
 *
 * 规整只做**形状**校正，不替用户猜缺失的语义。
 */
export function normalizeClipList(input) {
  const out = [];
  const seen = new Set();
  const seenSemantic = new Set();
  let dropped = 0;
  if (!Array.isArray(input)) return { clips: out, dropped: 0, invalid: true };
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') {
      dropped += 1;
      continue;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 64) : '';
    if (!id || seen.has(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    const file = typeof raw.file === 'string' && raw.file.trim() !== '' ? raw.file.trim() : null;
    const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id;
    const category = typeof raw.category === 'string' ? raw.category.trim() : '';
    const entry = {
      id,
      file,
      label,
      category: CATEGORY_SET.has(category) ? category : 'action',
      loop: raw.loop === true,
      sound: raw.sound === true,
    };
    // semantic 只认交互键（idle/tapHead/tapBody/drag）。idle 允许多条（待机池）；
    // 其余键一个语义只绑第一个，后面的退回「仅菜单/点播」，不覆盖前面那条。
    const semantic = typeof raw.semantic === 'string' ? raw.semantic.trim() : '';
    if (VIDEO_SEMANTIC_KEYS.has(semantic) && (semantic === 'idle' || !seenSemantic.has(semantic))) {
      entry.semantic = semantic;
      seenSemantic.add(semantic);
    }
    out.push(entry);
  }
  return { clips: out, dropped, invalid: false };
}

/** 由规整后的 clip 列表推导：语义键 → { group, index }。 */
export function deriveVideoMotions(clips) {
  const motions = {};
  const motionGroups = {};
  const motionNames = {};
  for (const v of clips) {
    if (!v.file) continue;
    motionGroups[v.id] = 1;
    motionNames[v.id] = [v.label];
    // 语义绑定**第一个**赢：idle 可能绑多条（待机池），
    // 其余键在 normalizeClipList 里已经去过重，这里只是兜底。
    if (v.semantic && !motions[v.semantic]) motions[v.semantic] = { group: v.id, index: 0 };
  }
  return { motions, motionGroups, motionNames };
}

/**
 * 渲染层上报的 clip 列表（供主进程组提示词）。
 *
 * 渲染层不是可信边界：上报的内容在这里再校验一遍——
 * 只留 id/label/category/semantic/loop，编号不重复、长度有上限。
 */
export function sanitizeReportedClips(input) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(input)) return out;
  for (const raw of input.slice(0, 256)) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().slice(0, 64) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 64) : id;
    const category = typeof raw?.category === 'string' ? raw.category.trim() : '';
    const semantic = typeof raw?.semantic === 'string' ? raw.semantic.trim() : '';
    out.push({
      id,
      label,
      category: CATEGORY_SET.has(category) ? category : 'action',
      semantic: VIDEO_SEMANTIC_KEYS.has(semantic) ? semantic : '',
      loop: raw?.loop === true,
    });
    if (out.length >= 64) break;
  }
  return out;
}

/**
 * 提示词里的「你能做出的动作」这一小节。
 *
 * **只列 id 和 label**，不替模型规定什么时候做什么——
 * 情绪表达是自发的，绑定场景就是写死了。
 */
export function buildClipSection(clips) {
  const list = (Array.isArray(clips) ? clips : []).filter((c) => c && c.id);
  if (list.length === 0) return '';
  const byCategory = new Map();
  for (const clip of list.slice(0, 64)) {
    const category = CATEGORY_SET.has(clip.category) ? clip.category : 'action';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(clip);
  }
  const lines = [
    '你能做出的动作（想做某个动作时，在 <<META>> 里加 "action":"<id>"，id 只认下面这张表，认不出来就等于没做；动作播完自动回待机）：',
  ];
  for (const category of VIDEO_CLIP_CATEGORIES) {
    const group = byCategory.get(category) || [];
    if (group.length === 0) continue;
    lines.push(
      `- ${CLIP_CATEGORY_LABELS[category]}：${group.map((c) => `${c.id}=${c.label}`).join('；')}`
    );
  }
  return lines.join('\n');
}
