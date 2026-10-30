import { join, resolve, sep } from 'node:path';

const ROOT_INDEX = '/src/renderer/index.html';

/**
 * 把 app:// 请求的 URL 路径解析为项目内的真实文件路径。
 * 任何越界（目录穿越）一律返回 null。
 */
export function resolveStaticFile(rootDir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath || '/');
  } catch {
    return null;
  }
  if (decoded === '/' || decoded === '') decoded = ROOT_INDEX;
  // 统一为 POSIX 风格分隔符后再处理
  const normalized = decoded.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) return null;

  const root = resolve(rootDir);
  const target = resolve(join(root, normalized));
  // 必须严格位于 root 之内（分隔符边界，避免 /app-evil 误判）
  if (target !== root && !target.startsWith(root + sep)) return null;
  return { filePath: target };
}
