import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolveStaticFile } from './staticFiles.js';

const SCHEME = 'app';
const HOST = 'bundle';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.moc3': 'application/octet-stream',
  '.ico': 'image/x-icon',
};

/** 必须在 app ready 之前调用。 */
export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** 必须在 app ready 之后调用。 */
export function registerAppProtocol(rootDir) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    // 拒绝以点开头的路径段（.git / .env / .superpowers 等）。
    // app:// 的根是整个项目目录，渲染层不需要这些内容，
    // 一旦漏出去就能读到版本库配置与本地密钥文件。
    // 每个路径段都要**先解码再判断**：WHATWG URL 不会规范化 %2e，
    // 而 resolveStaticFile 会解码——不先解码的话 %2egit 能绕过这个检查，
    // 实测 app://bundle/%2egit/config 曾返回 200。
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .flatMap((seg) => {
        let decoded = seg;
        try {
          decoded = decodeURIComponent(seg);
        } catch {
          decoded = seg;
        }
        // 反斜杠同样是分隔符：%5c 解码后是 "\"，不当作分隔符的话
        // "\.git" 不以 "." 开头，能绕过这个检查；而 resolveStaticFile 会把
        // "\" 归一化成 "/"，最终仍指向 <root>/.git/config。
        return decoded.replace(/\\/g, '/').split('/');
      })
      .filter(Boolean);
    if (segments.some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
      return new Response('Forbidden', { status: 403 });
    }
    const resolved = resolveStaticFile(rootDir, url.pathname);
    if (!resolved) return new Response('Not Found', { status: 404 });
    try {
      const data = await readFile(resolved.filePath);
      const type = MIME[extname(resolved.filePath).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': type } });
    } catch (err) {
      // 权限错误、EISDIR 等与「文件不存在」必须区分，否则无法排查。
      if (err?.code !== 'ENOENT') {
        console.warn('[desk-pet] 资源读取失败：', resolved.filePath, err?.message);
      }
      return new Response('Not Found', { status: 404 });
    }
  });
}

export function appUrl(pathname) {
  return `${SCHEME}://${HOST}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}
