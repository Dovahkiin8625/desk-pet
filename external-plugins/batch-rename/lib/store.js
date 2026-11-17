// external-plugins/batch-rename/lib/store.js
/**
 * 「撤销上次重命名」的记录。
 *
 * 记在 userData/batch-rename-undo.json——插件目录在安装目录下，
 * 多半没有写权限；而且重命名是不可逆的动作，记录得能跨重启活着。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function undoPath(userDataDir) {
  return join(userDataDir, 'batch-rename-undo.json');
}

/** 读上次重命名的记录；读不出来（不存在 / 坏文件）就当没有。 */
export async function readUndo(userDataDir) {
  try {
    const raw = JSON.parse(await readFile(undoPath(userDataDir), 'utf8'));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return entries
      .filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string')
      .map((e) => ({ from: e.from, to: e.to }));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[批量重命名] 撤销记录读不出来：', err?.message);
    }
    return [];
  }
}

/** 记住这一批重命名（原子写）。 */
export async function writeUndo(userDataDir, entries) {
  await mkdir(userDataDir, { recursive: true });
  const target = undoPath(userDataDir);
  const tmp = `${target}.tmp`;
  const body = JSON.stringify({ version: 1, at: Date.now(), entries }, null, 2);
  await writeFile(tmp, body, 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** 撤销完了：把记录删掉（下次就没法再撤了）。 */
export async function clearUndo(userDataDir) {
  await unlink(undoPath(userDataDir)).catch(() => {});
}
