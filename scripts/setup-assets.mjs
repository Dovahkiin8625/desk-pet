// 从 Live2D 官方示例仓库拉取样例模型资源。
// 幂等：已存在且大小一致的文件会跳过，因此首次运行后即可离线重复执行。
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'assets', 'live2d', 'models');
const API = 'https://api.github.com/repos/Live2D/CubismWebSamples/git/trees/develop?recursive=1';
const RAW = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop';

// 要下载的官方样例模型。
//
// id 是**本地目录名**（必须与 assets/live2d/index.json 里的注册表 id 一致——
// 加载模型时拼的路径是 `models/<id>/<model3>`），dir 是上游仓库里的目录名。
// 本地目录用小写：注册表 id 统一小写，用户导入同名模型时才会正确去重。
const MODELS = [
  { id: 'haru', dir: 'Haru' },
  { id: 'hiyori', dir: 'Hiyori' },
  { id: 'mao', dir: 'Mao' },
];

async function fetchWithRetry(url, tries = 4, timeoutMs = 60000) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      // 最后一次失败就不再等待，直接抛出。
      if (i < tries) await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw lastErr;
}

async function existingSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function downloadTree(tree, prefix, destRoot) {
  const files = tree.filter((n) => n.type === 'blob' && n.path.startsWith(prefix));
  let downloaded = 0;
  let skipped = 0;
  for (const f of files) {
    const rel = relative(prefix, f.path);
    const dest = join(destRoot, rel);
    if ((await existingSize(dest)) === f.size) {
      skipped++;
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    const res = await fetchWithRetry(`${RAW}/${f.path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== f.size) throw new Error(`大小不符 ${rel}: ${buf.length} != ${f.size}`);
    await writeFile(dest, buf);
    downloaded++;
  }
  return { downloaded, skipped };
}

const treeRes = await fetchWithRetry(API);
const treeJson = await treeRes.json();
if (!Array.isArray(treeJson.tree)) throw new Error('无法解析 GitHub tree 响应');
if (treeJson.truncated) {
  throw new Error('GitHub tree 响应被截断，资源列表不完整；请重试或改用非递归查询');
}
const tree = treeJson.tree;

let totalDownloaded = 0;
let totalSkipped = 0;
for (const m of MODELS) {
  const destRoot = join(OUT_ROOT, m.id);
  await mkdir(destRoot, { recursive: true });
  const r = await downloadTree(tree, `Samples/Resources/${m.dir}/`, destRoot);
  totalDownloaded += r.downloaded;
  totalSkipped += r.skipped;
  console.log(`${m.id}: 下载 ${r.downloaded} 个, 跳过 ${r.skipped} 个`);
}
console.log(`完成：新增 ${totalDownloaded} 个文件, 复用 ${totalSkipped} 个文件`);
