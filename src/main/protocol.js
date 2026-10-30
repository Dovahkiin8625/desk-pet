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
    // 必须先解码再判断：URL 解析器不会把 %2e 归一化成 '.'，
    // 但 resolveStaticFile 会解码，所以 '%2egit/config' 能绕过只查原始串的检查。
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      });
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
