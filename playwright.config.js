import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  // workers: 1 + fullyParallel: false 是**硬性要求**，不是性能偏好：
  // failure.spec.js 会原地改写被 git 跟踪的 assets/live2d/index.json，
  // 并行执行时另一条用例会读到被改过的注册表。
  // 一旦要开并行，得先把注册表路径做成可注入的，
  // 否则 settings.spec.js 的「按标签精确选中」断言会跟着漂。
  workers: 1,
  fullyParallel: false,
  // 全局 teardown：把被中断的运行留下的脏注册表还原（见 global-teardown.js）。
  globalTeardown: './test/e2e/global-teardown.js',
  reporter: [['list']],
});
