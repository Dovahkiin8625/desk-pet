// 全局 teardown：把内置注册表还原成运行前的样子。
//
// 还原的是**运行前的快照**而不是 git HEAD 的版本：
// 直接 `git checkout --` 会连用户在跑测试之前自己改过的内容一起丢掉，
// 而那份改动与测试无关，不该由一次测试运行来抹掉。
import { copyFile, readFile, rm } from 'node:fs/promises';
import { REGISTRY_PATH, SNAPSHOT_PATH } from './global-setup.js';

export default async function globalTeardown() {
  let before = null;
  try {
    before = await readFile(SNAPSHOT_PATH);
  } catch {
    // 没有快照：没拍上就没什么可还原的。
    return;
  }
  let current = null;
  try {
    current = await readFile(REGISTRY_PATH);
  } catch {
    // 文件被删了：还原它。
  }
  if (current && current.equals(before)) return;
  await copyFile(SNAPSHOT_PATH, REGISTRY_PATH).catch(() => {});
  await rm(SNAPSHOT_PATH, { force: true }).catch(() => {});
}
