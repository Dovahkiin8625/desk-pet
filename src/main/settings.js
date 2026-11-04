import { readJson, writeJson } from './store.js';
import { SCALE_RANGE } from '../shared/viewport.js';
import { DOCK_SIDES } from './edgeDock.js';
import { HOTKEY_SLOTS } from '../shared/hotkeys.js';

/** 各快捷键槽位的默认值（见 shared/hotkeys.js）。 */
const DEFAULT_HOTKEYS = Object.fromEntries(HOTKEY_SLOTS.map((s) => [s.key, s.defaultValue]));

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  position: null,
  // 桌宠**本体**的可见矩形（窗口内坐标）：窗口里真正画着形象的那一块。
  //
  // 落盘是为了下次启动能按本体判定位置是否有效——
  // 窗口有一部分在屏幕外是**正常状态**（用户把角色拖到了屏幕顶，
  // 模型上方那块透明留白自然就在屏幕外）。
  // 按窗口判会把它当成「显示器被拔掉了」，悄悄挪回右下角。
  visibleRect: null,
  modelId: 'haru',
  scale: 1.0,
  opacity: 1.0,
  visible: true,
  // —— 系统与工程化（第六部分）——
  // 开机自启默认关：开机就跑一个桌宠是用户没要求的行为。
  autoLaunch: false,
  // 全局快捷键：呼出/隐藏桌宠。
  hotkey: DEFAULT_HOTKEYS.hotkey,
  // 输入框快捷键：唤出输入框（插件面板的搜索框），可以直接打字。
  // 默认空 = 不设：多抢一个全局组合不是用户要求的行为。
  panelHotkey: DEFAULT_HOTKEYS.panelHotkey,
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
  // 可见矩形：宽高都得是正数，缺一不可——半个矩形没法用来判位置。
  if (isPlainObject(raw.visibleRect)) {
    const { x, y, width, height } = raw.visibleRect;
    const finite = [x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v));
    if (finite && width > 0 && height > 0) {
      out.visibleRect = {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      };
    }
  }
  out.scale = clampNumber(raw.scale, SCALE_RANGE.min, SCALE_RANGE.max, DEFAULT_SETTINGS.scale);
  out.opacity = clampNumber(raw.opacity, OPACITY_RANGE.min, OPACITY_RANGE.max, DEFAULT_SETTINGS.opacity);
  if (typeof raw.visible === 'boolean') out.visible = raw.visible;
  // —— 系统与工程化（第六部分）——
  if (typeof raw.autoLaunch === 'boolean') out.autoLaunch = raw.autoLaunch;
  if (typeof raw.clickThrough === 'boolean') out.clickThrough = raw.clickThrough;
  if (typeof raw.edgeSnap === 'boolean') out.edgeSnap = raw.edgeSnap;
  if (typeof raw.dockEnabled === 'boolean') out.dockEnabled = raw.dockEnabled;
  // 快捷键：规则见 shared/hotkeys.js 的槽位清单。
  // 空串合法与否看槽位：「呼出/隐藏桌宠」不能空（空了就没有召回手段），
  // 「唤醒输入框」可以空（空 = 不设这个快捷键）。
  // 太长**回退默认值**而不是截断——截断出来的加速键串是个语法错误的东西，
  // 注册必然失败。
  for (const slot of HOTKEY_SLOTS) {
    const value = raw[slot.key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 64) continue;
    if (trimmed === '' && !slot.allowEmpty) continue;
    out[slot.key] = trimmed;
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
