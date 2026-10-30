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
    const resolved = resolveStaticFile(rootDir, url.pathname);
    if (!resolved) return new Response('Not Found', { status: 404 });
    try {
      const data = await readFile(resolved.filePath);
      const type = MIME[extname(resolved.filePath).toLowerCase()] || 'application/octet-stream';
      return new Response(data, { status: 200, headers: { 'content-type': type } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

export function appUrl(pathname) {
  return `${SCHEME}://${HOST}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
}
