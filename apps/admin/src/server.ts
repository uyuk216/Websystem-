import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildBrowserScript } from '../../upload/src/client-build.js';
import { SECURITY_HEADERS } from './security-headers.js';
import { PAGE, STYLE } from './page.js';

let script: Promise<Uint8Array> | undefined;
export function createAdminShell(): Server {
  return createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!['GET', 'HEAD'].includes(req.method ?? '') || !['/', '/app.js', '/app.css'].includes(path)) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('not found'); return;
      }
      const body = path === '/' ? PAGE : path === '/app.css' ? STYLE : await (script ??= buildBrowserScript(fileURLToPath(new URL('./client.ts', import.meta.url))));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': path === '/' ? 'text/html; charset=utf-8' : path === '/app.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' }).end(req.method === 'HEAD' ? undefined : body);
    })().catch(() => { res.writeHead(500, SECURITY_HEADERS).end('unavailable'); });
  });
}
