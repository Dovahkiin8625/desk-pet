// plugins/screen-recorder/lib/naming.js
import { access } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 录制文件的名字。
 *
 * 名字里带日期时间：一天录好几段时，光看「录屏.mp4」根本分不清。
 */
export function recordingFileName(date, ext) {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `录屏_${y}${mo}${d}_${h}${mi}${s}.${ext}`;
}

/**
 * 找一个不重名的路径。
 *
 * 同一秒里录两次就会撞名：撞了就加 _2、_3……
 */
export async function uniquePath(dir, fileName) {
  const ext = extname(fileName);
  const base = basename(fileName, ext);
  let candidate = join(dir, fileName);
  let n = 2;
  // 一次只查一个候选：查到一个存在就换下一个，串行才对。
  while (await exists(candidate)) {
    candidate = join(dir, `${base}_${n}${ext}`);
    n += 1;
  }
  return candidate;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
