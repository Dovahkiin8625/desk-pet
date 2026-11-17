// external-plugins/batch-rename/lib/execute.js
/**
 * 两阶段重命名的执行器。
 *
 * 为什么要两阶段（先全部改成临时名，再改成目标名）：
 * 直接改会被「甲要变成乙、乙要叫做丙、甲占着乙」这类链式、交换式排序搞死。
 * 先全部让开到临时名，链条里就没有结了。
 *
 * 中途失败会**回滚**：能还原的都还原；还原不回去的
 * （比如磁盘错误、权限变了）会原样抛出，由调用方决定怎么告诉用户。
 */
import { randomUUID } from 'node:crypto';
import { rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { joinPath } from './plan.js';

/** 临时名字的前缀（以点开头，当作隐藏文件，尽量显眼又少见）。 */
const TEMP_PREFIX = '.batch-rename-';

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 给一个目录造一个临时文件名（目录里还没人用的那种）。
 */
async function uniqueTempName(dir) {
  for (let i = 0; i < 100; i += 1) {
    const name = `${TEMP_PREFIX}${randomUUID()}`;
    if (!(await pathExists(joinPath(dir, name)))) return name;
  }
  throw new Error('造不出临时文件名');
}

/**
 * 执行一批重命名（rows 已经是 status=ok 且确实会变化的行）。
 *
 * @param {Array<{ path: string, dir: string, newName: string }>} rows
 * @returns {Promise<{ ok: boolean, done: Array<{from: string, to: string}>,
 *                     unrestored: Array<{from: string, to: string}>,
 *                     error?: string }>}
 *   done：真正落盘的重命名（供「撤销」用）。
 *   unrestored：失败且没能回滚的那些（文件现在就在 `to`）。
 */
export async function applyRenames(rows) {
  const moved = []; // 已经改名的行（带 tempPath / finalPath）
  try {
    for (const row of rows) {
      const tempName = await uniqueTempName(row.dir);
      const tempPath = joinPath(row.dir, tempName);
      await rename(row.path, tempPath);
      moved.push({ ...row, tempPath });
    }
    const done = [];
    for (const row of moved) {
      const to = joinPath(row.dir, row.newName);
      await rename(row.tempPath, to);
      row.finalPath = to;
      done.push({ from: row.path, to });
    }
    return { ok: true, done, unrestored: [] };
  } catch (err) {
    // 回滚：倒序来（后改的先还原）。
    const unrestored = [];
    for (const row of [...moved].reverse()) {
      const target = row.finalPath ?? row.tempPath;
      try {
        await rename(target, row.path);
      } catch {
        // 还原不回去：文件还在 target，记下来交给调用方。
        unrestored.push({ from: row.path, to: target });
      }
    }
    return { ok: false, done: [], unrestored, error: err?.message ?? String(err) };
  }
}

/**
 * 撤销一批重命名。
 *
 * 跟正向一样走两阶段（先都让开到临时名，再落回原名）——
 * 交换过的文件名单相还原会互相踩（from 都是对方的 to，两个都
 *「被占用」）。落地之前还要**再查一眼 from**：
 * rename 会直接覆盖已存在的目标，别把别人的文件盖掉。
 *
 * @returns {Promise<{ undone: number, skipped: Array<{entry: object, reason: string}>,
 *                     remaining: Array<{from: string, to: string}> }>}
 *   remaining：没能撤销的那些（调用方负责继续留着它们，下次再撤）。
 */
export async function undoRenames(entries) {
  const skipped = [];
  let undone = 0;

  // 第一阶段：能挪的先挪进临时名；挪不动的原地记下，不挡别人。
  const staged = [];
  for (const entry of entries) {
    if (!(await pathExists(entry.to))) {
      // 文件不在了：这条记录作废，直接丢掉。
      skipped.push({ entry, reason: '文件不在原来的位置' });
      continue;
    }
    const tempName = await uniqueTempName(dirnameOf(entry.to));
    const tempPath = joinPath(dirnameOf(entry.to), tempName);
    try {
      await rename(entry.to, tempPath);
      staged.push({ ...entry, tempPath });
    } catch (err) {
      skipped.push({ entry, reason: err?.message ?? String(err) });
      staged.push({ ...entry, failed: true });
    }
  }

  // 第二阶段：落回原名。落不下去的退回 `to`，这条留着。
  const remaining = [];
  for (const entry of staged) {
    if (entry.failed) {
      remaining.push({ from: entry.from, to: entry.to });
      continue;
    }
    const sameFile = process.platform === 'win32'
      && entry.from.toLowerCase() === entry.to.toLowerCase();
    if (!sameFile && (await pathExists(entry.from))) {
      // 原来的名字被别的文件占了：退回 `to`，这条留着（以后还能再撤）。
      try { await rename(entry.tempPath, entry.to); } catch { /* 落到哪就到哪，下面按现状记 */ }
      remaining.push({ from: entry.from, to: (await pathExists(entry.tempPath)) ? entry.tempPath : entry.to });
      skipped.push({ entry, reason: '原来的名字被别的文件占了' });
      continue;
    }
    try {
      await rename(entry.tempPath, entry.from);
      undone += 1;
    } catch (err) {
      try { await rename(entry.tempPath, entry.to); } catch { /* 尽力退回 */ }
      remaining.push({ from: entry.from, to: (await pathExists(entry.tempPath)) ? entry.tempPath : entry.to });
      skipped.push({ entry, reason: err?.message ?? String(err) });
    }
  }

  return { undone, skipped, remaining };
}

/** 路径的目录部分（两个分隔符都认）。 */
function dirnameOf(path) {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i >= 0 ? path.slice(0, i) : '';
}
