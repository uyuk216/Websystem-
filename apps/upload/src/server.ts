import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { MAX_INGEST_BYTES, type IngestInput, type IngestResult } from 'platform/pii';
import type { Locale } from 'i18n';
import type { ClientAssets } from './client-build.js';
import { LOCALES, renderSubmitPage } from './page.js';
import { securityHeaders } from './security-headers.js';

export interface UploadServerOptions {
  assets: ClientAssets;
  /** 運営者の公開鍵（base64）。ページに埋め込まれるのは公開鍵だけ。 */
  recipientPublicKeyB64: string;
  ingest(input: IngestInput): Promise<IngestResult>;
  /** 接続元の VPN / proxy / Tor 判定（フェーズ 6）。拒否なら本文を読む前に返す（token も blob も作らない）。省略時は判定しない。 */
  networkGuard?(req: IncomingMessage): Promise<{ status: 403 | 503; error: string } | null>;
}

/**
 * 学生証の提出専用オリジン。ページ（/{ja,en}/submit）と、暗号文の取り込み口（POST /ingest/id-upload）だけを持つ。
 * アクセスログは出さない（IP・パス・トークンを残さない）。
 */
export function createUploadServer(opts: UploadServerOptions): Server {
  const headers = securityHeaders(opts.assets.script.integrity);
  const assetByPath = new Map([opts.assets.script, opts.assets.style].map((a) => [a.path, a]));

  function send(res: ServerResponse, status: number, body: string | Uint8Array, type: string, cache = 'no-store'): void {
    res.writeHead(status, { ...headers, 'Content-Type': type, 'Cache-Control': cache });
    res.end(body);
  }
  const json = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

  /** Bodies over the limit are read and thrown away (up to 4x) so the client gets its 413 instead of a broken pipe. */
  async function readBody(req: IncomingMessage): Promise<Uint8Array | 'too_large'> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_INGEST_BYTES * 4) break;
      if (size <= MAX_INGEST_BYTES) chunks.push(chunk as Buffer);
    }
    return size > MAX_INGEST_BYTES ? 'too_large' : Buffer.concat(chunks);
  }

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://upload.invalid');
      const path = url.pathname;
      if (path === '/ingest/id-upload') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        const denied = opts.networkGuard ? await opts.networkGuard(req).catch(() => ({ status: 503 as const, error: 'network_unavailable' })) : null;
        if (denied) { req.resume(); return json(res, denied.status, { error: denied.error }); }
        const body = await readBody(req);
        if (body === 'too_large') {
          return json(res, 413, { error: 'too_large' });
        }
        const auth = req.headers.authorization;
        const r = await opts.ingest({ token: auth && /^Bearer /i.test(auth) ? auth.slice(7).trim() : null, contentType: req.headers['content-type'] ?? null, body });
        if (r.status === 204) {
          res.writeHead(204, { ...headers, 'Cache-Control': 'no-store' });
          return void res.end();
        }
        return json(res, r.status, { error: r.error });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
      if (path === '/healthz') return json(res, 200, { ok: true });
      const asset = assetByPath.get(path);
      if (asset) return send(res, 200, asset.body, asset.contentType, asset === opts.assets.script ? 'public, max-age=31536000, immutable' : 'no-cache');
      const m = /^\/(ja|en)\/submit$/.exec(path);
      if (m && (LOCALES as readonly string[]).includes(m[1]!)) {
        return send(res, 200, renderSubmitPage(m[1] as Locale, opts.assets, opts.recipientPublicKeyB64), 'text/html; charset=utf-8');
      }
      return json(res, 404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
}
