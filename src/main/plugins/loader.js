import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_MANIFEST_FILE,
  validateManifest,
} from '../../shared/plugin.js';

/**
 * 插件的发现与加载。
 *
 * 「插件」不是硬编码的清单，而是**磁盘上的目录**：
 * 宿主扫一遍插件根目录，每个子目录里读一个 `plugin.json`，
 * 清单说得通就把它当成插件。
 *
 * 这样加一个插件只要多一个目录，不必改宿主的一行代码——
 * 这就是「插拔」的意思。
 */

/**
 * 扫一遍插件根目录。
 *
 * @param {Array<{dir: string, source: string}>} roots 插件根目录（内置的、用户自己的）
 * @returns {Promise<Array<{dir: string, manifest: object, source: string}>>}
 */
export async function discoverPlugins(roots) {
  const found = [];
  for (const root of roots || []) {
    if (!root?.dir) continue;
    let entries = [];
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch (err) {
      // 目录不存在是正常的（用户插件目录可能还没建过）。
      if (err?.code !== 'ENOENT') {
        console.warn(`[desk-pet] 插件目录读不了：${root.dir}`, err?.message);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 以点开头的目录（`.git`、`._xxx`）不是插件。
      if (entry.name.startsWith('.')) continue;
      const record = await readPluginManifest(join(root.dir, entry.name), entry.name, root.source);
      if (record) found.push(record);
    }
  }
  return dedupeById(found);
}

/**
 * 读一个插件目录里的清单。
 *
 * 目录名必须与清单里的 id 一致：插件的页面是按 URL 提供的
 * （`/plugins/<id>/…`），两者对不上时 URL 与磁盘就接不上了。
 */
async function readPluginManifest(dir, dirName, source) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null; // 没有清单的目录不是插件
    console.warn(`[desk-pet] 插件「${dirName}」的清单读不了：`, err?.message);
    return null;
  }
  const { ok, value, errors } = validateManifest(raw);
  if (!ok) {
    console.warn(`[desk-pet] 插件「${dirName}」的清单不合法：`, errors.join('；'));
    return null;
  }
  if (value.id !== dirName) {
    console.warn(
      `[desk-pet] 插件「${dirName}」的清单不合法：id（${value.id}）与目录名不一致`
    );
    return null;
  }
  return { dir, manifest: value, source };
}

/**
 * 同名插件只留一个。
 *
 * 用户目录里的插件**盖掉**内置的：用户明确装了一个同名插件，
 * 那是他的选择。留痕是为了「内置的那个怎么不灵了」这种问题能查到。
 */
function dedupeById(list) {
  const byId = new Map();
  for (const record of list) {
    const prev = byId.get(record.manifest.id);
    if (prev) {
      console.warn(
        `[desk-pet] 插件「${record.manifest.id}」有重复（${prev.source} 与 ${record.source}），用 ${record.source} 的那个`
      );
    }
    byId.set(record.manifest.id, record);
  }
  return [...byId.values()];
}

/**
 * 加载一个插件的入口模块，取出它的工厂函数。
 *
 * 用动态 import：插件就是一个普通的 ES 模块，
 * 宿主不需要知道它里面写了什么。
 */
export async function loadPluginFactory(record) {
  const entryPath = join(record.dir, record.manifest.entry);
  const mod = await import(pathToFileURL(entryPath).href);
  const factory = mod?.default;
  if (typeof factory !== 'function') {
    throw new Error('入口模块没有导出默认函数');
  }
  return factory;
}
