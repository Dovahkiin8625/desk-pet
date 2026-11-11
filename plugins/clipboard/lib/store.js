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
 * 写盘是**原子**的（先写 .tmp 再 rename）：普通 writeFile 会先把目标截断成
 * 0 字节，写到一半被强杀就留下一个空文件，下次启动历史全丢。
 */
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeEntries } from './history.js';

/** 历史文件的名字。 */
export const HISTORY_FILE = 'clipboard-history.json';

/** 历史文件的位置。 */
export function historyPath(userDataDir) {
  return join(userDataDir, HISTORY_FILE);
}

/**
 * 读历史；读不到或读坏了都当作空的。
 *
 * 磁盘上的文件是上一次运行留下的，可能缺字段、可能类型不对——
 * 认不出来的条目直接丢掉（见 normalizeEntries）。
 *
 * @param {string} userDataDir
 * @returns {Promise<Array>}
 */
export async function readHistory(userDataDir) {
  try {
    const text = await readFile(historyPath(userDataDir), 'utf8');
    return normalizeEntries(JSON.parse(text));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[剪贴板] 历史读不了，当作空的：', err?.message);
    }
    return [];
  }
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
