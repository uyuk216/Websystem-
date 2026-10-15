import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import type { IncomingMessage } from 'node:http';
import { t } from 'i18n';
import { findLiveSite } from 'api/apps';
import { secondsUntilNextMonth, type TransferMeter } from 'api/transfer';
import type { Db } from 'api/db';
import type { StoredObject } from 'platform';
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
}

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

export function createStaticApp(deps: StaticAppDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const siteCacheMs = deps.siteCacheMs ?? 3_000;
  const sites = new Map<string, { at: number; site: { appId: string; siteKey: string } | null }>();

  async function lookup(name: string) {
    const hit = sites.get(name);
    if (hit && Date.now() - hit.at < siteCacheMs) return hit.site;
    const site = await findLiveSite(deps.db, name);
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

  const app = new Hono();
  app.all('*', async (c) => {
    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ ...SECURITY_HEADERS, ...extra });
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return c.body('Method Not Allowed', 405, headers({ Allow: 'GET, HEAD' }));
    const name = resolveSite(c.req.header('host') ?? '', deps.baseDomain);
    const notFound = () => c.text('Not Found', 404, headers());
    if (!name) return notFound();
    const parsed = parsePath(rawPath(c));
    if ('status' in parsed && parsed.status === 400) return c.text('Bad Request', 400, headers());
    const site = await lookup(name);
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
