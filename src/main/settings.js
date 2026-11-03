import { readJson, writeJson } from './store.js';
import { SCALE_RANGE } from '../shared/viewport.js';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  position: null,
  modelId: 'haru',
  scale: 1.0,
  opacity: 1.0,
  visible: true,
});

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
  const raw = await readJson(userDataDir, 'settings.json', null, 'settings.json');
  return sanitizeSettings(raw);
}

export async function saveSettings(userDataDir, settings) {
  const clean = sanitizeSettings(settings);
  // 原子写（先写临时文件再改名）：直接 writeFile 会先把目标文件**截断成 0 字节**，
  // 写到一半被强杀（任务管理器 / 断电）就留下一个 0 字节文件——
  // 下次启动读到空文件会静默重置位置、形象、缩放与透明度，用户毫无察觉。
  await writeJson(userDataDir, 'settings.json', clean);
  return clean;
}
