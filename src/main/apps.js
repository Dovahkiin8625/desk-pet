import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';

/**
 * 本机程序索引。
 *
 * 面板的搜索框要能像 uTools 那样「打字 → 找到本机的程序 → 回车启动」，
 * 所以这里把机器上能启动的东西扫成一张表。
 *
 * 扫三处：
 * 1. **开始菜单**（用户级 + 全体用户级）：快捷方式（.lnk）——
 *    用户装的软件最全，名字也是安装程序写好的（「Google Chrome」而不是「chrome」）。
 * 2. **PATH 上的目录**：命令行工具（git、node、python……）。
 * 3. **程序目录**（Program Files / %LOCALAPPDATA%\Programs）：没做快捷方式的程序。
 *
 * 这一层**不碰 electron**：扫描只是文件系统的事，而「启动」是系统调用——
 * 那件事由调用方注入（`open`），于是这一整块能在普通 node 里测
 * （见 test/unit/apps.test.js）。
 */

/** 开始菜单里能递归到多深：Programs 下面通常只有一两层。 */
const START_MENU_DEPTH = 3;

/** 程序目录里能递归到多深（`Program Files\厂商\程序\程序.exe` 正好两层）。 */
const PROGRAM_DEPTH = 2;

/** 可以直接启动的文件后缀。 */
const EXECUTABLE_EXT = new Set(['.exe', '.bat', '.cmd', '.com']);

/** 开始菜单里的快捷方式后缀。 */
const SHORTCUT_EXT = '.lnk';

/** 程序目录里这些子目录要跳过：里面全是库与安装器，不是能用的程序。 */
const SKIP_DIRS = new Set(['common files', 'common files (x86)', 'windowsapps']);

/**
 * C:\Windows\System32 里值得列出来的那些工具。
 *
 * 整个 System32 有两千多个 exe，绝大多数是系统组件的碎片
 * （bcdedit、chkdsk、wscript……）——全列出来只会淹没搜索结果。
 * 所以系统目录里只收这张单子，其余一律不收。
 */
const WINDOWS_TOOLS = new Set([
  'notepad.exe',
  'calc.exe',
  'mspaint.exe',
  'write.exe',
  'wordpad.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'explorer.exe',
  'taskmgr.exe',
  'control.exe',
  'regedit.exe',
  'snippingtool.exe',
  'osk.exe',
  'magnify.exe',
  'charmap.exe',
  'mmc.exe',
  'perfmon.exe',
  'resmon.exe',
  'cleanmgr.exe',
  'dfrgui.exe',
  'msconfig.exe',
  'wfdesk.exe',
  'systempropertiescomputername.exe',
]);

/** 安装器与升级器的文件名：它们不是「能用的程序」。 */
const INSTALLER_NAMES = new Set([
  'installer',
  'uninstaller',
  'vc_redist',
  'vcredist',
  'crashpad_handler',
  'crashreportclient',
  'dotnetfx',
  'gacutil',
  'regasm',
  'ngen',
  'msiexec',
]);

/**
 * 安装器与升级器的**开头**。
 *
 * 开始菜单里有一堆「卸载 XXX」「Install Additional Tools for Node.js」这类快捷方式——
 * 它们是装软件的副产品，不是用户要用的程序。
 */
const INSTALLER_PREFIXES = [
  'setup',
  'install',
  'uninstall',
  'unins',
  'update',
  'updater',
  'upgrade',
  'repair',
  'remove',
  '卸载',
  '安装',
  '更新',
  '修复',
];

/** 默认的目录读取：只看一层，拿到名字与「是不是目录」。 */
async function defaultReadDir(dir) {
  return readdir(dir, { withFileTypes: true });
}

/** 列一个目录；读不到就当它不存在（没权限、已经被删掉）。 */
async function listDir(dir, readDir) {
  try {
    const items = await readDir(dir);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/**
 * 走一个目录树，把文件交给 visit。
 *
 * @param {string} dir 起点目录
 * @param {number} depth 还能往下走几层（0 = 只看这一层）
 * @param {Function} readDir 目录读取（测试可以注入假实现）
 * @param {Function} visit 收到 (完整路径, 文件名, 所在目录)
 */
async function walk(dir, depth, readDir, visit) {
  const items = await listDir(dir, readDir);
  for (const item of items) {
    const name = String(item?.name || '');
    if (!name) continue;
    const full = join(dir, name);
    const isDir = typeof item.isDirectory === 'function' && item.isDirectory();
    if (isDir) {
      if (depth > 0 && !SKIP_DIRS.has(name.toLowerCase())) {
        await walk(full, depth - 1, readDir, visit);
      }
      continue;
    }
    visit(full, name, dir);
  }
}

/** Windows 目录在哪（用来认出「系统目录」）。 */
function windowsRoot(env) {
  return String(env.SystemRoot || env.WINDIR || 'C:\\Windows');
}

/** 这个目录是不是 Windows 自己家的目录？ */
function isSystemDir(dir, env) {
  const root = windowsRoot(env).toLowerCase();
  const target = String(dir).toLowerCase();
  return target === root || target.startsWith(root + sep);
}

/** 是不是安装器/升级器（unins000 这种带序号的也算）。 */
function isInstaller(stem) {
  const name = String(stem).toLowerCase();
  if (INSTALLER_NAMES.has(name)) return true;
  if (INSTALLER_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return /^(unins|setup|install|update)\d*$/.test(name);
}

/** 造一条索引记录。id 用小写路径：Windows 上路径不区分大小写，这样才稳定。 */
function makeEntry(name, target, kind, hint) {
  return {
    id: `app:${String(target).toLowerCase()}`,
    name: String(name),
    target: String(target),
    kind: String(kind),
    hint: String(hint || ''),
  };
}

/** PATH 里的目录（Windows 上用 `;` 分隔）。 */
function pathDirs(env) {
  const raw = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = String(raw)
    .split(';')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  return [...new Set(dirs)];
}

/** 装着软件的目录。 */
function programDirs(env) {
  const dirs = [];
  if (env.ProgramFiles) dirs.push(env.ProgramFiles);
  if (env['ProgramFiles(x86)']) dirs.push(env['ProgramFiles(x86)']);
  if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Programs'));
  return dirs;
}

/**
 * 索引要扫哪些目录。
 *
 * @param {object} env 环境变量（测试可以塞一份假的）
 * @returns {Array<{kind: string, dir: string}>}
 */
export function defaultSources(env = process.env) {
  const sources = [];
  const programData = env.ProgramData || 'C:\\ProgramData';
  if (env.APPDATA) {
    sources.push({
      kind: 'shortcut',
      dir: join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    });
  }
  sources.push({
    kind: 'shortcut',
    dir: join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  });
  for (const dir of pathDirs(env)) sources.push({ kind: 'path', dir });
  for (const dir of programDirs(env)) sources.push({ kind: 'program', dir });
  return sources;
}

/** 扫一个来源，返回条目。 */
async function scanSource(source, readDir, env) {
  const out = [];
  const dir = source.dir;
  if (!dir) return out;

  if (source.kind === 'shortcut') {
    await walk(dir, source.depth ?? START_MENU_DEPTH, readDir, (full, name, parent) => {
      if (extname(name).toLowerCase() !== SHORTCUT_EXT) return;
      const label = basename(name, SHORTCUT_EXT);
      if (!label || isInstaller(label)) return;
      // 提示写「在开始菜单的哪个分组里」：那才是用户认得的东西。
      const sub = relative(dir, parent);
      out.push(makeEntry(label, full, 'shortcut', sub || '开始菜单'));
    });
    return out;
  }

  if (source.kind === 'path') {
    await walk(dir, 0, readDir, (full, name) => {
      const ext = extname(name).toLowerCase();
      if (!EXECUTABLE_EXT.has(ext)) return;
      const stem = basename(name, ext);
      if (!stem || isInstaller(stem)) return;
      // 系统目录里只收单子上的那几个：其余是系统组件的碎片。
      if (isSystemDir(dir, env) && !WINDOWS_TOOLS.has(name.toLowerCase())) return;
      out.push(makeEntry(stem, full, 'path', dir));
    });
    return out;
  }

  await walk(dir, source.depth ?? PROGRAM_DEPTH, readDir, (full, name, parent) => {
    if (extname(name).toLowerCase() !== '.exe') return;
    const stem = basename(name, extname(name));
    if (!stem || isInstaller(stem)) return;
    out.push(makeEntry(stem, full, 'program', parent));
  });
  return out;
}

/**
 * 去重：同一个目标、或者同一个名字，都只留一条。
 *
 * 同名要去重：Windows 上同一个程序常常有好几份
 * （System32 一份、商店别名一份），搜「记事本」出来三行一样的字——
 * 那是噪音，不是信息。留下的那一条按**来源顺序**决定：
 * 开始菜单的名字最体面，PATH 次之，程序目录最后。
 */
function dedupe(entries) {
  const seenTarget = new Set();
  const seenName = new Set();
  const out = [];
  for (const entry of entries) {
    const target = entry.target.toLowerCase();
    if (seenTarget.has(target)) continue;
    const name = entry.name.toLowerCase();
    if (seenName.has(name)) continue;
    seenTarget.add(target);
    seenName.add(name);
    out.push(entry);
  }
  return out;
}

/**
 * 扫一遍所有来源。
 *
 * @param {Array<{kind: string, dir: string}>} sources
 * @param {object} [options]
 * @param {Function} [options.readDir] 目录读取（测试注入假实现）
 * @param {object} [options.env] 环境变量
 * @returns {Promise<Array<object>>} 程序条目
 */
export async function scanSources(sources, { readDir = defaultReadDir, env = process.env } = {}) {
  const found = [];
  for (const source of sources || []) {
    found.push(...(await scanSource(source, readDir, env)));
  }
  return dedupe(found);
}

/**
 * 测试与开发用的覆盖口：指向一个 JSON 文件，里面就是程序清单。
 *
 * 与 DESK_PET_TTS_HOSTS / DESK_PET_LLM_BASE_URL 同一个思路——
 * 有了它，E2E 就**不用真的去启动本机程序**（那会在测试机上弹出窗口）。
 */
async function loadOverride(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.apps) ? raw.apps : [];
    return list
      .filter((a) => a && typeof a.target === 'string' && a.target !== '')
      .map((a) =>
        makeEntry(
          String(a.name || basename(a.target)),
          a.target,
          String(a.kind || 'path'),
          String(a.hint || '')
        )
      );
  } catch (err) {
    console.warn('[desk-pet] 程序清单覆盖文件读不了：', err?.message || err);
    return [];
  }
}

/**
 * 程序索引：扫一次、缓存起来，给面板用。
 *
 * @param {object} options
 * @param {object} [options.env] 环境变量（决定扫哪些目录）
 * @param {Array<{kind: string, dir: string}>} [options.sources] 直接指定来源（测试注入）
 * @param {Function} [options.readDir] 目录读取（测试注入）
 * @param {Function} [options.open] 打开一个目标，返回错误描述或 null（成功）
 * @param {Function} [options.now] 取当前时刻
 * @param {number} [options.ttlMs] 索引多久算过期
 */
export function createAppIndex({
  env = process.env,
  sources = null,
  readDir = defaultReadDir,
  open = null,
  now = () => Date.now(),
  ttlMs = 30 * 60 * 1000,
} = {}) {
  let entries = [];
  let builtAt = 0;
  let building = null;
  const listeners = new Set();

  async function build() {
    const override = env.DESK_PET_E2E_APPS;
    const found = override
      ? await loadOverride(override)
      : await scanSources(sources || defaultSources(env), { readDir, env });
    entries = dedupe(found);
    builtAt = now();
    for (const cb of listeners) {
      try {
        cb(entries);
      } catch (err) {
        console.warn('[desk-pet] 程序索引通知失败：', err?.message || err);
      }
    }
    return entries;
  }

  function ensureBuilt() {
    if (!building) {
      building = build()
        .catch((err) => {
          console.warn('[desk-pet] 本机程序索引失败：', err?.message || err);
          return entries;
        })
        .finally(() => {
          building = null;
        });
    }
    return building;
  }

  /**
   * 拿程序清单。
   *
   * 第一次会**等**索引建好（用户正在等结果，等一下才有意义）；
   * 之后过期了就在后台重建，这一回先给旧的——不该为了新鲜感让用户干等。
   */
  async function list() {
    if (!builtAt) {
      await ensureBuilt();
      return entries;
    }
    if (now() - builtAt > ttlMs) void ensureBuilt();
    return entries;
  }

  /** 索引变了就通知（面板要把新清单推给页面）。 */
  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function get(id) {
    return entries.find((e) => e.id === id) || null;
  }

  /**
   * 启动一个程序。
   *
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function launch(id) {
    const entry = get(id);
    if (!entry) return { ok: false, message: '找不到这个程序了' };
    if (typeof open !== 'function') return { ok: false, message: '没法启动程序' };
    try {
      const error = await open(entry.target);
      if (error) return { ok: false, message: `打不开：${error}` };
      return { ok: true, message: `已打开 ${entry.name}` };
    } catch (err) {
      return { ok: false, message: `打不开：${err?.message || err}` };
    }
  }

  return {
    list,
    launch,
    get,
    onChange,
    /** 预热：后台先把索引建好，用户点开面板时就能直接搜。 */
    warm: () => {
      void ensureBuilt();
    },
  };
}
