// plugins/clipboard/lib/store.js
/**
 * 剪贴板历史的落盘。
 *
 * 历史存在 `userData/clipboard-history.json`——**不放插件目录里**：
 * 插件目录在安装目录下，多半没有写权限。
 *
 * 也不放进 `assistant.json`：那是助理的状态文件，剪贴板历史归这个插件，
 * 混在一起两边的数据会互相拖累（而且历史可能很大）。
 *
 * 图片字节存成单独的 PNG（`userData/clipboard-images/img-<哈希>.png`），
 * JSON 里只放文件名——几 MB 的图塞进 JSON 再 parse 一次，
 * 每次启动都要白等一拍。
 *
 * 写盘是**原子**的（先写 .tmp 再 rename）：普通 writeFile 会先把目标截断成
 * 0 字节，写到一半被强杀就留下一个空文件，下次启动历史全丢。
 */
import { readFile, writeFile, mkdir, rename, unlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeEntries } from './history.js';

/** 历史文件的名字。 */
export const HISTORY_FILE = 'clipboard-history.json';

/** 图片目录的名字（相对 userData）。 */
export const IMAGES_DIR = 'clipboard-images';

/** 历史文件的位置。 */
export function historyPath(userDataDir) {
  return join(userDataDir, HISTORY_FILE);
}

/** 图片目录的位置。 */
export function imagesPath(userDataDir) {
  return join(userDataDir, IMAGES_DIR);
}

/**
 * 读历史；读不到或读坏了都当作空的。
 *
 * 磁盘上的文件是上一次运行留下的，可能缺字段、可能类型不对——
 * 认不出来的条目直接丢掉（见 normalizeEntries）。
 *
 * 图片条目还会**核对图片文件真的在**：文件被手动删了，
 * 那条历史只剩一个破图标，留着不如丢掉。
 *
 * @param {string} userDataDir
 * @returns {Promise<Array>}
 */
export async function readHistory(userDataDir) {
  try {
    const text = await readFile(historyPath(userDataDir), 'utf8');
    const entries = normalizeEntries(JSON.parse(text));
    return dropMissingImages(userDataDir, entries);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[剪贴板] 历史读不了，当作空的：', err?.message);
    }
    return [];
  }
}

/** 图片文件不在的条目丢掉（好歹给个数）。 */
async function dropMissingImages(userDataDir, entries) {
  const dir = imagesPath(userDataDir);
  const kept = [];
  let dropped = 0;
  for (const entry of entries) {
    if (!entry.imageFile) {
      kept.push(entry);
      continue;
    }
    try {
      const st = await stat(join(dir, entry.imageFile));
      if (st.isFile() && st.size > 0) kept.push(entry);
      else dropped += 1;
    } catch {
      dropped += 1;
    }
  }
  if (dropped) console.warn(`[剪贴板] ${dropped} 条图片历史的文件找不到了，丢掉`);
  return kept;
}

/**
 * 写历史（原子）。
 *
 * @param {string} userDataDir
 * @param {Array} entries
 * @returns {Promise<Array>} 写下去的那份（已规整过）
 */
export async function writeHistory(userDataDir, entries) {
  const value = normalizeEntries(entries);
  await mkdir(userDataDir, { recursive: true });
  const target = historyPath(userDataDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return value;
}

/**
 * 把一张 PNG 写进图片目录。
 *
 * @param {string} userDataDir
 * @param {string} file 文件名（只认 `img-<40 位 hex>.png`）
 * @param {Buffer} bytes
 */
export async function writeImageFile(userDataDir, file, bytes) {
  const dir = imagesPath(userDataDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), bytes);
}

/**
 * 删掉几张图片（条目被删/被淘汰时叫它）。不存在也不报错。
 *
 * @param {string} userDataDir
 * @param {string[]} files
 */
export async function removeImageFiles(userDataDir, files) {
  const dir = imagesPath(userDataDir);
  for (const file of files || []) {
    // 文件名格式对不上就别往目录里摸（防穿越）。
    if (typeof file !== 'string' || !/^img-[0-9a-f]{40}\.png$/.test(file)) continue;
    await unlink(join(dir, file)).catch(() => {});
  }
}

/** 图片文件的一次读取。 */
export async function readImageFile(userDataDir, file) {
  return readFile(join(imagesPath(userDataDir), file));
}

/**
 * 清扫：把图片目录里**没人认领**的 PNG 删掉。
 *
 * 正常路径上（删除/淘汰/清空）图片会跟着条目一起删；
 * 这里兜的是「记了一半崩了」的残骸。
 *
 * 只删**一分钟之前**的：正在记录的条目可能还没并进历史，误删会丢图。
 * 只认 `img-*.png`：目录里别的文件不碰。
 *
 * @param {string} userDataDir
 * @param {Array} entries 还留着的条目
 */
export async function sweepImages(userDataDir, entries) {
  const dir = imagesPath(userDataDir);
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  const referenced = new Set((entries || []).map((entry) => entry.imageFile).filter(Boolean));
  const cutoff = Date.now() - 60 * 1000;
  for (const file of files) {
    if (!/^img-[0-9a-f]{40}\.png$/.test(file) || referenced.has(file)) continue;
    try {
      const st = await stat(join(dir, file));
      if (st.mtimeMs < cutoff) await unlink(join(dir, file));
    } catch {
      // 删不掉就算了：最坏是多留一个文件。
    }
  }
}
