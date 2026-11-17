import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AVATAR_JSON, VIDEO_TYPE, normalizeVideoList } from '../shared/video.js';

// 视频形象：**看**与**算**归这里，复制、写注册表由 live2dModels.js 负责
// （那边才有用户模型目录与注册表的读写）。
//
// 一个视频形象目录的样子：
//   avatar.json        清单（type: 'video'，videos 列表）
//   videos/xxx.webm    视频（透明 WebM，带 alpha）

/** 导入体积上限（整个目录所有文件之和）。 */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function fileStat(p) {
  try {
    const st = await stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** 把清单里引用的相对路径解析成磁盘路径，并确保它**留在模型目录内**。 */
function resolveInside(modelRoot, relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const normalized = relPath.replace(/\\/g, '/');
  // 绝对路径与盘符路径直接判负：用户写什么盘符的绝对路径都不该读。
  if (/^([a-zA-Z]:)?\//.test(normalized)) return null;
  const target = resolve(modelRoot, normalized);
  const root = resolve(modelRoot);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/**
 * 读目录里的 avatar.json。
 *
 * @returns {{ avatar: object|null, problem: string|null }}
 *   avatar 是规整前的原始对象；problem 非 null 表示「看不懂」。
 */
export async function readAvatarJson(modelRoot) {
  const abs = join(modelRoot, AVATAR_JSON);
  const st = await fileStat(abs);
  if (!st) return { avatar: null, problem: null };
  const json = await readJsonOrNull(abs);
  if (!json || typeof json !== 'object') {
    return { avatar: null, problem: `${AVATAR_JSON} 无法解析或不是 JSON 对象` };
  }
  if (json.type !== VIDEO_TYPE) {
    return { avatar: null, problem: `${AVATAR_JSON} 里的 type 不是 "${VIDEO_TYPE}"` };
  }
  return { avatar: json, problem: null };
}

export async function isVideoAvatarDir(modelRoot) {
  const { avatar, problem } = await readAvatarJson(modelRoot);
  return !!avatar && !problem;
}

/**
 * 校验并规整一个视频形象目录（复制前的源目录与复制后的目录共用）。
 *
 * 校验的是**真正可用的视频清单**：
 * 缺失（file: null 或文件不存在）的条目从 videos 里剔除并记进 warnings——
 * 缺一个待机视频不该让整个人物导不进来，但用户必须看得见缺了什么。
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   avatar: object|null,
 *   videos: Array,
 *   bytes: number,
 * }>}
 */
export async function inspectVideoDir(modelRoot) {
  const errors = [];
  const warnings = [];
  const { avatar, problem } = await readAvatarJson(modelRoot);
  if (problem) {
    return { ok: false, errors: [problem], warnings, avatar: null, videos: [], bytes: 0 };
  }
  if (!avatar) {
    // avatar.json 根本不存在：不是视频形象（可能是 Live2D 目录混进来的）。
    return { ok: false, errors: [`缺少 ${AVATAR_JSON}`], warnings, avatar: null, videos: [], bytes: 0 };
  }
  const { videos, dropped, invalid } = normalizeVideoList(avatar.videos);
  if (invalid || videos.length === 0) {
    errors.push(`${AVATAR_JSON} 里没有任何有效的 videos 条目`);
  }
  if (dropped > 0) {
    warnings.push(`${dropped} 条 videos 条目因缺少 key 或 key 重复被忽略`);
  }

  const present = [];
  let bytes = 0;
  for (const v of videos) {
    if (!v.file) {
      warnings.push(`「${v.label}」（${v.key}）未提供视频文件，已跳过`);
      continue;
    }
    const abs = resolveInside(modelRoot, v.file);
    if (!abs) {
      warnings.push(`「${v.label}」（${v.key}）的路径越出模型目录，已跳过：${v.file}`);
      continue;
    }
    const st = await fileStat(abs);
    if (!st) {
      warnings.push(`「${v.label}」（${v.key}）的文件不存在，已跳过：${v.file}`);
      continue;
    }
    bytes += st.size;
    present.push({ ...v, bytes: st.size });
  }
  if (present.length === 0) {
    errors.push('没有任何可用的视频文件——请先按说明把视频转成透明 WebM 后放进目录。');
  }
  if (bytes > MAX_TOTAL_BYTES) {
    errors.push(`视频文件超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限，已中止。`);
  }

  const viewport = avatar.viewport && typeof avatar.viewport === 'object'
    ? {
        width: Number.isFinite(avatar.viewport.width) ? avatar.viewport.width : 300,
        height: Number.isFinite(avatar.viewport.height) ? avatar.viewport.height : 560,
      }
    : { width: 300, height: 560 };
  const fit = avatar.fit && typeof avatar.fit === 'object'
    ? {
        scale: Number.isFinite(avatar.fit.scale) ? avatar.fit.scale : 1.0,
        anchor: Array.isArray(avatar.fit.anchor) ? avatar.fit.anchor : [0.5, 1.0],
        offset: Array.isArray(avatar.fit.offset) ? avatar.fit.offset : [0, 0],
      }
    : { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] };

  // 规整后的清单：id 与 name 由导入流程传入（目录名可能是中文），
  // 这里先放着，planVideoImport 里覆盖。
  const normalized = {
    ...avatar,
    id: typeof avatar.id === 'string' ? avatar.id : '',
    name: typeof avatar.name === 'string' && avatar.name !== '' ? avatar.name : '',
    type: VIDEO_TYPE,
    viewport,
    fit,
    videos: present,
  };
  return { ok: errors.length === 0, errors, warnings, avatar: normalized, videos: present, bytes };
}

/**
 * 生成「复制哪些文件」与「写什么 avatar.json」。
 *
 * 只复制真正被引用到的视频 + avatar.json 本身：
 * 用户目录里多余的文件（原始 mp4、工程文件）不进用户数据目录。
 */
export async function planVideoImport(modelRoot, { id, name }) {
  const check = await inspectVideoDir(modelRoot);
  if (!check.ok) {
    throw new Error(`视频形象校验失败：\n${check.errors.map((e) => `· ${e}`).join('\n')}`);
  }
  const files = [];
  for (const v of check.videos) {
    files.push({ from: resolveInside(modelRoot, v.file), to: v.file.replace(/\\/g, '/') });
  }
  const pet = {
    ...check.avatar,
    id,
    name: check.avatar.name || name,
    type: VIDEO_TYPE,
    // videos 里的 file 保持相对路径原样（复制目标与源一致）。
    videos: check.videos.map(({ bytes: _bytes, ...v }) => v),
  };
  return { files, pet, warnings: check.warnings, bytes: check.bytes };
}
