import { readFile, readdir, stat, mkdir, copyFile, rm, lstat } from 'node:fs/promises';
import { join, resolve, relative, basename, dirname, sep } from 'node:path';
import { readJson, writeJson } from './store.js';
import { detectCubismVersion, settingsFieldForVersion } from '../shared/live2d.js';

// 用户导入的 Live2D 模型：**注册表、校验、导入、删除**都归这里管。
//
// 为什么模型不进程序安装目录：装到 Program Files 下没有写权限，
// 而「让用户自己往 assets/live2d/models/ 里拷模型、还要手写 index.json」
// 根本不算一个功能——那是开发步骤。所以导入的模型一律落在用户数据目录：
//
//   <userData>/live2d/models/<id>/    模型文件（递归复制）
//   <userData>/live2d/registry.json   用户注册表
//
// 内置注册表（assets/live2d/index.json）**一个字节都不动**：
// 它跟着程序走，只读；用户的东西另开一份。

/** 内置模型的 URL 前缀（相对 app:// 根）。 */
export const BUNDLED_MODELS_URL_PREFIX = '/assets/live2d/models';

/** 用户导入模型的 URL 前缀（相对 app:// 根，由 protocol.js 映射到 userData）。 */
export const USER_MODELS_URL_PREFIX = '/__models__';

/** 用户模型目录与注册表在 userData 下的位置。 */
export function userModelsDir(userDataDir) {
  return join(userDataDir, 'live2d', 'models');
}

export function userRegistryDir(userDataDir) {
  return join(userDataDir, 'live2d');
}

// 导入的体积上限。
//
// openDirectory 允许用户误选整个家目录——没有上限，一次手滑就是
// 把几十上百 GB 拷进 userData。Live2D 模型正常在几 MB 到几十 MB，
// 200MB 足够宽松；超了直接报错并说清原因。
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILE_COUNT = 2000;

/** 注册表里的一条形象条目（合并后的统一形状）。 */
function normalizeEntry(entry, { base, source }) {
  if (!entry || typeof entry.id !== 'string' || entry.id.trim() === '') {
    // 没有 id 的条目无法被选中，也无法生成回退路径：直接丢掉，但留痕。
    console.warn('[desk-pet] 形象注册表条目缺少 id，已忽略：', JSON.stringify(entry));
    return null;
  }
  const id = entry.id.trim();
  // 条目里有 model2 就是 Cubism 2 的模型：它的设置文件叫 model2，
  // 不能给它补一个 Cubism 4 的默认 model3 名字——补了的话
  // 渲染层会去找一个根本不存在的 .model3.json。
  const isCubism2 = typeof entry.model2 === 'string' && entry.model2 !== '';
  return {
    ...entry,
    id,
    // 名字缺失时退回 id：下拉框里出现「undefined」比显示 id 更糟。
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
    manifest: entry.manifest || `${id}/pet.json`,
    model3: isCubism2 ? entry.model3 || '' : entry.model3 || `${id}.model3.json`,
    // base 是 URL 前缀，source 决定这个形象能不能被删除。
    base,
    source,
  };
}

/** 读内置注册表（assets/live2d/index.json）。损坏时返回空列表，但必须留痕。 */
async function readBundledRegistry(rootDir) {
  try {
    const text = await readFile(join(rootDir, 'assets', 'live2d', 'index.json'), 'utf8');
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed.models) ? parsed.models : [];
    return list
      .map((entry) => normalizeEntry(entry, { base: BUNDLED_MODELS_URL_PREFIX, source: 'bundled' }))
      .filter(Boolean);
  } catch (err) {
    // 注册表损坏或读不到时静默返回空列表，会让「形象列表是空的」这件事无从排查——
    // 与 settings 损坏同理，必须留痕。
    console.warn('[desk-pet] 形象注册表读取失败：', err?.message);
    return [];
  }
}

/** 读用户注册表。文件不存在是正常情况（还没导入过模型）。 */
export async function readUserRegistry(userDataDir) {
  const raw = await readJson(userRegistryDir(userDataDir), 'registry.json', null, 'live2d/registry.json');
  const list = Array.isArray(raw?.models) ? raw.models : [];
  return list
    .map((entry) => normalizeEntry(entry, { base: USER_MODELS_URL_PREFIX, source: 'user' }))
    .filter(Boolean);
}

async function writeUserRegistry(userDataDir, models) {
  await writeJson(userRegistryDir(userDataDir), 'registry.json', { version: 1, models });
}

/**
 * 读**合并后**的形象注册表：内置 + 用户导入。
 *
 * 两边合成同一个形状（都带 base / source），渲染层于是能用同一段代码
 * 拼 URL，不必知道某个形象是内置的还是导入的。
 *
 * 用户移除掉的内置形象默认**不出现**在这个列表里（见 readRemovedBundled）。
 * includeRemoved 只给「算 id 占用」用：被移除的形象仍然占着它的 id，
 * 用户再导入一个同名的模型时得换个 id，不能撞车。
 */
export async function readMergedRegistry(rootDir, userDataDir, { includeRemoved = false } = {}) {
  const bundled = await readBundledRegistry(rootDir);
  const user = await readUserRegistry(userDataDir);
  if (includeRemoved) return [...bundled, ...user];
  const removed = await readRemovedBundled(userDataDir);
  return [...bundled.filter((m) => !removed.has(m.id)), ...user];
}

/**
 * 用户移除掉的内置形象：一份 id 清单，存在 userData 里。
 *
 * 为什么是「记一份清单」而不是删文件：内置模型躺在程序安装目录下，
 * 装到 Program Files 下根本没有写权限——删不掉。内置注册表
 * （assets/live2d/index.json）也跟着程序走、只读，更不该被改写。
 *
 * 所以「删除内置形象」的实际含义是**从形象列表里移除**：
 * 模型文件仍在程序目录里，清掉这份清单就能让它重新出现。
 */
export async function readRemovedBundled(userDataDir) {
  const raw = await readJson(userRegistryDir(userDataDir), 'removed.json', null, 'live2d/removed.json');
  const list = Array.isArray(raw?.models) ? raw.models : [];
  return new Set(list.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()));
}

/** 把一个内置形象标记为「已移除」（只记清单，不动程序目录里的文件）。 */
export async function removeBundledModel({ id, userDataDir }) {
  const removed = await readRemovedBundled(userDataDir);
  removed.add(id);
  await writeJson(userRegistryDir(userDataDir), 'removed.json', {
    version: 1,
    models: [...removed],
  });
  return { id };
}


/**
 * 这是哪种 Cubism 格式的设置文件。
 *
 * 规则本身在 src/shared/live2d.js：主进程与渲染层共用同一份，
 * 否则会出现「导入时认得是 Cubism 2，加载时当成 Cubism 4」。
 */
export { detectCubismVersion, settingsFieldForVersion };

/** 读一个 JSON 文件；读不了或不是 JSON 返回 null。 */
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 在目录里找模型设置文件，返回**模型根目录**、文件名与格式版本。
 *
 * 模型根目录 = 设置文件自己的目录。这一点不是洁癖：
 * pixi-live2d-display 用 `url.resolve(settings.url, path)` 解析纹理、
 * 动作与表情（相对设置文件），根目录选错，相对路径就全错，
 * 表现是「模型加载成功但没有纹理」。
 *
 * 根目录优先；根下没有就找**一层子目录**——用户选了装着模型文件夹的
 * 父目录时，模型根目录应当是那个子目录。
 *
 * 找法是「逐个 JSON 读一遍，看内容像不像设置文件」：
 * 文件名靠不住（Cubism 2 的可能叫 model0.json、也可能叫别的）。
 */
export async function findModelSettingsFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  // 候选：根目录下的 .json 文件，再加一层子目录下的。
  const candidates = [];
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
      candidates.push({ modelRoot: dir, file: e.name });
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const sub = join(dir, e.name);
    let subEntries;
    try {
      subEntries = await readdir(sub, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const se of subEntries) {
      if (se.isFile() && se.name.toLowerCase().endsWith('.json')) {
        candidates.push({ modelRoot: sub, file: se.name });
      }
    }
  }

  // 逐个读，按内容判别。Cubism 4 优先（更新的格式先用）。
  const hits = [];
  for (const c of candidates) {
    const json = await readJsonOrNull(join(c.modelRoot, c.file));
    const version = detectCubismVersion(json);
    if (version === 0) continue;
    hits.push({ ...c, version, name: typeof json?.name === 'string' ? json.name : '' });
  }
  if (hits.length === 0) return null;

  // 根目录的优先于子目录的；同一层里 Cubism 4 优先于 Cubism 2。
  hits.sort((a, b) => {
    const depthA = a.modelRoot === dir ? 0 : 1;
    const depthB = b.modelRoot === dir ? 0 : 1;
    if (depthA !== depthB) return depthA - depthB;
    if (a.version !== b.version) return b.version - a.version;
    return a.file.localeCompare(b.file);
  });
  return { ...hits[0], ambiguous: hits.length > 1 };
}

/**
 * 把模型清单里引用的相对路径解析成磁盘路径，并确保它**留在模型目录内**。
 *
 * 越界一律返回 null：模型清单是用户提供的文件，它指向
 * `../../../../Windows/System32/...` 不该被我们照单全收。
 */
function resolveInside(modelRoot, relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  // Live2D 清单用正斜杠；Windows 上反斜杠也能见到，统一成相对路径再解析。
  const normalized = relPath.replace(/\\/g, '/');
  const target = resolve(modelRoot, normalized);
  const root = resolve(modelRoot);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function fileExists(p) {
  if (!p) return false;
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * 读模型目录里自带的 pet.json；没有、读不了或不是 JSON 都返回 null
 * （调用方据此生成一份自己的）。
 */
async function readPetJson(modelRoot) {
  try {
    const text = await readFile(join(modelRoot, 'pet.json'), 'utf8');
    const json = JSON.parse(text);
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/**
 * 校验一个模型目录能不能被加载。
 *
 * 一次报出**所有**问题，而不是撞上第一个就退出：用户导不进去时，
 * 一次看到「缺 moc3、缺纹理 texture_01.png」比来回试三遍有用得多。
 *
 * 两种格式的字段位置不一样，这里按 detectCubismVersion 判出来的版本
 * 分别检查：
 *   - Cubism 4：FileReferences.Moc（.moc3）与 FileReferences.Textures
 *   - Cubism 2：model（.moc）与 textures
 */
export async function inspectModelDir(modelRoot, settingsName) {
  const errors = [];
  const abs = join(modelRoot, settingsName);

  let json = null;
  try {
    json = JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      errors: [`无法解析 ${settingsName}：${err?.message || err}`],
      info: null,
    };
  }

  const version = detectCubismVersion(json);
  if (version === 0) {
    errors.push(
      `${settingsName} 不像是 Live2D 模型设置文件` +
        '（Cubism 4 应该有 FileReferences，Cubism 2 应该有 model 与 textures）'
    );
    return { ok: false, errors, info: null };
  }

  // 模型本体（.moc3 / .moc）与纹理的位置按格式分。
  const mocRef = version === 4 ? json.FileReferences.Moc : json.model;
  const textures = version === 4 ? json.FileReferences.Textures : json.textures;

  if (typeof mocRef !== 'string' || mocRef === '') {
    errors.push(`${settingsName} 里没有指定模型文件（${version === 4 ? 'FileReferences.Moc' : 'model'}）`);
  } else {
    const moc = resolveInside(modelRoot, mocRef);
    if (!moc) {
      errors.push(`${settingsName} 里的模型文件路径越出了模型目录：${mocRef}`);
    } else if (!(await fileExists(moc))) {
      errors.push(`缺少模型文件 ${mocRef}`);
    }
  }

  if (!Array.isArray(textures) || textures.length === 0) {
    errors.push(`${settingsName} 里没有指定纹理`);
  }
  for (const t of Array.isArray(textures) ? textures : []) {
    if (typeof t !== 'string' || t === '') continue;
    const tex = resolveInside(modelRoot, t);
    if (!tex) {
      errors.push(`${settingsName} 里的纹理路径越出了模型目录：${t}`);
    } else if (!(await fileExists(tex))) {
      errors.push(`缺少纹理 ${t}`);
    }
  }

  // 动作文件也要在：模型加载时找不到动作只会静默跳过，
  // 但「文件其实没跟着拷过来」是个值得说清楚的问题。
  const motionGroups = version === 4 ? json.FileReferences.Motions : json.motions;
  const missingMotions = [];
  for (const [group, entries] of Object.entries(motionGroups || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const file = entry?.File || entry?.file;
      if (typeof file !== 'string' || file === '') continue;
      const p = resolveInside(modelRoot, file);
      if (!p || !(await fileExists(p))) missingMotions.push(`${group}/${file}`);
    }
  }
  if (missingMotions.length > 0) {
    errors.push(`缺少动作文件：${missingMotions.slice(0, 5).join('、')}${missingMotions.length > 5 ? ' 等' : ''}`);
  }

  const info = {
    // 清单里的 Name 不是每个模型都有；没有就用文件夹名（调用方兜底）。
    name: typeof json?.Name === 'string' && json.Name.trim() !== '' ? json.Name.trim() : '',
    version,
    expressionCount:
      version === 4
        ? (Array.isArray(json.FileReferences.Expressions) ? json.FileReferences.Expressions.length : 0)
        : (Array.isArray(json.expressions) ? json.expressions.length : 0),
    motionGroups: Object.keys(motionGroups || {}),
  };

  return { ok: errors.length === 0, errors, info };
}

/**
 * 收集目录里的普通文件。
 *
 * **只收普通文件**：符号链接跳过（它可能指向模型目录之外的地方），
 * 套接字/管道之类的特殊文件也跳过。顺带在这里把体积上限守住，
 * 超限立刻停——不必等到拷完才发现拷了几百 GB。
 */
async function collectFiles(dir, budget = { bytes: 0, files: 0 }, base = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      await collectFiles(abs, budget, base, out);
      continue;
    }
    if (!e.isFile()) continue;
    let st;
    try {
      st = await lstat(abs);
    } catch {
      continue;
    }
    budget.bytes += st.size;
    budget.files += 1;
    if (budget.bytes > MAX_TOTAL_BYTES) {
      throw new Error(`模型文件夹超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限，已中止复制。`);
    }
    if (budget.files > MAX_FILE_COUNT) {
      throw new Error(`模型文件夹的文件数超过 ${MAX_FILE_COUNT} 个上限，已中止复制。`);
    }
    out.push({ abs, rel: relative(base, abs), size: st.size });
  }
  return out;
}

/** 把 id 规整成能当目录名、也能当 URL 片段的形式。 */
export function slugifyModelId(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // 中文名之类slug 之后什么都不剩：给个兜底名，靠后面的序号去重。
  return s || 'model';
}

/** 在已用过的 id 里找一个不冲突的：foo → foo-2 → foo-3。 */
export function uniqueModelId(base, taken) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 导入一个 Live2D 模型目录。
 *
 * 流程：定位模型根目录 → 生成不冲突的 id → 复制 → **校验复制结果** →
 * 写 pet.json → 写注册表。任一步失败都把已复制的目录删掉，
 * 不留半截模型在用户数据目录里（下次导入同名模型会撞上残留目录）。
 */
export async function importModelDir({ sourceDir, rootDir, userDataDir, onProgress }) {
  const found = await findModelSettingsFile(sourceDir);
  if (!found) {
    throw new Error(
      '所选文件夹里没有找到 Live2D 模型设置文件——' +
        '请选择包含 .model3.json（Cubism 4）或 .model.json（Cubism 2）的文件夹。'
    );
  }
  if (found.ambiguous) {
    console.warn('[desk-pet] 所选目录里有多个模型设置文件，取第一个：', found.file);
  }
  // 设置文件在注册表里的字段名按格式分：model3 是 Cubism 4，model2 是 Cubism 2。
  const formatField = settingsFieldForVersion(found.version);

  // 复制**模型根目录**，不是用户选的那个目录：多套一层目录，
  // 相对路径（纹理、动作）就全指向不存在的位置了。
  const sourceRoot = found.modelRoot;
  const sourceRootName = basename(sourceRoot);

  const modelsDir = userModelsDir(userDataDir);
  await mkdir(modelsDir, { recursive: true });

  // id 去重：内置与用户导入的形象都要算上——撞上内置的 id 会让
  // 注册表里出现两条同 id 的条目，而「取第一个」的规则会让用户
  // 刚导入的模型选了却切不过去。
  // 被用户移除掉的内置形象**仍然占着 id**：它还在程序目录里，
  // 用户随时能恢复，导入一个同 id 的模型会让两条记录指向不同的目录。
  const existing = await readMergedRegistry(rootDir, userDataDir, { includeRemoved: true });
  const takenIds = existing.map((m) => m.id);
  const id = uniqueModelId(slugifyModelId(sourceRootName), takenIds);

  const destRoot = join(modelsDir, id);
  const files = await collectFiles(sourceRoot);
  if (files.length === 0) {
    throw new Error('所选文件夹里没有可复制的文件。');
  }

  onProgress?.({ phase: 'copy', copied: 0, total: files.length, file: '' });
  try {
    let copied = 0;
    for (const f of files) {
      const dest = join(destRoot, f.rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(f.abs, dest);
      copied += 1;
      onProgress?.({ phase: 'copy', copied, total: files.length, file: basename(f.rel) });
    }

    // 校验**复制之后**的目录：要验的是真正会被加载的那一份，
    // 而不是用户挑的那个源目录。
    const check = await inspectModelDir(destRoot, found.file);
    if (!check.ok) {
      throw new Error(`模型文件不完整：\n${check.errors.map((e) => `· ${e}`).join('\n')}`);
    }

    // 清单里的 Name 优先；没有就用文件夹名。
    const name = check.info?.name || sourceRootName;

    // pet.json：用户自带了就用他自带的，没带才生成一份。
    //
    // 用户自带的 pet.json 里可能有**表情语义映射**（下面「语义键」一节
    // 讲的那种）——那是他特意写的，不该被我们生成的空清单盖掉。
    // 但它的设置文件字段必须指向真实存在的文件：清单里的字段优先于
    // 注册表（见 renderer/pet/manifest.js），填错了模型根本加载不出来。
    const kept = await readPetJson(destRoot);
    if (!kept) {
      // 生成一份。
      //
      // **不写 expressions**：探测阶段不猜语义是本项目的既有原则
      // （见 renderer/pet/manifest.js 的 deriveManifest）——
      // 猜错的后果是「摸头」触发生气的脸，比不猜更糟。
      // 导入的模型因此走既有降级路径：只播动作、不套表情。
      const pet = {
        id,
        name,
        [formatField]: found.file,
        viewport: { width: 300, height: 560 },
        fit: { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] },
      };
      await writeJson(destRoot, 'pet.json', pet);
    } else {
      // 自带的 pet.json 指向了不存在的设置文件：不能用它。
      // 报出来而不是悄悄换成我们那份——用户能看见自己写错了什么。
      const keptFile = kept[formatField];
      if (keptFile && !(await fileExists(join(destRoot, keptFile)))) {
        throw new Error(
          `pet.json 里的 ${formatField} 指向了不存在的文件：${keptFile}\n` +
            `（该目录里实际的是 ${found.file}）`
        );
      }
    }

    const entry = {
      id,
      name,
      [formatField]: found.file,
      manifest: `${id}/pet.json`,
    };
    // 写注册表前重读一次：复制是个耗时的操作，期间用户可能又导了一个。
    // 直接用复制前读的那份会把别人的新条目覆盖掉。
    const currentRegistry = await readUserRegistry(userDataDir);
    await writeUserRegistry(userDataDir, [...currentRegistry, entry]);

    onProgress?.({ phase: 'done', copied: files.length, total: files.length, file: '' });
    return { ...entry, base: USER_MODELS_URL_PREFIX, source: 'user' };
  } catch (err) {
    // 回滚：删掉已复制的目录。留下半截模型只会让下次导入撞上残留。
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 删除一个导入的模型：移出注册表 + 删掉它的目录。
 *
 * 只有 `source === 'user'` 的能删——内置模型是程序的一部分，
 * 删它等于删程序。
 */
export async function deleteImportedModel({ id, userDataDir }) {
  const userRegistry = await readUserRegistry(userDataDir);
  const entry = userRegistry.find((m) => m.id === id);
  if (!entry) {
    throw new Error(`未找到导入的模型：${id}`);
  }
  await writeUserRegistry(
    userDataDir,
    userRegistry.filter((m) => m.id !== id),
  );
  await rm(join(userModelsDir(userDataDir), id), { recursive: true, force: true });
  return { id, name: entry.name };
}
