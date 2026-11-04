/**
 * 插件的契约。
 *
 * 一个插件 = 项目根目录 `plugins/` 下的**一个子目录**，
 * 里面至少有一个 `plugin.json`（清单）与一个入口模块（默认 `main.js`）。
 *
 * 清单的形状、窗口模式的取值、清单的校验规则都放在这里：
 * 插件作者照着它写清单，宿主（src/main/plugins/）照着它读清单——
 * 两边对「一个插件长什么样」的理解必须一致，所以定义只有一份
 * （与 shared/panel.js 里面板消息的约定同理）。
 */

/** 插件清单的文件名：每个插件目录下都要有这一个。 */
export const PLUGIN_MANIFEST_FILE = 'plugin.json';

/** 插件入口模块的默认文件名。 */
export const PLUGIN_DEFAULT_ENTRY = 'main.js';

/** 插件独立窗口的两种形态。 */
export const PLUGIN_WINDOW_MODE = Object.freeze({
  /** 普通独立窗口：可以调整大小、能置顶。 */
  WINDOW: 'window',
  /** 桌面小部件：无边框、透明、常驻桌面。 */
  WIDGET: 'widget',
});

/** 插件 id 的合法形状：小写字母、数字、连字符（开头不能是连字符）。 */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 独立窗口的尺寸默认值与上下限。 */
export const PLUGIN_WINDOW_LIMITS = Object.freeze({
  width: 360,
  height: 420,
  minWidth: 200,
  minHeight: 120,
  maxWidth: 1200,
  maxHeight: 900,
});

/** 小部件刷新间隔的下限：太密会把 CPU 跑满。 */
export const MIN_PLUGIN_REFRESH_MS = 500;

/**
 * 这个相对路径是否安全（必须留在插件目录里）。
 *
 * 清单里的 `entry` 与 `page` 都会被拼到插件目录后面去拼路径，
 * 一个 `../../` 就能跑到插件目录外面——那是**任意文件**读取与执行。
 */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\0')) return false;
  const norm = p.replace(/\\/g, '/');
  // 绝对路径（`/x` 或 `C:\x`）一律拒绝。
  if (norm.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(norm)) return false;
  const parts = norm.split('/');
  // `.` 与空段无害（`./main.js`），`..` 有害。
  return !parts.includes('..');
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 规整一份窗口规格（`window` / `widget` 两段共用）。
 *
 * 尺寸会被夹到 [min, max] 之间：清单是**文件**，用户（或插件作者）
 * 手滑写个 999999 也不能让窗口开出一个巨大的框。
 */
export function normalizeWindowSpec(raw, mode) {
  const spec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const page = str(spec.page).trim();
  return {
    mode,
    page: isSafeRelativePath(page) ? page : '',
    title: str(spec.title).trim(),
    width: clampInt(
      spec.width,
      PLUGIN_WINDOW_LIMITS.minWidth,
      PLUGIN_WINDOW_LIMITS.maxWidth,
      PLUGIN_WINDOW_LIMITS.width
    ),
    height: clampInt(
      spec.height,
      PLUGIN_WINDOW_LIMITS.minHeight,
      PLUGIN_WINDOW_LIMITS.maxHeight,
      PLUGIN_WINDOW_LIMITS.height
    ),
    // 0 = 不刷新（数据只在打开时取一次）。
    refreshMs:
      typeof spec.refreshMs === 'number' && Number.isFinite(spec.refreshMs)
        ? clampInt(spec.refreshMs, 0, 3600000, 0)
        : 0,
    alwaysOnTop: spec.alwaysOnTop !== false,
  };
}

/**
 * 校验并规整一份插件清单。
 *
 * 校验失败**不抛错**，而是把问题列出来：宿主要把原因写进日志，
 * 一个坏插件不该把整个应用带崩——它只是不出现而已。
 *
 * @param {unknown} raw 解析出来的 JSON
 * @returns {{ok: boolean, value?: object, errors: string[]}}
 */
export function validateManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['清单不是一个 JSON 对象'] };
  }

  const id = str(raw.id).trim();
  if (!id) errors.push('缺少 id');
  else if (!PLUGIN_ID_RE.test(id)) errors.push(`id「${id}」不合法：只能用小写字母、数字与连字符`);

  const name = str(raw.name).trim();
  if (!name) errors.push('缺少 name');

  const entry = str(raw.entry).trim() || PLUGIN_DEFAULT_ENTRY;
  if (!isSafeRelativePath(entry)) errors.push(`entry「${entry}」不合法：必须留在插件目录里`);

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((k) => str(k).trim()).filter(Boolean)
    : [];

  const pageRaw = (mode) => str(raw[mode]?.page).trim();
  for (const mode of [PLUGIN_WINDOW_MODE.WINDOW, PLUGIN_WINDOW_MODE.WIDGET]) {
    const page = pageRaw(mode);
    if (page && !isSafeRelativePath(page)) {
      errors.push(`${mode}.page「${page}」不合法：必须留在插件目录里`);
    }
  }

  if (errors.length) return { ok: false, errors };

  const manifest = {
    id,
    name,
    icon: str(raw.icon).trim() || '•',
    description: str(raw.description).trim(),
    keywords,
    entry,
    // **没写就是没有**：清单里没提 `window` / `widget` 的插件
    // 就没有独立窗口与小部件（面板上也不给那两个按钮）。
    window: isPlainObject(raw.window)
      ? normalizeWindowSpec(raw.window, PLUGIN_WINDOW_MODE.WINDOW)
      : null,
    widget: isPlainObject(raw.widget)
      ? normalizeWindowSpec(raw.widget, PLUGIN_WINDOW_MODE.WIDGET)
      : null,
  };
  return { ok: true, value: manifest, errors: [] };
}

/** 是不是一个普通对象（不是数组、不是 null）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 这个插件能不能「分离成独立窗口」。
 *
 * 面板上的「在新窗口打开」按钮据此出现与否：
 * 没有 `window` 段的插件就只能待在面板里。
 */
export function canDetach(manifest) {
  return Boolean(manifest?.window);
}

/** 这个插件有没有小部件形态。 */
export function hasWidget(manifest) {
  return Boolean(manifest?.widget);
}
