import { createServer, type Server } from 'node:http';
import { SECURITY_HEADERS } from './security-headers.js';

const PAGE = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>運営管理画面</title><link rel="stylesheet" href="/app.css"></head>
<body><main><h1>運営管理画面</h1><p id="status">確認中…</p></main><script src="/app.js"></script></body>
</html>`;
const SCRIPT = `fetch('/admin/me', { credentials: 'same-origin' }).then(function (r) {
  document.getElementById('status').textContent = r.status === 200 ? 'ログイン済みです。' : r.status === 401 ? '昇格ログインが必要です（パスキー）。' : 'この画面は利用できません。';
}).catch(function () { document.getElementById('status').textContent = '管理 API に接続できません。'; });
`;
const STYLE = 'body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:48rem;padding:0 1rem}\n';

const ROUTES: Record<string, { type: string; body: string }> = {
  '/': { type: 'text/html; charset=utf-8', body: PAGE },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: SCRIPT },
  '/app.css': { type: 'text/css; charset=utf-8', body: STYLE },
};

/** The admin UI shell. Feature screens (reviews, grants, accounts, settings, audit) are phase 5 task 10. */
export function createAdminShell(): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = req.method === 'GET' || req.method === 'HEAD' ? ROUTES[path] : undefined;
    if (!route) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': route.type }).end(req.method === 'HEAD' ? undefined : route.body);
  });
}
