import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  position: null,
  modelId: 'haru',
  scale: 1.0,
  opacity: 1.0,
  visible: true,
});

const SCALE_RANGE = { min: 0.5, max: 2.0 };
const OPACITY_RANGE = { min: 0.2, max: 1.0 };

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 把任意输入规整为合法设置对象；非法值一律回退默认值，绝不抛错。 */
export function sanitizeSettings(raw) {
  if (!isPlainObject(raw)) return { ...DEFAULT_SETTINGS };

  const out = { ...DEFAULT_SETTINGS };

  if (isPlainObject(raw.position)) {
    const { x, y } = raw.position;
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      out.position = { x: Math.round(x), y: Math.round(y) };
    }
  }
  if (typeof raw.modelId === 'string' && raw.modelId.trim() !== '') {
    out.modelId = raw.modelId.trim();
  }
  out.scale = clampNumber(raw.scale, SCALE_RANGE.min, SCALE_RANGE.max, DEFAULT_SETTINGS.scale);
  out.opacity = clampNumber(raw.opacity, OPACITY_RANGE.min, OPACITY_RANGE.max, DEFAULT_SETTINGS.opacity);
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  if (typeof raw.version === 'number') out.version = raw.version;

  return out;
}

export async function loadSettings(userDataDir) {
  try {
    const text = await readFile(join(userDataDir, 'settings.json'), 'utf8');
    return sanitizeSettings(JSON.parse(text));
  } catch (err) {
    // 文件不存在是正常情况（首次启动），静默回退默认值即可。
    // 但读不了/解析失败说明配置已损坏——同样回退默认值，却必须留痕，
    // 否则用户会遇到「改了设置没生效」且无从排查。
    if (err?.code !== 'ENOENT') {
      console.warn('[desk-pet] settings.json 无法读取或解析，已回退默认值：', err?.message);
    }
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(userDataDir, settings) {
  const clean = sanitizeSettings(settings);
  await mkdir(userDataDir, { recursive: true });
  const target = join(userDataDir, 'settings.json');
  const tmp = join(userDataDir, 'settings.json.tmp');
  // 先写临时文件再改名：直接 writeFile 会先把目标文件**截断成 0 字节**，
  // 写到一半被强杀（任务管理器 / 断电）就留下一个 0 字节文件——
  // 下次启动读到空文件会静默重置位置、形象、缩放与透明度，用户毫无察觉。
  // rename 在 NTFS 上是原子的：要么还是旧文件，要么已经是新文件。
  await writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    // 改名失败：临时文件留在那儿，下次启动前先清掉。
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return clean;
}
