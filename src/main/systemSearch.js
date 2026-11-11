import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * 系统搜索：文件、图标、打开与定位。
 *
 * 桌宠的搜索框要覆盖 Win+S 能搜到的东西，于是这里管三件事：
 *
 * 1. **文件**：查 Windows 搜索索引（`psHost` 里那个 PowerShell 助手）。
 *    索引不可用时（服务没开、机器上没有索引）退回到扫常用文件夹。
 * 2. **图标**：从快捷方式、程序、文档里把图标抽出来，搜索结果才有图。
 *    抽过的图标缓存在这里——同一个路径只抽一次。
 * 3. **打开与定位**：打开文件、打开设置页、在资源管理器里定位到它。
 *
 * 这一层**不碰 electron**：开文件、抽图标都是系统调用，
 * 由调用方注入（`openPath` / `openExternal` / `showItemInFolder`），
 * 于是能在普通 node 里测（见 test/unit/system-search.test.js）。
 */

/** 搜索网页用哪个引擎。 */
const WEB_SEARCH_URL = 'https://www.bing.com/search?q=';

/** 兜底扫描时的深度与条数上限（常用文件夹不该翻个底朝天）。 */
const FALLBACK_DEPTH = 3;
const FALLBACK_LIMIT = 4000;

/**
 * @param {object} options
 * @param {object} options.psHost PowerShell 助手（查索引、抽图标）
 * @param {Function} options.openPath 打开一个文件路径，返回错误描述或 null
 * @param {Function} options.openExternal 打开一个外部地址（ms-settings: 之类）
 * @param {Function} options.showItemInFolder 在资源管理器里定位一个文件
 * @param {string[]} [options.fallbackDirs] 索引不可用时改扫这些目录
 */
export function createSystemSearch({
  psHost,
  openPath,
  openExternal,
  showItemInFolder,
  fallbackDirs = [],
} = {}) {
  /** 路径 → 图标（data URL）。抽过一次就记住。 */
  const iconCache = new Map();
  /** 兜底清单：扫出来的文件（索引不可用时才用得上）。 */
  let fallbackFiles = null;

  /**
   * 扫常用文件夹（索引不可用时的兜底）。
   *
   * 只扫固定深度、有限条数：常用文件夹下面可能有几十万文件，
   * 一次全扫能把面板卡住十几秒。
   */
  async function scanFallback() {
    const out = [];
    const walk = async (dir, level) => {
      if (out.length >= FALLBACK_LIMIT) return;
      let items = [];
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (out.length >= FALLBACK_LIMIT) return;
        const name = String(item?.name || '');
        // 隐藏文件与目录不算结果（.git、.config 之类）。
        if (!name || name.startsWith('.')) continue;
        if (item.isDirectory()) {
          if (level > 0) await walk(join(dir, name), level - 1);
          continue;
        }
        out.push({ name, path: join(dir, name) });
      }
    };
    for (const dir of fallbackDirs) {
      if (dir) await walk(dir, FALLBACK_DEPTH);
    }
    return out;
  }

  /** 兜底清单（扫一次就留着）。 */
  async function fallbackList() {
    if (!fallbackFiles) fallbackFiles = scanFallback();
    return fallbackFiles;
  }

  /**
   * 查文件。
   *
   * @param {string} query 用户输入
   * @param {number} [limit] 最多几条
   * @returns {Promise<Array<{id: string, kind: string, name: string, target: string, hint: string}>>}
   */
  async function searchFiles(query, limit = 20) {
    const q = String(query || '').trim();
    if (!q) return [];
    let files = [];
    // 索引是不是可用：不可用才改扫常用文件夹。
    // 索引可用但**没匹配**不算不可用——那只是这台机器上没有这个文件。
    let indexed = true;
    try {
      const response = await psHost?.request?.('files', { query: q, limit });
      const items = Array.isArray(response?.items) ? response.items : [];
      files = items
        .map((item) => ({
          name: String(item?.name || ''),
          path: String(item?.path || ''),
          // 'name' = 文件名里有这个词；'content' = 文件**内容**里有这个词。
          match: item?.match === 'content' ? 'content' : 'name',
        }))
        .filter((item) => item.name && item.path);
    } catch (err) {
      indexed = false;
      console.warn('[desk-pet] 搜索索引用不了，改扫常用文件夹：', err?.message || err);
    }
    if (!indexed && fallbackDirs.length) {
      const all = await fallbackList();
      const lower = q.toLowerCase();
      files = all
        .filter((file) => file.name.toLowerCase().includes(lower))
        .slice(0, limit);
    }
    return files.map((file) => ({
      id: `file:${file.path.toLowerCase()}`,
      kind: 'file',
      name: file.name,
      target: file.path,
      hint: folderName(file.path),
      match: file.match,
    }));
  }

  /**
   * 抽图标。
   *
   * @param {string[]} paths 要抽图标的路径
   * @returns {Promise<Record<string, string>>} 路径 → data URL（抽不出就没有这一项）
   */
  async function icons(paths) {
    const wanted = (Array.isArray(paths) ? paths : [])
      .map((p) => String(p || ''))
      .filter((p) => p && !iconCache.has(p));
    if (wanted.length) {
      try {
        const response = await psHost.request('icons', { paths: wanted });
        for (const item of Array.isArray(response?.items) ? response.items : []) {
          const path = String(item?.path || '');
          const icon = String(item?.icon || '');
          if (!path) continue;
          // 抽不出来也要记一笔：不然每次重画都去问一遍，抽不出的路径白问。
          iconCache.set(path, icon ? `data:image/png;base64,${icon}` : '');
        }
      } catch (err) {
        console.warn('[desk-pet] 抽图标失败：', err?.message || err);
      }
    }
    const out = {};
    for (const path of Array.isArray(paths) ? paths : []) {
      const cached = iconCache.get(String(path || ''));
      if (cached) out[String(path)] = cached;
    }
    return out;
  }

  /**
   * 打开一个条目。
   *
   * @param {{kind: string, path?: string, target?: string, query?: string}} payload
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function open(payload) {
    const kind = String(payload?.kind || '');
    if (kind === 'file') {
      const path = String(payload?.path || '');
      if (!path) return { ok: false, message: '找不到这个文件了' };
      const error = await openPath?.(path);
      if (error) return { ok: false, message: `打不开：${error}` };
      return { ok: true, message: `已打开 ${basename(path)}` };
    }
    if (kind === 'setting') {
      const target = String(payload?.target || '');
      if (!target) return { ok: false, message: '找不到这个设置页了' };
      await openExternal?.(target);
      return { ok: true, message: '已打开设置' };
    }
    if (kind === 'web') {
      const query = String(payload?.query || '').trim();
      if (!query) return { ok: false, message: '搜什么？' };
      await openExternal?.(webSearchUrl(query));
      return { ok: true, message: `已在浏览器里搜索「${query}」` };
    }
    return { ok: false, message: '打不开这一项' };
  }

  /**
   * 在资源管理器里定位一个条目（右键菜单的「打开所在目录」）。
   *
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function reveal(payload) {
    const path = String(payload?.path || '');
    if (!path) return { ok: false, message: '这一项没有所在目录' };
    try {
      showItemInFolder?.(path);
      return { ok: true, message: `已定位到 ${folderName(path)}` };
    } catch (err) {
      return { ok: false, message: `定位不了：${err?.message || err}` };
    }
  }

  return {
    searchFiles,
    icons,
    open,
    reveal,
    /** 预热：把搜索助手拉起来（用户第一次打开面板时叫它）。 */
    warm: () => psHost?.warm?.(),
  };
}

/** 文件所在文件夹的名字（结果显示在右边当副标题）。 */
function folderName(path) {
  const parts = String(path || '').split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/** 搜网页用的地址。 */
export function webSearchUrl(query) {
  return `${WEB_SEARCH_URL}${encodeURIComponent(String(query || '').trim())}`;
}
