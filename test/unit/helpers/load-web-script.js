import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * 加载一个**经典脚本**（渲染层用的那种）。
 *
 * 插件的页面走 file://，ES module 的 import 会被 CORS 拦掉，
 * 所以 web/ 下的脚本是经典脚本：挂到 globalThis 上，而不是 export。
 * 单元测试要在 node 里跑它们，就用 vm 在一个新上下文里执行文件，
 * 再从那个上下文的 globalThis 上取导出。
 *
 * 放在 vm 的新上下文里（而不是 eval 到当前上下文）是有意的：
 * 脚本里的 globalThis 应该是「它自己那个世界的 globalThis」，
 * 不该碰到测试进程的。
 */
export async function loadWebScript(relativePath) {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const source = await readFile(path, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: path });
  return sandbox;
}
