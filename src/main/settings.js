import { readJson, writeJson } from './store.js';
import { SCALE_RANGE } from '../shared/viewport.js';
import { DOCK_SIDES } from './edgeDock.js';

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  position: null,
  modelId: 'haru',
  scale: 1.0,
  opacity: 1.0,
  visible: true,
  // —— 系统与工程化（第六部分）——
  // 开机自启默认关：开机就跑一个桌宠是用户没要求的行为。
  autoLaunch: false,
  // 全局快捷键：呼出/隐藏桌宠。
  hotkey: 'Control+Shift+D',
  // 鼠标穿透：窗口不吃点击，桌面照常操作。
  clickThrough: false,
  // 边缘吸附：拖到屏幕边缘附近时自动贴齐。
  edgeSnap: true,
  // 贴边隐藏：贴齐后滑出屏幕只留一条边。
  dockEnabled: false,
  // 当前停靠在哪条边（状态，不是开关）。
  dock: null,
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
  // —— 系统与工程化（第六部分）——
  if (typeof raw.autoLaunch === 'boolean') out.autoLaunch = raw.autoLaunch;
  if (typeof raw.clickThrough === 'boolean') out.clickThrough = raw.clickThrough;
  if (typeof raw.edgeSnap === 'boolean') out.edgeSnap = raw.edgeSnap;
  if (typeof raw.dockEnabled === 'boolean') out.dockEnabled = raw.dockEnabled;
  // hotkey：非空字符串且长度 ≤ 64。太长**回退默认值**而不是截断——
  // 截断出来的加速键串是个语法错误的东西，注册必然失败。
  if (typeof raw.hotkey === 'string') {
    const trimmed = raw.hotkey.trim();
    if (trimmed !== '' && trimmed.length <= 64) out.hotkey = trimmed;
  }
  // dock：只认四个合法边名，其余一律 null。
  // 边名清单在 edgeDock.js（DOCK_SIDES）——那是唯一的一份。
  if (DOCK_SIDES.includes(raw.dock)) out.dock = raw.dock;
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
