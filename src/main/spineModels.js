import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SPINE_TYPE } from '../shared/spine.js';

// 导入游戏里的 **Spine 骨骼动画** 模型。
//
// 有些游戏（棕色尘埃2、NIKKE 等）用的不是 Cubism，而是 Spine：
// 设置文件里没有 moc、没有纹理，只有 skeleton（骨骼）与 atlases（图集），
// 动画数据在 skeleton 与 .atlas 里。
//
// 游戏那套文件名不是 Spine 的规矩（图集叫 atlases_0_atlas_1、页面叫
// cutscene_char004192.png、纹理叫 atlases_0_textures_0_1.png），
// 直接丢给运行时是加载不出来的。所以导入时做一次**改名整理**：
//
//   model0.json                 →  不复制（那是游戏的配置，运行时用不上）
//   skeleton_1                  →  model.skel
//   atlases_0_atlas_1           →  model.atlas（页面名改成 0.png、1.png…）
//   atlases_0_textures_0_1.png  →  0.png
//
// 整理之后就是一套**标准 Spine 模型目录**，运行时按标准规矩加载即可。
//
// 这里只做「看」与「算」：复制、写清单、写注册表由 live2dModels.js 负责
// （那边才有用户模型目录与注册表的读写）。

/**
 * 这是不是游戏的 Spine 模型配置。
 *
 * 判别靠**内容**：配置文件里有 skeleton（骨架文件）与 atlases（图集列表）。
 * Spine 自己的骨架 JSON 里也有 skeleton 字段，但没有 atlases —— 两者不混。
 */
export function isSpineGameConfig(json) {
  return (
    !!json &&
    typeof json === 'object' &&
    typeof json.skeleton === 'string' &&
    json.skeleton !== '' &&
    Array.isArray(json.atlases)
  );
}

/**
 * 骨架文件的格式与版本。
 *
 * Spine 4.1 的运行时只认 **4.1 的二进制骨架**（布局与 3.8 完全不同：
 * 3.8 的哈希是字符串、数值是定点数）。所以版本必须认出来，
 * 不然会得到一句看不懂的解析错误。
 *
 * @returns {{format:'binary'|'json', version:string, bones:number}|null}
 */
export function detectSpineSkeleton(bytes, json) {
  if (json && typeof json === 'object') {
    const version = String(json?.skeleton?.spine || '');
    const bones = Array.isArray(json.bones) ? json.bones.length : 0;
    // 3.8 的 JSON 与 4.1 的不一样（skins 从对象变成数组），4.1 的运行时读不了。
    if (bones === 0 || !version.startsWith('4.')) return null;
    return { format: 'json', version, bones };
  }
  // 二进制：8 字节哈希 + 版本串。
  // 版本串的长度字节记的是「长度 + 1」（Spine 写字符串的老规矩）。
  if (!bytes || bytes.length < 16) return null;
  const len = bytes[8];
  if (len >= 4 && len <= 32 && 8 + len <= bytes.length) {
    const version = bytes.subarray(9, 8 + len).toString('latin1');
    if (/^4\.1\.\d+$/.test(version)) return { format: 'binary', version, bones: -1 };
  }
  return null;
}

/**
 * 解析 Spine 图集：每一页的**页名**与它在文本里的行号。
 *
 * 页名就是图片文件名——运行时按它去同目录找图。
 * 页面与区域在文本里长得一样（都是「一个名字 + 若干字段」），
 * 只能靠状态区分：页名后面跟的是**页面字段**（size/filter/…），
 * 区域名后面跟的是**区域字段**。
 *
 * 判据与官方运行时一致：先按「冒号」把一行分成「字段」与「名字」，
 * 再按状态推进（页字段 → 区域名 → 区域字段 → 空行换页）。
 */
export function parseAtlasPages(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const isEntry = (line) => {
    if (typeof line !== 'string') return false;
    const t = line.trim();
    return t !== '' && t.indexOf(':') !== -1;
  };
  let i = 0;
  const readLine = () => (i < lines.length ? lines[i++] : null);

  let line = readLine();
  while (line !== null && line.trim() === '') line = readLine();
  // 少数图集把页面字段写在页名之前：先跳过。
  while (isEntry(line)) line = readLine();

  const pages = [];
  while (line !== null) {
    pages.push({ name: line.trim(), lineIndex: i - 1 });
    // 页面字段。
    line = readLine();
    while (isEntry(line)) line = readLine();
    // 区域：名字 + 字段，直到空行。
    while (line !== null && line.trim() !== '') {
      line = readLine();
      while (isEntry(line)) line = readLine();
    }
    // 空行之后是下一页。
    while (line !== null && line.trim() === '') line = readLine();
    while (isEntry(line)) line = readLine();
  }
  return pages;
}

/** 页面名与纹理清单里的名字怎么对上：去掉扩展名再比。 */
function normalizeTextureName(name) {
  return String(name || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase();
}

/**
 * 页面名 → 纹理文件。
 *
 * 游戏的清单里，tex_names 是**全部页面名**（跨图集），textures 是对应的
 * 图片文件，两个数组**按位置**一一对应。图集文件本身只写着其中一部分页面。
 */
function matchTexture(pageName, texNames, textures) {
  const key = normalizeTextureName(pageName);
  const idx = texNames.findIndex((n) => normalizeTextureName(n) === key);
  if (idx >= 0 && typeof textures[idx] === 'string' && textures[idx] !== '') {
    return textures[idx];
  }
  return null;
}

async function fileExists(p) {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 在目录里挑一个**最能当桌宠**的 Spine 变体。
 *
 * 游戏一个角色会带好几份配置：本体、头发、饰品、过场动画……
 * 有的还附着一份**占位骨架**（只有一根 root 骨、几百字节）——
 * 那是游戏用来占位的，不是角色本身。
 *
 * 挑法（分数高的赢）：
 *   1. 真骨架优先：4.1 的二进制骨架，或骨头数够多的 JSON 骨架；
 *   2. 图集页面多的优先（画面更完整）；
 *   3. 骨架文件大的优先（内容更丰富）。
 *
 * @returns {Promise<object|null>} 变体描述，null 表示这个目录里没有能用的 Spine 模型。
 */
export async function findSpineVariant(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const candidates = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.json')) continue;
    const json = await readJsonOrNull(join(dir, e.name));
    if (!isSpineGameConfig(json)) continue;
    const variant = await describeVariant(dir, e.name, json);
    if (variant) candidates.push(variant);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.configFile.localeCompare(b.configFile));
  return candidates[0];
}

/** 把一份配置读成「变体描述」；缺零件就返回 null。 */
async function describeVariant(dir, configFile, json) {
  // 骨架文件：清单里点名的那一个，或它加 .json 的版本。
  const skeletonRef = json.skeleton;
  let skeletonPath = null;
  let skeletonName = null;
  for (const name of [skeletonRef, `${skeletonRef}.json`]) {
    const p = join(dir, name);
    if (await fileExists(p)) {
      skeletonPath = p;
      skeletonName = name;
      break;
    }
  }
  if (!skeletonPath) return null;

  const raw = await readFile(skeletonPath);
  const skeletonJson = skeletonName.toLowerCase().endsWith('.json')
    ? await readJsonOrNull(skeletonPath)
    : null;
  const skeleton = detectSpineSkeleton(raw, skeletonJson);
  // 4.1 的运行时读不了 3.8 的二进制骨架：版本不对就别导，
  // 导进来只会在加载时炸出一句看不懂的错。
  if (!skeleton || (skeleton.format === 'binary' && !skeleton.version.startsWith('4.1'))) {
    return null;
  }

  // 图集：只取第一个（官方运行时一个骨架配一套图集）。
  const atlasEntry = json.atlases[0];
  if (!atlasEntry || typeof atlasEntry.atlas !== 'string') return null;
  const atlasPath = join(dir, atlasEntry.atlas);
  if (!(await fileExists(atlasPath))) return null;
  const atlasText = await readFile(atlasPath, 'utf8');
  const pages = parseAtlasPages(atlasText);
  if (pages.length === 0) return null;

  const texNames = Array.isArray(atlasEntry.tex_names) ? atlasEntry.tex_names : [];
  const textures = Array.isArray(atlasEntry.textures) ? atlasEntry.textures : [];
  const resolved = [];
  for (let i = 0; i < pages.length; i++) {
    let texture = matchTexture(pages[i].name, texNames, textures);
    // 兜底：页面数与纹理数一样时按位置对。
    if (!texture && pages.length === textures.length) texture = textures[i];
    if (!texture) return null;
    const texturePath = join(dir, texture);
    if (!(await fileExists(texturePath))) return null;
    resolved.push({ ...pages[i], texture, texturePath });
  }

  // 分数：真骨架 > 页面多 > 文件大。
  let score = 0;
  if (skeleton.format === 'binary') {
    score += 1000;
    score += Math.min(999, Math.floor(raw.length / 1024));
  } else {
    score += Math.min(999, skeleton.bones * 10);
  }
  score += resolved.length * 10;

  return {
    configFile,
    skeleton: { name: skeletonName, path: skeletonPath, format: skeleton.format, version: skeleton.version },
    atlas: { name: atlasEntry.atlas, path: atlasPath, text: atlasText, pages: resolved },
    score,
  };
}

/**
 * 把挑中的变体整理成一份「标准 Spine 模型目录」的拷贝清单。
 *
 * @returns {Promise<{files: Array<{from:string,to:string}>, atlasText: string, pet: object}>}
 */
export async function planSpineImport(variant, { id, name }) {
  const skeletonOut = variant.skeleton.format === 'json' ? 'model.json' : 'model.skel';
  const files = [{ from: variant.skeleton.path, to: skeletonOut }];
  const atlasLines = variant.atlas.text.split(/\r\n|\r|\n/);
  const textureFiles = [];
  for (let i = 0; i < variant.atlas.pages.length; i++) {
    const page = variant.atlas.pages[i];
    const outName = `${i}.png`;
    files.push({ from: page.texturePath, to: outName });
    atlasLines[page.lineIndex] = outName;
    textureFiles.push(outName);
  }
  const pet = {
    id,
    name,
    type: SPINE_TYPE,
    spine: {
      skeleton: skeletonOut,
      atlas: 'model.atlas',
      skeletonFormat: variant.skeleton.format,
      textures: textureFiles,
    },
    viewport: { width: 300, height: 560 },
    fit: { scale: 1.0, anchor: [0.5, 1.0], offset: [0, 0] },
  };
  return { files, atlasText: atlasLines.join('\n'), pet };
}
