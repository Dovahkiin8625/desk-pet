// 全局 setup：给内置注册表拍一张快照。
//
// 有些用例会原地改写 assets/live2d/index.json（它是 git 跟踪的文件）。
// 用例被中断时改动会留下来，下一次运行就读到一份脏注册表——
// 于是「形象列表是空的」这类问题会跟本次改动无关地冒出来。
//
// 快照放在系统临时目录里：playwright 每次运行都会清空 test-results/，
// 那里存不住东西。
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const REGISTRY_PATH = join(process.cwd(), 'assets', 'live2d', 'index.json');
export const SNAPSHOT_PATH = join(tmpdir(), 'desk-pet-live2d-index.snapshot.json');

export default async function globalSetup() {
  await mkdir(tmpdir(), { recursive: true });
  await copyFile(REGISTRY_PATH, SNAPSHOT_PATH).catch(() => {});
}
