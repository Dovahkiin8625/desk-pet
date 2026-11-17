import { readFile, readdir, stat, mkdir, copyFile, rm, lstat, open, writeFile } from 'node:fs/promises';
import { join, resolve, relative, basename, dirname, sep } from 'node:path';
import { readJson, writeJson } from './store.js';
import { detectCubismVersion, settingsFieldForVersion } from '../shared/live2d.js';
import { SPINE_TYPE } from '../shared/spine.js';
import { VIDEO_TYPE } from '../shared/video.js';
import { findSpineVariant, isSpineGameConfig, planSpineImport } from './spineModels.js';
import { readAvatarJson, planVideoImport } from './videoModels.js';

// 用户导入的形象模型：**注册表、校验、导入、删除**都归这里管。
//
// 为什么模型不进程序安装目录：装到 Program Files 下没有写权限，
// 而「让用户自己往 assets/models/ 里拷模型、还要手写 index.json」
// 根本不算一个功能——那是开发步骤。所以导入的模型一律落在用户数据目录：
//
//   <userData>/models/<id>/    模型文件（递归复制）
//   <userData>/models/registry.json   用户注册表
//
// 内置注册表（assets/models/index.json）**一个字节都不动**：
// 它跟着程序走，只读；用户的东西另开一份。

/** 内置模型的 URL 前缀（相对 app:// 根）。 */
export const BUNDLED_MODELS_URL_PREFIX = '/assets/models';

/** 用户导入模型的 URL 前缀（相对 app:// 根，由 protocol.js 映射到 userData）。 */
export const USER_MODELS_URL_PREFIX = '/__models__';

/** 用户模型目录与注册表在 userData 下的位置。 */
export function userModelsDir(userDataDir) {
  return join(userDataDir, 'models');
}

export function userRegistryDir(userDataDir) {
  return join(userDataDir, 'models');
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
  // Spine 模型没有「设置文件」：它的骨架与图集在 pet.json 里点名。
  const isSpine = entry.type === SPINE_TYPE;
  // 视频形象同理：骨架是 avatar.json 本身。
  const isVideo = entry.type === VIDEO_TYPE;
  return {
    ...entry,
    id,
    // 名字缺失时退回 id：下拉框里出现「undefined」比显示 id 更糟。
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
    manifest: entry.manifest || (isVideo ? `${id}/avatar.json` : `${id}/pet.json`),
    model3: isVideo || isSpine
      ? entry.model3 || ''
      : isCubism2
        ? entry.model3 || ''
        : entry.model3 || `${id}.model3.json`,
    // base 是 URL 前缀，source 决定这个形象能不能被删除。
    base,
    source,
  };
}

/** 读内置注册表（assets/models/index.json）。损坏时返回空列表，但必须留痕。 */
async function readBundledRegistry(rootDir) {
  try {
    const text = await readFile(join(rootDir, 'assets', 'models', 'index.json'), 'utf8');
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
  const raw = await readJson(userRegistryDir(userDataDir), 'registry.json', null, 'models/registry.json');
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
 * （assets/models/index.json）也跟着程序走、只读，更不该被改写。
 *
 * 所以「删除内置形象」的实际含义是**从形象列表里移除**：
 * 模型文件仍在程序目录里，清掉这份清单就能让它重新出现。
 */
export async function readRemovedBundled(userDataDir) {
  const raw = await readJson(userRegistryDir(userDataDir), 'removed.json', null, 'models/removed.json');
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

/** 读文件开头的几个字节；读不到返回空串。 */
async function readMagic(path, len = 4) {
  try {
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, 0);
      return buf.subarray(0, bytesRead).toString('latin1');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/**
 * 这是不是图片文件？看字节头，不看扩展名——
 * 解包出来的资源常常没有扩展名（Textures_0_0 而不是 Textures_0_0.png）。
 */
async function isImageFile(path) {
  const magic = await readMagic(path, 12);
  if (magic.startsWith('\x89PNG')) return true;
  if (magic.startsWith('\xff\xd8\xff')) return true;
  if (magic.startsWith('GIF8')) return true;
  if (magic.startsWith('RIFF') && magic.slice(8, 12) === 'WEBP') return true;
  if (magic.startsWith('BM')) return true;
  return false;
}

/**
 * 这是**不是 Cubism** 的模型格式？
 *
 * 有些游戏用的是 Spine（棕色尘埃2、NIKKE 等）：设置文件里没有 moc、
 * 没有纹理，只有 skeleton（骨骼）与 atlases（图集）。那种格式本程序**能**渲染
 * （见 spineModels.js），这里只留「不是 Spine、也认不出来」的那些。
 */
function isForeignGameModel(json) {
  return !!json && typeof json === 'object'
    && json.skeleton !== undefined
    && json.atlases !== undefined
    && !isSpineGameConfig(json);
}

/**
 * 说清这是哪种非 Cubism 格式——给用户看的，得具体。
 *
 * Spine 的骨架文件里有个 "spine" 字段（版本号），
 * 看到它就能确定是 Spine；否则只说是游戏自有格式。
 *
 * 清单里点名的 skeleton 文件有时根本不存在（游戏自己都指向了
 * skeleton_0，实际发的却是 skeleton_1/3/6），所以还要在目录里
 * 扫一遍 skeleton*.json。
 */
async function describeForeignFormat(modelRoot, json) {
  const candidates = [];
  const skeletonRef = typeof json.skeleton === 'string' ? json.skeleton : '';
  // 解包出来的资源常常没有扩展名：skeleton_0 与 skeleton_0.json 都要试。
  if (skeletonRef) candidates.push(skeletonRef, `${skeletonRef}.json`);
  try {
    const entries = await readdir(modelRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && /^skeleton/i.test(e.name)) candidates.push(e.name);
    }
  } catch {
    // 目录读不了就只按清单里点名的那个判断。
  }
  for (const name of candidates) {
    const p = resolveInside(modelRoot, name);
    if (!p) continue;
    const skeleton = await readJsonOrNull(p);
    if (skeleton && typeof skeleton === 'object') {
      const spine = skeleton.spine ?? skeleton.skeleton?.spine;
      if (spine) return `Spine 骨骼动画（${spine}，运行时只读得懂 4.1）`;
    }
    // Spine 的骨骼也可能是**二进制**的：文件头里带着版本号（3.8.99、4.1.24…）。
    const head = await readMagic(p, 256);
    if (/\d+\.\d+\.\d+/.test(head)) return 'Spine 骨骼动画（骨架版本不是 4.1，运行时读不懂）';
  }
  return '游戏自有的 Live2D 运行时格式（skeleton / atlases 资源）';
}

/**
 * 候选设置文件的可信度：它引用的模型与纹理有多少**真的在这个目录里**。
 *
 * 有些游戏会随模型附带一份**样例**设置文件（内容也像设置文件，
 * 指向的却是游戏自带的样板模型，文件根本不在这个目录里）。
 * 只看内容挑不出真身，得看它引用的文件在不在。
 */
async function scoreSettingsFile(modelRoot, json, version) {
  const mocRef = version === 4 ? json?.FileReferences?.Moc : json?.model;
  const textures = version === 4 ? json?.FileReferences?.Textures : json?.textures;
  const refs = [mocRef, ...(Array.isArray(textures) ? textures : [])].filter(
    (r) => typeof r === 'string' && r !== ''
  );
  if (refs.length === 0) return 0;
  let hit = 0;
  for (const ref of refs) {
    const p = resolveInside(modelRoot, ref);
    if (p && (await fileExists(p))) hit += 1;
  }
  return hit / refs.length;
}

/**
 * 一个目录里的候选设置文件：逐个读，按内容判别，按可信度打分。
 *
 * 返回 hits（像设置文件的）与 foreign（非 Cubism、也不是 Spine 的）。
 */
async function collectSettingsHits(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const hits = [];
  let foreign = null;
  let spineConfigFile = '';
  // 视频形象：目录根有 avatar.json 且 type 为 video。
  // 它的优先级高于一切——avatar.json 是这个程序自己的格式，
  // 作者放这么一个文件就是冲着视频形象来的。
  const avatar = await readAvatarJson(dir);
  if (avatar.problem) {
    foreign = { modelRoot: dir, file: 'avatar.json', foreign: true, reason: avatar.problem };
  } else if (avatar.avatar) {
    hits.push({
      modelRoot: dir,
      file: 'avatar.json',
      kind: 'video',
      version: 0,
      score: 100,
      name: typeof avatar.avatar.name === 'string' ? avatar.avatar.name : '',
    });
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
    const c = { modelRoot: dir, file: e.name };
    const json = await readJsonOrNull(join(dir, e.name));
    const version = detectCubismVersion(json);
    if (version === 0) {
      // Spine 配置：整个目录合成**一个**候选项（变体的挑选在目录内做）。
      if (isSpineGameConfig(json)) {
        if (!spineConfigFile) spineConfigFile = e.name;
        continue;
      }
      // 非 Cubism 格式：记下来，好给出准确的原因，
      // 而不是一句「没找到设置文件」。
      if (!foreign && isForeignGameModel(json)) {
        foreign = { ...c, foreign: true, reason: await describeForeignFormat(dir, json) };
      }
      continue;
    }
    hits.push({
      ...c,
      kind: 'live2d',
      version,
      score: await scoreSettingsFile(dir, json, version),
      name: typeof json?.name === 'string' ? json.name : '',
    });
  }
  if (spineConfigFile) {
    const variant = await findSpineVariant(dir);
    if (variant) {
      hits.push({
        modelRoot: dir,
        file: variant.configFile,
        kind: 'spine',
        version: 0,
        score: 1,
        variant,
      });
    } else if (!foreign) {
      // 是 Spine 配置，但骨架版本读不了：说清楚为什么导不了。
      foreign = {
        modelRoot: dir,
        file: spineConfigFile,
        foreign: true,
        reason: 'Spine 骨骼动画（没有找到 4.1 的骨架，运行时读不懂）',
      };
    }
  }
  return { hits, foreign };
}

/** 候选之间怎么排序：引用文件真的存在的那份优先；再是 Cubism 4 优先于 2；最后按文件名。 */
function compareHits(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind !== b.kind) return a.kind === 'live2d' ? -1 : 1;
  if (a.version !== b.version) return b.version - a.version;
  return a.file.localeCompare(b.file);
}

/**
 * 只在**这一个目录**里找模型设置文件（不看子目录）。
 *
 * 找不到时返回 null——批量导入要靠它区分
 * 「这个目录自己就是一个模型」与「这个目录里装着若干个模型」。
 */
export async function findSettingsInDir(dir) {
  const { hits, foreign } = await collectSettingsHits(dir);
  if (hits.length === 0) return foreign;
  hits.sort(compareHits);
  return { ...hits[0], ambiguous: hits.length > 1 };
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
 * 内容像还不够——同一个目录里可能有好几份像的，
 * 引用文件真的存在的那份才是模型自己的。
 */
export async function findModelSettingsFile(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  // 候选：根目录下的 .json 文件，再加一层子目录下的。
  const root = await collectSettingsHits(dir);
  const hits = root.hits.map((h) => ({ ...h, depth: 0 }));
  let foreign = root.foreign;

  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const sub = await collectSettingsHits(join(dir, e.name));
    for (const h of sub.hits) hits.push({ ...h, depth: 1 });
    if (!foreign && sub.foreign) foreign = sub.foreign;
  }
  if (hits.length === 0) return foreign;

  // 引用文件真的存在的那份优先；再是根目录优先于子目录，
  // 同一层里 Cubism 4 优先于 Cubism 2。
  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.kind !== b.kind) return a.kind === 'live2d' ? -1 : 1;
    if (a.version !== b.version) return b.version - a.version;
    return a.file.localeCompare(b.file);
  });
  return { ...hits[0], ambiguous: hits.length > 1 };
}

/**
 * 用户选中的文件夹里装着几个模型？
 *
 * - 'single'：这个目录自己就是一个模型（根目录里有设置文件）。
 * - 'batch'：这个目录是个**模型仓库**，一层子目录里各有一个模型。
 * - 'none'：哪儿都没有模型。
 *
 * 区分前两者是必要的：以前选了「装着很多模型」的父目录，
 * 只会导入排在最前面的那一个，用户以为导入失败。
 *
 * 非 Cubism 格式的模型（Spine 之类）不算模型，但**原因要带出去**：
 * 静默跳过等于让用户以为那个目录是空的。
 */
export async function scanModelDirs(dir) {
  const own = await findSettingsInDir(dir);
  if (own && !own.foreign) return { mode: 'single', dirs: [dir], foreignDirs: [] };

  const dirs = [];
  const foreignDirs = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const sub = join(dir, e.name);
    const hit = await findSettingsInDir(sub);
    if (!hit) continue;
    if (hit.foreign) foreignDirs.push({ dir: sub, file: hit.file, reason: hit.reason });
    else dirs.push(sub);
  }
  if (dirs.length > 0) return { mode: 'batch', dirs, foreignDirs };
  // 根目录不是模型，但子目录里是「非 Cubism 格式」的模型：
  // 也要把原因带出去，别只说一句「没找到」。
  if (own?.foreign) {
    return { mode: 'foreign', dirs: [], foreignDirs: [{ dir, file: own.file, reason: own.reason }] };
  }
  if (foreignDirs.length > 0) return { mode: 'foreign', dirs: [], foreignDirs };
  return { mode: 'none', dirs: [], foreignDirs: [] };
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
    } else {
      // 文件在，但未必是 moc：字节头不对的要么是文件坏了，
      // 要么是游戏的 Live2D 资源被加密过（解包工具没能解密）。
      // 这种文件在渲染层只会得到一句 "Invalid moc data"，看不出原因。
      const magic = await readMagic(moc, 4);
      const expected = version === 4 ? 'MOC3' : 'moc';
      if (!magic.startsWith(expected)) {
        errors.push(
          `模型文件 ${mocRef} 不是有效的 moc（文件可能已损坏，或被游戏的资源加密过）`
        );
      }
    }
  }

  if (!Array.isArray(textures) || textures.length === 0) {
    errors.push(`${settingsName} 里没有指定纹理`);
  }
  let encryptedTextures = 0;
  for (const t of Array.isArray(textures) ? textures : []) {
    if (typeof t !== 'string' || t === '') continue;
    const tex = resolveInside(modelRoot, t);
    if (!tex) {
      errors.push(`${settingsName} 里的纹理路径越出了模型目录：${t}`);
    } else if (!(await fileExists(tex))) {
      errors.push(`缺少纹理 ${t}`);
    } else if (!(await isImageFile(tex))) {
      encryptedTextures += 1;
    }
  }
  if (encryptedTextures > 0) {
    errors.push(
      `纹理文件不是图片（${encryptedTextures} 个）：整个资源包都是加密的，` +
        '解包工具没能解密——需要用带解密密钥的方式重新解包'
    );
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

/**
 * 去掉设置文件里空的纹理引用，返回是否改动了文件。
 *
 * 有的游戏在资源清单里留了空条目（textures 数组末尾多一个空字符串）。
 * 渲染层会照着去加载那个空文件名，纹理加载直接失败，
 * 而报错只有一句「Texture loading error」，看不出是哪一条引用出的问题。
 */
async function stripEmptyTextureRefs(destRoot, settingsName, version) {
  const json = await readJsonOrNull(join(destRoot, settingsName));
  if (!json) return false;
  const list = version === 4 ? json.FileReferences?.Textures : json.textures;
  if (!Array.isArray(list)) return false;
  const cleaned = list.filter((t) => typeof t === 'string' && t !== '');
  if (cleaned.length === list.length) return false;
  if (version === 4) json.FileReferences.Textures = cleaned;
  else json.textures = cleaned;
  await writeJson(destRoot, settingsName, json);
  return true;
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
  if (found.foreign) {
    throw new Error(
      `所选文件夹里的 ${found.file} 不是 Cubism 模型（${found.reason || '非 Cubism 格式'}），` +
        '桌宠用 Cubism Core 渲染不了它。请换用 Cubism 2 / Cubism 4 格式的模型。'
    );
  }
  if (found.kind === 'spine') {
    return importSpineModelDir({ sourceDir, variant: found.variant, rootDir, userDataDir, onProgress });
  }
  if (found.kind === 'video') {
    return importVideoModelDir({ sourceDir, rootDir, userDataDir, onProgress });
  }
  if (found.ambiguous) {
    console.warn('[desk-pet] 所选目录里有多个模型设置文件，取其中最可信的：', found.file);
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

    // 设置文件里混着空引用（游戏的资源清单没清干净）时，
    // 渲染层会照着去加载一个空文件名，纹理加载直接失败。
    // 那是清单的垃圾，不是模型的一部分——导入时清掉。
    if (await stripEmptyTextureRefs(destRoot, found.file, found.version)) {
      console.warn('[desk-pet] 设置文件里有空的纹理引用，已在导入时清除：', found.file);
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
 * 导入一个**视频**形象目录。
 *
 * 与 Spine 的导入流程同构，但复制的东西要少得多：
 * avatar.json + 被引用到的视频文件。缺失的条目（file: null）直接剔除，
 * 原因带出去给用户看；没有一条可用视频才算失败。
 */
async function importVideoModelDir({ sourceDir, rootDir, userDataDir, onProgress }) {
  const name = basename(sourceDir);
  const existing = await readMergedRegistry(rootDir, userDataDir, { includeRemoved: true });
  const takenIds = existing.map((m) => m.id);
  const base = slugifyModelId(name) || 'video';
  const id = uniqueModelId(base, takenIds);

  const destRoot = join(userModelsDir(userDataDir), id);
  try {
    const plan = await planVideoImport(sourceDir, { id, name });

    onProgress?.({ phase: 'copy', copied: 0, total: plan.files.length, file: '' });
    let copied = 0;
    for (const f of plan.files) {
      const dest = join(destRoot, f.to);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(f.from, dest);
      copied += 1;
      onProgress?.({ phase: 'copy', copied, total: plan.files.length, file: basename(f.to) });
    }
    // 规整后的清单：缺失的条目已剔除，id/name 已填好。
    await writeJson(destRoot, 'avatar.json', plan.pet);

    // 跳过的条目打到控制台：注册表条目不留警告，
    // 用户只在导入这一次看到「缺了什么」。
    for (const w of plan.warnings) {
      console.warn('[desk-pet] 视频形象导入：', w);
    }

    const entry = { id, name: plan.pet.name, type: VIDEO_TYPE, manifest: `${id}/avatar.json` };
    const currentRegistry = await readUserRegistry(userDataDir);
    await writeUserRegistry(userDataDir, [...currentRegistry, entry]);

    onProgress?.({ phase: 'done', copied, total: copied, file: '' });
    return {
      ...entry,
      base: USER_MODELS_URL_PREFIX,
      source: 'user',
      // 导入结果里带上警告：设置窗口可以直接显示「缺了什么」，
      // 而不是让用户去猜桌宠为什么不会比心。
      warnings: plan.warnings,
    };
  } catch (err) {
    await rm(destRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * 导入一个 **Spine** 模型目录。
 *
 * 与 Live2D 的导入流程同构，但复制的东西不一样：
 * 游戏那套目录里还有一堆语音、别的角色、过场动画——全拷进来既慢又占地方。
 * 这里只复制挑中的那一份骨架、图集与纹理，并把文件名整理成 Spine 的规矩
 * （见 spineModels.js）。
 */
async function importSpineModelDir({ sourceDir, variant, rootDir, userDataDir, onProgress }) {
  const name = basename(sourceDir);
  const existing = await readMergedRegistry(rootDir, userDataDir, { includeRemoved: true });
  const takenIds = existing.map((m) => m.id);
  // 目录名是中文时 slug 之后什么都不剩：退回骨架文件名。
  const base = slugifyModelId(name) || slugifyModelId(variant.skeleton.name) || 'spine';
  const id = uniqueModelId(base, takenIds);

  const destRoot = join(userModelsDir(userDataDir), id);
  await mkdir(destRoot, { recursive: true });
  try {
    const plan = await planSpineImport(variant, { id, name });

    let bytes = 0;
    for (const f of plan.files) bytes += (await stat(f.from)).size;
    if (bytes > MAX_TOTAL_BYTES) {
      throw new Error(`模型文件超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限，已中止复制。`);
    }

    onProgress?.({ phase: 'copy', copied: 0, total: plan.files.length, file: '' });
    let copied = 0;
    for (const f of plan.files) {
      await copyFile(f.from, join(destRoot, f.to));
      copied += 1;
      onProgress?.({ phase: 'copy', copied, total: plan.files.length, file: basename(f.to) });
    }
    await writeFile(join(destRoot, 'model.atlas'), plan.atlasText, 'utf8');
    await writeJson(destRoot, 'pet.json', plan.pet);

    const entry = { id, name, type: SPINE_TYPE, manifest: `${id}/pet.json` };
    const currentRegistry = await readUserRegistry(userDataDir);
    await writeUserRegistry(userDataDir, [...currentRegistry, entry]);

    onProgress?.({ phase: 'done', copied, total: copied, file: '' });
    return { ...entry, base: USER_MODELS_URL_PREFIX, source: 'user' };
  } catch (err) {
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
