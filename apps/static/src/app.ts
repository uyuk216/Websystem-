import { reportResponse } from './report-link.js';
import type { DistributionSample } from 'api/security-distribution';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import { t } from 'i18n';
import { findLiveApp, touchLastAccess, type LiveApp } from 'api/wake';
import { runtimeBlockedUntil } from 'api/runtime-hours';
import { secondsUntilNextMonth, type TransferMeter } from 'api/transfer';
import type { Db } from 'api/db';
import type { StoredObject } from 'platform';
import type { Duplex } from 'node:stream';
import type { Waker } from 'platform';
import type { AccessLogger } from 'api/logs';
import { securityGate, pausedPage } from 'api/security-gate';
import { hashIp } from 'api/security-ip';
import type { ConnectionRegistry } from './connections.js';
import { clientAddress, proxyRequest, proxyUpgrade, type ProxyFailure } from './proxy.js';
import { candidates, contentTypeFor, parsePath, pickLocale, resolveSite } from './site.js';

export interface SiteReader {
  get(key: string): Promise<StoredObject | null>;
}

export interface StaticAppDeps {
  db: Db;
  storage: SiteReader;
  meter: Pick<TransferMeter, 'record' | 'isBlocked'>;
  baseDomain: string;
  reportOrigin?: string;
  distribution?: { record(sample: DistributionSample): Promise<void> };
  now?: () => Date;
  /** Proxies in front of the edge whose X-Forwarded-For is trusted (EDGE_TRUSTED_PROXY_HOPS; default 0). */
  trustedProxyHops?: number;
  /** Access log sink (batched writes; never blocks a request). */
  accessLog?: Pick<AccessLogger, 'record'>;
  /** How long a name -> live site lookup is reused (default 3s: a rollback or new deployment can take up to this long to show per static process). */
  siteCacheMs?: number;
  /**
   * 自動対処の遮断（フェーズ 6）。指定すると、すべての HTTP / WebSocket が配信・プロキシの前に `securityGate` を通る
   * （許可は毎回引き直す。判定できなければ 503）。`connections` に登録した WebSocket・長い応答は、遮断の commit 後に閉じられる。
   */
  security?: { hashKey: Buffer; connections?: ConnectionRegistry };
  /** Dynamic apps. Without it, dynamic apps answer 503 (runtime disabled). */
  dynamic?: {
    waker: Pick<Waker, 'ensure' | 'invalidate'>;
    /** Records the last access (default: apps.last_access_at); called at most once per `touchIntervalMs` per app. */
    touch?: (appId: string) => Promise<void>;
    touchIntervalMs?: number;
    /** Protocol clients use to reach the edge, sent as X-Forwarded-Proto (default https: a TLS proxy sits in front). */
    proto?: 'http' | 'https';
    /** Until when the owner's runtime hours are used up (null = not blocked). Default: runtime_usage counters, cached 30s. */
    blockedUntil?: (ownerId: string) => Promise<Date | null>;
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
  const hops = deps.trustedProxyHops ?? 0;
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
  function counted(appId: string, body: Readable, ip: string): ReadableStream<Uint8Array> {
    const it = body[Symbol.asyncIterator]();
    const untrack = deps.security?.connections?.add({ appId, ipHash: hashIp(ip, deps.security.hashKey), close: () => body.destroy(new Error('security gate closed stream')) });
    body.once('close', () => untrack?.());
    return new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const r = await it.next();
          if (r.done) { untrack?.(); return ctrl.close(); }
          const chunk = r.value as Uint8Array;
          deps.meter.record(appId, chunk.byteLength);
          ctrl.enqueue(chunk);
        } catch (e) { untrack?.(); ctrl.error(e); }
      },
      async cancel() {
        untrack?.();
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

  /** 遮断の判定。遮断中は 503（日英の一時停止ページ、no-store）、判定不能も 503。通せるなら null。 */
  async function gateHttp(c: Context, appId: string | undefined, ip: string): Promise<Response | null> {
    if (!deps.security) return null;
    const locale = pickLocale(c.req.header('accept-language'));
    try {
      const v = await securityGate(deps.db, { appId, clientIp: ip, hashKey: deps.security.hashKey });
      if (v.allow) return null;
      return c.html(pausedPage(locale, 'paused'), 503, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
    } catch (e) {
      console.error('security gate failed', e);
      return c.html(pausedPage(locale, 'unavailable'), 503, { ...SECURITY_HEADERS, 'Retry-After': '5', 'Cache-Control': 'no-store' });
    }
  }
  const requestIp = (c: Context): string => {
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    return incoming ? clientAddress(incoming.headers['x-forwarded-for'], incoming.socket.remoteAddress, hops) : '';
  };

  const blockCache = new Map<string, { at: number; until: Date | null }>();
  async function blockedUntil(ownerId: string): Promise<Date | null> {
    const hit = blockCache.get(ownerId);
    if (hit && Date.now() - hit.at < 30_000) return hit.until;
    const until = await (deps.dynamic?.blockedUntil ?? ((o: string) => runtimeBlockedUntil(deps.db, o, now())))(ownerId);
    blockCache.set(ownerId, { at: Date.now(), until });
    if (blockCache.size > 5000) blockCache.clear();
    return until;
  }
  /** 503 "runtime limit reached" page with the date the app comes back (JST calendar date). */
  const runtimeLimitPage = (c: Context, until: Date) => {
    const locale = pickLocale(c.req.header('accept-language'));
    const j = new Date(until.getTime() + 9 * 3600_000);
    const date = locale === 'ja'
      ? `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日`
      : `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][j.getUTCMonth()]} ${j.getUTCDate()}, ${j.getUTCFullYear()}`;
    return c.html(page(t(locale, 'runtime.limitTitle'), t(locale, 'runtime.limitBody', { until: date }), locale), 503, {
      ...SECURITY_HEADERS, 'Retry-After': String(Math.max(1, Math.ceil((until.getTime() - now().getTime()) / 1000))), 'Cache-Control': 'no-store',
    });
  };

  async function proxyDynamic(c: Context, site: Extract<LiveApp, { kind: 'dynamic' }>): Promise<Response> {
    const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
    if (!incoming) return c.text('Internal Server Error', 500);
    if (await deps.meter.isBlocked(site.appId)) return limitPage(c);
    if (!deps.dynamic) return startFailed(c);
    // Never wake (or keep serving) an app whose owner used up their runtime hours.
    const until = await blockedUntil(site.ownerId);
    if (until) return runtimeLimitPage(c, until);
    touch(site.appId);
    // A client that leaves while the app is starting must not make the edge connect to the app afterwards.
    const abort = new AbortController();
    const onGone = () => abort.abort();
    incoming.socket.once('close', onGone);
    const untrack = deps.security?.connections?.add({
      appId: site.appId, ipHash: hashIp(clientAddress(incoming.headers['x-forwarded-for'], incoming.socket.remoteAddress, hops), deps.security.hashKey),
      close: () => abort.abort(),
    });
    try {
      const woke = await deps.dynamic.waker.ensure(site.appId, site.deploymentId);
      if (abort.signal.aborted) return new Response(null, { status: 499 });
      if (!woke.ok) return startFailed(c);
      const stopped = await gateHttp(c, site.appId, requestIp(c));
      if (stopped) return stopped;
      // The target is always the driver's endpoint, never anything derived from the request.
      const r = await proxyRequest(incoming, { host: woke.host, port: woke.port }, {
        clientIp: clientAddress(incoming.headers['x-forwarded-for'], incoming.socket.remoteAddress, hops),
        proto, signal: abort.signal, onBytes: (n) => { deps.meter.record(site.appId, n); touch(site.appId); },
      });
      return new Response(r.body, { status: r.status, headers: r.headers });
    } catch (e) {
      const why = e as ProxyFailure;
      if (abort.signal.aborted) return new Response(null, { status: 499 });
      if (why === 'too_large') {
        discardBody(incoming);
        return c.text('Payload Too Large', 413);
      }
      if (why === 'timeout') return c.text('Gateway Timeout', 504);
      deps.dynamic.waker.invalidate(site.appId);
      return c.text('Bad Gateway', 502);
    } finally {
      incoming.socket.off('close', onGone);
      // 応答の本体を流している間も登録しておき、終わったら外す。
      if (untrack) {
        const outgoing = (c.env as { outgoing?: { once(e: 'close', fn: () => void): unknown; writableEnded?: boolean } } | undefined)?.outgoing;
        if (outgoing) outgoing.once('close', untrack); else incoming.socket.once('close', untrack);
      }
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // First thing, before any await: a client reset while the app is starting must not be an uncaught 'error'.
    let closed = false;
    let keepAlive: NodeJS.Timeout | undefined;
    let untrackWs: (() => void) | undefined;
    // Access log for upgrades: one entry when the tunnel closes (101 and the bytes relayed), or the refusal status.
    let wsAppId: string | null = null;
    let wsBytes = 0;
    let wsStatus = 0;
    const wsLog = () => {
      if (!wsAppId || !wsStatus || !deps.accessLog) return;
      const url = req.url ?? '/';
      const end = url.search(/[?#]/);
      try {
        deps.accessLog.record({
          appId: wsAppId, method: req.method ?? 'GET', path: end === -1 ? url : url.slice(0, end), status: wsStatus, bytes: wsBytes,
          userAgent: req.headers['user-agent'] ?? null, referrer: req.headers.referer ?? null,
          ip: clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress, hops),
        });
      } catch (e) { console.error('access log failed', e); }
      wsAppId = null;
    };
    const cleanup = () => { closed = true; clearInterval(keepAlive); untrackWs?.(); wsLog(); };
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    const reply = (status: string) => {
      if (wsAppId && !wsStatus) wsStatus = Number(status.slice(0, 3));
      if (!closed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
    };
    void (async () => {
      if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return reply('400 Bad Request');
      const name = resolveSite(req.headers.host ?? '', deps.baseDomain);
      const site = name ? await lookup(name) : null;
      if (closed) return;
      const wsIp = clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress, hops);
      if (deps.security) {
        // 遮断中・判定不能は 503。許可は毎回引き直す。
        const v = await securityGate(deps.db, { appId: site?.appId, clientIp: wsIp, hashKey: deps.security.hashKey }).catch((e: unknown) => { console.error('security gate failed', e); return null; });
        if (closed) return;
        if (!v?.allow) { if (site) wsAppId = site.appId; return reply('503 Service Unavailable'); }
      }
      if (!site || site.kind !== 'dynamic') return reply('404 Not Found');
      wsAppId = site.appId;
      if (await deps.meter.isBlocked(site.appId)) return reply('503 Service Unavailable');
      if (!deps.dynamic) return reply('503 Service Unavailable');
      if (await blockedUntil(site.ownerId)) return reply('503 Service Unavailable');
      if (closed) return;
      touch(site.appId);
      const woke = await deps.dynamic.waker.ensure(site.appId, site.deploymentId);
      if (closed || socket.destroyed) return; // the client left while the app was starting
      if (!woke.ok) return reply('503 Service Unavailable');
      if (deps.security && !(await securityGate(deps.db, { appId: site.appId, clientIp: wsIp, hashKey: deps.security.hashKey })).allow) return reply('503 Service Unavailable');
      // 遮断が commit されたら、この接続も閉じる（登録簿が DB の通知と定期の再照合で見る）。
      if (deps.security?.connections) untrackWs = deps.security.connections.add({ appId: site.appId, ipHash: hashIp(wsIp, deps.security.hashKey), close: () => socket.destroy() });
      // A long-lived connection keeps the app awake; cleared when the socket closes.
      keepAlive = setInterval(() => touch(site.appId), 30_000);
      try {
        const accepted = await proxyUpgrade(req, socket, head, { host: woke.host, port: woke.port }, { proto, clientIp: clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress, hops), onBytes: (n) => { wsBytes += n; deps.meter.record(site.appId, n); } });
        // An accepted tunnel is logged as 101 when it closes; a refusal from the app is relayed as-is and not logged
        // (its status line belongs to the app).
        if (!wsStatus && accepted) wsStatus = 101;
        if (closed) wsLog();
      } catch (e) {
        if (e !== 'timeout') deps.dynamic.waker.invalidate(site.appId);
        reply(e === 'timeout' ? '504 Gateway Timeout' : '502 Bad Gateway');
      }
    })().catch((e: unknown) => { console.error('upgrade failed', e); socket.destroy(); });
  }

  const app = new Hono() as StaticApp;
  app.handleUpgrade = handleUpgrade;
  app.use('*', async (c, next) => {
    await next();
    // Shared caches must not bypass the next security decision, including dynamic responses.
    if (deps.security) { c.header('Cache-Control', 'no-store'); c.header('CDN-Cache-Control', 'no-store'); }
    const appId = c.get('logAppId' as never) as string | undefined;
    if (appId && deps.reportOrigin) c.res = reportResponse(c.res, c.req.method, deps.reportOrigin, appId);
    if (appId && deps.distribution && c.res.body && c.req.method !== 'HEAD' && ![204, 304].includes(c.res.status)) {
      const reader = c.res.body.getReader(); let bytes = 0, finished = false;
      const finish = async () => { if (finished) return; finished = true; await deps.distribution!.record({ appId, bytes, path: rawPath(c), referrer: c.req.header('referer') ?? null, origin: new URL(c.req.url).origin, at: +now() }); };
      c.res = new Response(new ReadableStream<Uint8Array>({ async pull(ctrl) { try { const part = await reader.read(); if (part.done) { await finish(); ctrl.close(); } else { bytes += part.value.byteLength; ctrl.enqueue(part.value); } } catch (e) { await finish(); ctrl.error(e); } }, async cancel(reason) { await finish(); await reader.cancel(reason); } }), { status: c.res.status, headers: c.res.headers });
    }
    if (!appId || !deps.accessLog) return;
    try {
      const log = deps.accessLog;
      const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
      const entry = {
        appId, method: c.req.method, path: rawPath(c), status: c.res.status,
        userAgent: c.req.header('user-agent'), referrer: c.req.header('referer'), ip: incoming ? clientAddress(incoming.headers['x-forwarded-for'], incoming.socket.remoteAddress, hops) : '',
      };
      const declared = c.res.headers.get('content-length');
      if (declared !== null || !c.res.body) {
        log.record({ ...entry, bytes: Number(declared ?? 0) || 0 });
        return;
      }
      // No Content-Length (streamed/chunked): count what is actually sent and record when the body ends or is cancelled.
      let bytes = 0;
      let done = false;
      const finish = () => { if (!done) { done = true; log.record({ ...entry, bytes }); } };
      const counted = c.res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctrl) { bytes += chunk.byteLength; ctrl.enqueue(chunk); },
        flush() { finish(); },
      }));
      const reader = counted.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const r = await reader.read();
            if (r.done) { finish(); ctrl.close(); } else ctrl.enqueue(r.value);
          } catch (e) { finish(); ctrl.error(e); }
        },
        cancel(reason) { finish(); return reader.cancel(reason); },
      });
      c.res = new Response(body, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers });
    } catch (e) { console.error('access log failed', e); }
  });
  app.all('*', async (c) => {
    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ ...SECURITY_HEADERS, ...extra });
    const method = c.req.method;
    const name = resolveSite(c.req.header('host') ?? '', deps.baseDomain);
    const notFound = () => c.text('Not Found', 404, headers());
    if (method !== 'GET' && method !== 'HEAD') {
      const dyn = name ? await lookup(name) : null;
      if (dyn) c.set('logAppId' as never, dyn.appId as never);
      const stopped = await gateHttp(c, dyn?.appId, requestIp(c));
      if (stopped) return stopped;
      if (dyn?.kind === 'dynamic') return proxyDynamic(c, dyn);
      return c.body('Method Not Allowed', 405, headers({ Allow: 'GET, HEAD' }));
    }
    const site0 = name ? await lookup(name) : null;
    if (site0) c.set('logAppId' as never, site0.appId as never);
    const stopped = await gateHttp(c, site0?.appId, requestIp(c));
    if (stopped) return stopped;
    if (!name) return notFound();
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
        'Cache-Control': deps.security ? 'no-store' : status === 200 ? 'public, max-age=60' : 'no-cache',
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
      return c.body(counted(site.appId, obj.body, requestIp(c)), status, h);
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

/**
 * Reads and drops the rest of a rejected request body. A client still uploading would otherwise fill the TCP
 * buffers and never read the 413. Past a cap the connection is cut instead of reading forever.
 */
function discardBody(incoming: IncomingMessage, cap = 64 * 1024 * 1024): void {
  let seen = 0;
  incoming.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > cap) incoming.socket.destroy();
  });
  incoming.resume();
}
