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
 * 素材按**文件夹分类**组织（与素材目录一致），纯属组织手段：
 * 分类不影响播放方式，只影响提示词/菜单里的分组呈现与清单的可读性。
 * 预制 miya 使用 13 个文件夹分类（待机与呼吸、困倦与放松……生活小动作）。
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

/**
 * 视频形象的文件夹分类（按素材目录顺序）。
 * 用于提示词/菜单的分组顺序与显示；category 字段可为任意非空字符串，
 * 但推荐与文件夹分类一致。
 */
export const VIDEO_FOLDER_CATEGORIES = Object.freeze([
  '待机与呼吸',
  '困倦与放松',
  '开心与喜悦',
  '害羞与心动',
  '闹别扭与生气',
  '低落与委屈',
  '惊讶与疑惑',
  '卖萌与搞怪',
  '问候与礼仪',
  '撒娇与祈求',
  '舞蹈与律动',
  '音乐自娱',
  '生活小动作',
]);

// 兼容旧导出名：历史上为固定四类；现在等同于文件夹分类顺序。
export const VIDEO_CLIP_CATEGORIES = VIDEO_FOLDER_CATEGORIES;

const KNOWN_CATEGORY_ORDER = new Map(VIDEO_FOLDER_CATEGORIES.map((c, i) => [c, i]));

/** 分类的显示名（提示词与菜单共用）。文件夹分类即其显示名。 */
export const CLIP_CATEGORY_LABELS = Object.freeze(
  Object.fromEntries(VIDEO_FOLDER_CATEGORIES.map((c) => [c, c])),
);

/** 分类排序：已知文件夹分类按目录顺序，其余按首次出现顺序追加。 */
export function orderClipCategories(categories) {
  const list = Array.from(new Set((categories || []).filter(Boolean)));
  return list.sort((a, b) => {
    const ia = KNOWN_CATEGORY_ORDER.has(a) ? KNOWN_CATEGORY_ORDER.get(a) : Number.MAX_SAFE_INTEGER;
    const ib = KNOWN_CATEGORY_ORDER.has(b) ? KNOWN_CATEGORY_ORDER.get(b) : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return 0;
  });
}

/**
 * 规整 avatar.json 里的 clips 列表。
 *
 * 每项：{ id, file, label, category, loop, sound, semantic }
 *   id       动作标识：唯一；既是右键菜单里的 group 名，也是 motion() 的参数，
 *            还是模型点播时写给程序看的编号
 *   file     相对模型目录的路径（webm/xxx.webm）；null = 缺失（本条目标记为未提供）
 *   label    菜单与提示词显示名
 *   category 分类/分组名（推荐为文件夹分类，如“待机与呼吸”）；缺省 → 空串
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
    const category = typeof raw.category === 'string' ? raw.category.trim().slice(0, 64) : '';
    const entry = {
      id,
      file,
      label,
      category,
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
  for (const raw of input.slice(0, 512)) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().slice(0, 64) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 64) : id;
    const category = typeof raw?.category === 'string' ? raw.category.trim().slice(0, 64) : '';
    const semantic = typeof raw?.semantic === 'string' ? raw.semantic.trim() : '';
    out.push({
      id,
      label,
      category: category || 'action',
      semantic: VIDEO_SEMANTIC_KEYS.has(semantic) ? semantic : '',
      loop: raw?.loop === true,
    });
    if (out.length >= 256) break;
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
  const order = [];
  for (const clip of list.slice(0, 256)) {
    const category = typeof clip.category === 'string' && clip.category.trim() ? clip.category.trim() : '其他';
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
      order.push(category);
    }
    byCategory.get(category).push(clip);
  }
  // 已知文件夹分类按目录顺序优先，其余保持首次出现顺序
  const sorted = [
    ...order.filter((c) => KNOWN_CATEGORY_ORDER.has(c)).sort((a, b) => KNOWN_CATEGORY_ORDER.get(a) - KNOWN_CATEGORY_ORDER.get(b)),
    ...order.filter((c) => !KNOWN_CATEGORY_ORDER.has(c)),
  ];
  const lines = [
    '你能做出的动作（想做某个动作时，在 <<META>> 里加 "action":"<id>"，id 只认下面这张表，认不出来就等于没做；动作播完自动回待机）：',
  ];
  for (const category of sorted) {
    const group = byCategory.get(category) || [];
    if (group.length === 0) continue;
    const label = CLIP_CATEGORY_LABELS[category] || category;
    lines.push(`- ${label}：${group.map((c) => `${c.id}=${c.label}`).join('；')}`);
  }
  return lines.join('\n');
}
