/**
 * 定时任务的存盘。
 *
 * 存在 `userData/scheduler.json`——**不放插件目录里**：
 * 插件目录是代码的地盘，用户改任务不该弄脏它。
 *
 * 写盘是**原子**的（先写 .tmp 再 rename）：普通 writeFile 会先把目标截断成
 * 0 字节，写到一半被强杀就留下一份空文件，下一次启动任务全没了。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 造一个存取器。
 *
 * @param {string} file 落盘的文件
 */
export function createStore(file) {
  return {
    /** 读一份。坏了或没有都当成空的——不该因此起不来。 */
    async read() {
      try {
        const text = await readFile(file, 'utf8');
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    },

    /** 写一份。 */
    async write(value) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await rename(tmp, file);
    },
  };
}
