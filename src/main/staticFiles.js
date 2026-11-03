import { join, resolve, sep, basename } from 'node:path';

const ROOT_INDEX = '/src/renderer/index.html';

/**
 * 明确**不提供**的文件名（大小写不敏感）。
 *
 * app:// 服务的是整个项目目录（README「已知限制」里记着这一条），
 * 而项目根目录里可能躺着**密钥**——比如用户放在根目录的 `minimax-api-key`。
 * 渲染层只要 `fetch('/minimax-api-key')` 就能把它读走，
 * 而渲染层不是可信边界：宠物窗口、气泡窗口、设置窗口都能发请求。
 *
 * 「拒绝以 `.` 开头的路径段」（protocol.js）挡不住这类文件——
 * 它的名字不以点开头。它必须靠这份显式清单挡住。
 */
const DENIED_BASENAMES = new Set([
  'minimax-api-key',
  'credentials.json',
]);

/** 常见的密钥文件后缀。 */
const DENIED_SUFFIXES = ['.key', '.pem', '.p12', '.pfx', '.secret'];

/**
 * 这个文件是否属于「不该通过 app:// 提供」的资源。
 *
 * 按**文件名**判断，不按完整路径：子目录里叫 minimax-api-key 的文件同样危险。
 * 比较前统一转小写——Windows 的文件系统不区分大小写，
 * `/MiniMax-API-KEY` 会命中同一个文件。
 */
export function isDeniedResource(filePath) {
  if (!filePath) return false;
  const name = basename(String(filePath)).toLowerCase();
  if (!name) return false;
  if (DENIED_BASENAMES.has(name)) return true;
  return DENIED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

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
