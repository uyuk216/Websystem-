import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { IncomingMessage } from 'node:http';
import type { Locale } from 'i18n';
import { withSystem, type Db } from '../db/client.js';
import { apps } from '../db/schema.js';
import { trustedClientIp } from './client-ip.js';
import { pausedPage, securityGate } from './gate.js';
import { isInternalPeer } from './ip.js';

export interface GateServerDeps {
  db: Db;
  /** IP を HMAC するための秘密鍵（SECURITY_IP_KEY）。 */
  hashKey: Buffer;
  /** 内部判定口の前にいる信頼するプロキシの段数（edge と同じ値）。 */
  trustedProxyHops: number;
  /** Host ヘッダー → アプリ名。サイトの Host でなければ null（IP の判定だけをする）。edge の `resolveSite` を渡す。 */
  siteName(host: string): string | null;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const localeOf = (h: string | undefined): Locale => (/^\s*ja/i.test(h ?? '') ? 'ja' : 'en');

/**
 * Traefik の ForwardAuth から呼ばれる内部の判定口（公開 API・管理 API とは別のリスナーで動かす）。
 * 許可は 204、遮断は 503（日英の一時停止ページ。Traefik がそのまま訪問者に返す）、判定不能は 503。
 * - 呼び出せるのは localhost / 内部ネットワークの接続元だけ。それ以外は 403 で、ヘッダーの中身を見ない。
 * - 判定に使うのは Traefik が付け直した X-Forwarded-Host / X-Forwarded-For だけ。許可を意味するヘッダーは存在せず、
 *   リクエストが何を名乗っても、ここで DB の事実から決める。
 */
export function createSecurityGateApp(deps: GateServerDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.all('/gate', async (c) => {
    const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress;
    if (!isInternalPeer(peer)) return c.text('Forbidden', 403, NO_STORE);
    const locale = localeOf(c.req.header('accept-language'));
    try {
      const uri = c.req.header('x-forwarded-uri') ?? '/';
      const path = decodeURIComponent(uri.split(/[?#]/, 1)[0]!);
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || [...path].some((c) => c.charCodeAt(0) < 32) || path.split('/').includes('..')) return c.text('Bad Request', 400, NO_STORE);
      const host = c.req.header('x-forwarded-host') ?? '';
      const name = host ? deps.siteName(host) : null;
      let appId: string | undefined;
      if (name) {
        const [a] = await withSystem(deps.db, (tx) => tx.select({ id: apps.id }).from(apps).where(eq(apps.name, name)));
        appId = a?.id;
      }
      const verdict = await securityGate(deps.db, {
        appId, clientIp: trustedClientIp(c.req.header('x-forwarded-for'), peer, deps.trustedProxyHops) ?? undefined, hashKey: deps.hashKey,
      });
      if (verdict.allow) return c.body(null, 204, NO_STORE);
      return c.html(pausedPage(locale, 'paused'), 503, NO_STORE);
    } catch (e) {
      console.error('security gate failed', e);
      return c.html(pausedPage(locale, 'unavailable'), 503, { ...NO_STORE, 'Retry-After': '5' });
    }
  });
  return app;
}

/** Collector-only app: mount on its own private listener, never on createApp/createAdminApp. */
export function createDetectorApp(deps: { db: Db; falco: import('platform').FalcoAdapter }): Hono {
  const app = new Hono();
  app.post('/falco', async c => {
    const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress;
    if (!isInternalPeer(peer)) return c.text('Forbidden', 403, NO_STORE);
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.text('Bad Request', 400, NO_STORE);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 65536) { await reader.cancel(); return c.text('Too Large', 413, NO_STORE); }
        chunks.push(part.value);
      }
      const { ingestFalco } = await import('./detectors.js');
      await ingestFalco(deps.db, deps.falco, Buffer.concat(chunks).toString('utf8'), {
        timestamp: c.req.header('x-collector-timestamp') ?? '', nonce: c.req.header('x-collector-nonce') ?? '', signature: c.req.header('x-collector-signature') ?? '',
      });
      return c.body(null, 204, NO_STORE);
    } catch { return c.text('Rejected', 400, NO_STORE); }
  });
  return app;
}
