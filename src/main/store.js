import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 原子读写 JSON 文件。
 *
 * 「原子」指的是：先写临时文件，再 rename 覆盖目标。
 * 普通 writeFile 会先把目标文件**截断成 0 字节**，写到一半被强杀
 * （任务管理器 / 断电）就留下一个 0 字节文件——下次启动读到空文件，
 * 会静默重置用户的设置、待办、提醒。rename 在 NTFS 上是原子的：
 * 要么还是旧文件，要么已经是新文件。
 *
 * 这份实现被 settings.json 与 assistant.json 共用：
 * 抄一份迟早会漂移，而漂移的后果是「一半文件原子写、一半不是」。
 */

/** 读一个 JSON 文件；文件不存在时返回 fallback，读坏了也要留痕。 */
export async function readJson(dir, fileName, fallback, label = fileName) {
  try {
    const text = await readFile(join(dir, fileName), 'utf8');
    return JSON.parse(text);
  } catch (err) {
    // 文件不存在是正常情况（首次启动），静默回退即可。
    // 但读不了/解析失败说明文件已损坏——同样回退，却必须留痕，
    // 否则用户会遇到「改了设置没生效」且无从排查。
    if (err?.code !== 'ENOENT') {
      console.warn(`[desk-pet] ${label} 无法读取或解析，已回退默认值：`, err?.message);
    }
    return fallback;
  }
}

/** 原子写一个 JSON 文件（先写临时文件，再 rename）。 */
export async function writeJson(dir, fileName, value) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, fileName);
  const tmp = join(dir, `${fileName}.tmp`);
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await rename(tmp, target);
  } catch (err) {
    // 改名失败：临时文件留在那儿，下次启动前先清掉。
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return value;
}
