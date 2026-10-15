import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import { t } from 'i18n';
import { findLiveApp, touchLastAccess, type LiveApp } from 'api/wake';
import { secondsUntilNextMonth, type TransferMeter } from 'api/transfer';
import type { Db } from 'api/db';
import type { StoredObject } from 'platform';
import type { Duplex } from 'node:stream';
import type { Waker } from 'platform';
import { proxyRequest, proxyUpgrade, type ProxyFailure } from './proxy.js';
import { candidates, contentTypeFor, parsePath, pickLocale, resolveSite } from './site.js';

export interface SiteReader {
  get(key: string): Promise<StoredObject | null>;
}

export interface StaticAppDeps {
  db: Db;
  storage: SiteReader;
  meter: Pick<TransferMeter, 'record' | 'isBlocked'>;
  baseDomain: string;
  now?: () => Date;
  /** How long a name -> live site lookup is reused (default 3s: a rollback or new deployment can take up to this long to show per static process). */
  siteCacheMs?: number;
  /** Dynamic apps. Without it, dynamic apps answer 503 (runtime disabled). */
  dynamic?: {
    waker: Pick<Waker, 'ensure' | 'invalidate'>;
    /** Records the last access (default: apps.last_access_at); called at most once per `touchIntervalMs` per app. */
    touch?: (appId: string) => Promise<void>;
    touchIntervalMs?: number;
    /** Protocol clients use to reach the edge, sent as X-Forwarded-Proto (default https: a TLS proxy sits in front). */
    proto?: 'http' | 'https';
  };
}

export type StaticApp = Hono & {
  /** `server.on('upgrade', app.handleUpgrade)`: tunnels WebSocket upgrades to dynamic apps. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // No X-Frame-Options: embedding is the site owner's choice.
} as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, lang: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style></head><body><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>`;
}

/** Request path as sent by the client. Node's adapter normalises `..` into the URL, so prefer the raw target. */
function rawPath(c: Context): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  let target = incoming?.url;
  if (!target || !target.startsWith('/')) {
    const u = c.req.url;
    const i = u.indexOf('//');
    target = i === -1 ? u : u.slice(u.indexOf('/', i + 2) === -1 ? u.length : u.indexOf('/', i + 2));
  }
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

export function createStaticApp(deps: StaticAppDeps): StaticApp {
  const now = deps.now ?? (() => new Date());
  const siteCacheMs = deps.siteCacheMs ?? 3_000;
  const sites = new Map<string, { at: number; site: LiveApp | null }>();

  async function lookup(name: string) {
    const hit = sites.get(name);
    if (hit && Date.now() - hit.at < siteCacheMs) return hit.site;
    const site = await findLiveApp(deps.db, name);
    sites.set(name, { at: Date.now(), site });
    if (sites.size > 5000) sites.clear();
    return site;
  }

  /** Streams the object, counting every chunk that is handed to the client. */
  function counted(appId: string, body: Readable): ReadableStream<Uint8Array> {
    const it = body[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const r = await it.next();
        if (r.done) return ctrl.close();
        const chunk = r.value as Uint8Array;
        deps.meter.record(appId, chunk.byteLength);
        ctrl.enqueue(chunk);
      },
      async cancel() {
        body.destroy();
      },
    });
  }

  const touched = new Map<string, number>();
  function touch(appId: string): void {
    const at = Date.now();
    const last = touched.get(appId);
    if (last !== undefined && at - last < (deps.dynamic?.touchIntervalMs ?? 60_000)) return;
    touched.set(appId, at);
    if (touched.size > 5000) touched.clear();
    (deps.dynamic?.touch ?? ((id) => touchLastAccess(deps.db, id)))(appId).catch((e: unknown) => {
      touched.delete(appId);
      console.error('last access update failed', appId, e);
    });
  }
  const proto = deps.dynamic?.proto ?? 'https';
  const startFailed = (c: Context, retryAfter = '5') => {
    const locale = pickLocale(c.req.header('accept-language'));
    return c.html(page(t(locale, 'dynamic.startFailedTitle'), t(locale, 'dynamic.startFailedBody'), locale), 503, { ...SECURITY_HEADERS, 'Retry-After': retryAfter, 'Cache-Control': 'no-store' });
  };
  const limitPage = (c: Context) => {
    const locale = pickLocale(c.req.header('accept-language'));
    return c.html(page(t(locale, 'transfer.limitTitle'), t(locale, 'transfer.limitBody'), locale), 503, {
      ...SECURITY_HEADERS, 'Retry-After': String(secondsUntilNextMonth(now())), 'Cache-Control': 'no-store',
    });
  };

  async function proxyDynamic(c: Context, site: Extract<LiveApp, { kind: 'dynamic' }>): Promise<Response> {
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    if (!incoming) return c.text('Internal Server Error', 500);
    if (await deps.meter.isBlocked(site.appId)) return limitPage(c);
    if (!deps.dynamic) return startFailed(c);
    touch(site.appId);
    const woke = await deps.dynamic.waker.ensure(site.appId, site.deploymentId);
    if (!woke.ok) return startFailed(c);
    try {
      // The target is always the driver's endpoint, never anything derived from the request.
      const r = await proxyRequest(incoming, { host: woke.host, port: woke.port }, {
        proto, onBytes: (n) => deps.meter.record(site.appId, n),
      });
      return new Response(r.body, { status: r.status, headers: r.headers });
    } catch (e) {
      const why = e as ProxyFailure;
      if (why === 'too_large') return c.text('Payload Too Large', 413, { Connection: 'close' });
      if (why === 'timeout') return c.text('Gateway Timeout', 504);
      deps.dynamic.waker.invalidate(site.appId);
      return c.text('Bad Gateway', 502);
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reply = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    void (async () => {
      const name = resolveSite(req.headers.host ?? '', deps.baseDomain);
      const site = name ? await lookup(name) : null;
      if (!site || site.kind !== 'dynamic') return reply('404 Not Found');
      if (await deps.meter.isBlocked(site.appId)) return reply('503 Service Unavailable');
      if (!deps.dynamic) return reply('503 Service Unavailable');
      touch(site.appId);
      const woke = await deps.dynamic.waker.ensure(site.appId, site.deploymentId);
      if (!woke.ok) return reply('503 Service Unavailable');
      // A long-lived connection keeps the app awake.
      const keepAlive = setInterval(() => touch(site.appId), 30_000);
      socket.once('close', () => clearInterval(keepAlive));
      try {
        await proxyUpgrade(req, socket, head, { host: woke.host, port: woke.port }, { proto, onBytes: (n) => deps.meter.record(site.appId, n) });
      } catch (e) {
        clearInterval(keepAlive);
        if (e !== 'timeout') deps.dynamic.waker.invalidate(site.appId);
        reply(e === 'timeout' ? '504 Gateway Timeout' : '502 Bad Gateway');
      }
    })().catch((e: unknown) => { console.error('upgrade failed', e); socket.destroy(); });
  }

  const app = new Hono() as StaticApp;
  app.handleUpgrade = handleUpgrade;
  app.all('*', async (c) => {
    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ ...SECURITY_HEADERS, ...extra });
    const method = c.req.method;
    const name = resolveSite(c.req.header('host') ?? '', deps.baseDomain);
    const notFound = () => c.text('Not Found', 404, headers());
    if (method !== 'GET' && method !== 'HEAD') {
      const dyn = name ? await lookup(name) : null;
      if (dyn?.kind === 'dynamic') return proxyDynamic(c, dyn);
      return c.body('Method Not Allowed', 405, headers({ Allow: 'GET, HEAD' }));
    }
    if (!name) return notFound();
    const site0 = await lookup(name);
    if (site0?.kind === 'dynamic') return proxyDynamic(c, site0);
    const parsed = parsePath(rawPath(c));
    if ('status' in parsed && parsed.status === 400) return c.text('Bad Request', 400, headers());
    const site = site0;
    if (!site) return notFound();

    if (await deps.meter.isBlocked(site.appId)) {
      const locale = pickLocale(c.req.header('accept-language'));
      return c.html(page(t(locale, 'transfer.limitTitle'), t(locale, 'transfer.limitBody'), locale), 503, headers({
        'Retry-After': String(secondsUntilNextMonth(now())),
        'Cache-Control': 'no-store',
      }));
    }

    const send = async (key: string, status: 200 | 404) => {
      const obj = await deps.storage.get(`${site.siteKey}${key}`);
      if (!obj) return null;
      const etag = `"${createHash('sha1').update(`${site.siteKey}${key}`).update(String(obj.size)).digest('hex').slice(0, 32)}"`;
      const h = headers({
        'Content-Type': contentTypeFor(key),
        'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-cache',
        ...(status === 200 ? { ETag: etag } : {}),
      });
      if (status === 200 && c.req.header('if-none-match')?.split(',').some((v) => v.trim().replace(/^W\//, '') === etag)) {
        obj.body.destroy();
        return c.body(null, 304, h);
      }
      h['Content-Length'] = String(obj.size);
      if (method === 'HEAD') {
        obj.body.destroy();
        return c.body(null, status, h);
      }
      return c.body(counted(site.appId, obj.body), status, h);
    };

    if (!('status' in parsed)) {
      for (const key of candidates(parsed)) {
        const r = await send(key, 200);
        if (r) return r;
      }
    }
    return (await send('404.html', 404)) ?? c.html(page('404', 'Not Found', 'en'), 404, headers());
  });
  return app;
}
