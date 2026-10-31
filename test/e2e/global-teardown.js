import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY_REL = 'assets/live2d/index.json';
const REGISTRY = join(ROOT, REGISTRY_REL);

// 测试留下的哨兵：failure.spec.js 往注册表里塞的「注册了但文件不存在」的形象。
const SENTINEL = 'e2e-broken';

/**
 * 全局 teardown：把 failure.spec.js **原地改写**的注册表还原。
 *
 * 那条用例必须改**磁盘上**的那份注册表：主进程按注册表解析请求的 id，
 * 不认识的 id 会被解析成注册表首项（于是根本不会去加载那个坏模型）。
 * 用例自己在 finally 里写回原内容，但**进程被杀掉**时
 * （Ctrl+C、CI 超时、崩溃）finally 根本不会执行，
 * 注册表就留下一个 e2e-broken 条目——仓库变脏，
 * 而且之后每次运行的下拉框里都多出一个幻影形象。
 *
 * 所以这里兜底：只要文件里还留着哨兵 id，
 * 就用 git 把它还原成**已提交**的内容（不是还原成「跑之前的样子」——
 * 那正是被中断的那次运行留下的脏内容）。
 */
export default function globalTeardown() {
  let content;
  try {
    content = readFileSync(REGISTRY, 'utf8');
  } catch {
    return;
  }
  // 只在文件里**确实有**测试留下的哨兵时才动手：
  // 否则可能把开发者自己的改动悄悄冲掉。
  if (!content.includes(SENTINEL)) return;
  try {
    execFileSync('git', ['checkout', '--', REGISTRY_REL], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    console.log(`[desk-pet] 已还原 ${REGISTRY_REL}（上一次 e2e 运行被中断过）`);
  } catch (err) {
    // 没有 git（源码 tarball / 无 .git 的导出）就退回到「什么都不做」：
    // 还原失败不该比不还原更糟，也不该让整个测试进程失败。
    console.warn(`[desk-pet] 还原 ${REGISTRY_REL} 失败：`, err?.message || err);
  }
}
