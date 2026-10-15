import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTestDb, type TestDb } from '../../api/test/helpers/db.js';
import { accounts, apps, deployments, transferUsage } from '../../api/src/db/schema.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { createApp } from '../../api/src/apps/apps.js';
import { createTransferMeter } from '../../api/src/usage/transfer.js';
import { createStaticApp, type SiteReader } from '../src/app.js';
import { parsePath, resolveSite } from '../src/site.js';

describe('resolveSite', () => {
  it('lowercases, ignores the port, and accepts exactly one label under the base domain', () => {
    expect(resolveSite('My-Site.LOCALHOST:8090', 'localhost')).toBe('my-site');
    expect(resolveSite('my-site.localhost', 'localhost')).toBe('my-site');
    expect(resolveSite('my-site.example.com:443', 'Example.com')).toBe('my-site');
    expect(resolveSite('my-site.localhost.', 'localhost')).toBe('my-site');
    expect(resolveSite('localhost:8090', 'localhost')).toBeNull();
    expect(resolveSite('a.b.localhost', 'localhost')).toBeNull();
    expect(resolveSite('my-site.example.com', 'localhost')).toBeNull();
    expect(resolveSite('evil-localhost', 'localhost')).toBeNull();
    expect(resolveSite('', 'localhost')).toBeNull();
    expect(resolveSite('[::1]:8090', 'localhost')).toBeNull();
    expect(resolveSite('-.localhost', 'localhost')).toBe('-');
  });
});

describe('parsePath', () => {
  it('decodes once, NFC-normalises, and classifies', () => {
    expect(parsePath('/')).toEqual({ segments: [], dir: true });
    expect(parsePath('/foo/')).toEqual({ segments: ['foo'], dir: true });
    expect(parsePath('/foo')).toEqual({ segments: ['foo'], dir: false });
    expect(parsePath('/%E6%97%A5%E6%9C%AC.html')).toEqual({ segments: ['日本.html'], dir: false });
    expect(parsePath('/%25252e')).toEqual({ segments: ['%252e'], dir: false }); // decoded exactly once
    expect(parsePath('/e%CC%81.txt')).toEqual({ segments: ['é.txt'], dir: false }); // NFD -> NFC
    expect(parsePath('/a//b')).toEqual({ segments: ['a', 'b'], dir: false });
    expect(parsePath('/.well-known/security.txt')).toEqual({ segments: ['.well-known', 'security.txt'], dir: false });
  });
  it('rejects traversal and NUL with 400, other dot-segments with 404', () => {
    for (const p of ['/..', '/a/../b', '/a/%2e%2e/b', '/%2E%2E%2Fetc', '/a%2f..%2fb', '/a%5Cb', '/%00', '/a%00.html', '/%zz', '/%E0%A4%A']) {
      expect(parsePath(p), p).toEqual({ status: 400 });
    }
    for (const p of ['/.env', '/.git/config', '/a/.hidden/x', '/.well-known/.secret', '/.', '/.well-known2', '/a/.']) {
      expect(parsePath(p), p).toEqual({ status: 404 });
    }
  });
});

function memoryStorage(files: Record<string, string | Buffer>): SiteReader & { gets: string[] } {
  const gets: string[] = [];
  return {
    gets,
    async get(key) {
      gets.push(key);
      const f = files[key];
      if (f === undefined) return null;
      const buf = Buffer.from(f);
      return { body: Readable.from([buf]), size: buf.length, contentType: 'application/octet-stream' };
    },
  };
}

let n = 0;
async function liveSite(db: TestDb, name = 'my-site', owner = 'o@example.com') {
  const [a] = await db.insert(accounts).values({ emailHash: `h${n++}`, emailEnc: owner, displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  const { appId } = (await createApp(db, a!.id, { name, ownerId })) as { appId: string };
  const [d] = await db.insert(deployments).values({ appId, source: 'upload', status: 'live', sourceKey: 's', siteKey: `${appId}/dep1/` }).returning();
  await db.update(apps).set({ activeDeploymentId: d!.id }).where(eq(apps.id, appId));
  return { appId, prefix: `${appId}/dep1/` };
}

const FILES = (p: string) => ({
  [`${p}index.html`]: '<h1>home</h1>',
  [`${p}foo/index.html`]: '<h1>foo dir</h1>',
  [`${p}about.html`]: '<h1>about</h1>',
  [`${p}日本.html`]: '<h1>nihon</h1>',
  [`${p}style.css`]: 'body{}',
  [`${p}.well-known/security.txt`]: 'Contact: x',
  [`${p}.env`]: 'SECRET=1',
  [`${p}.git/config`]: 'x',
});

const setup = (db: TestDb, files: Record<string, string>, opts: { limit?: number; clock?: { t: Date } } = {}) => {
  const storage = memoryStorage(files);
  const clock = opts.clock ?? { t: new Date('2026-10-15T00:00:00Z') };
  const meter = createTransferMeter({ db, limitBytes: opts.limit ?? 10_000, now: () => clock.t });
  const app = createStaticApp({ db, storage, meter, baseDomain: 'localhost', now: () => clock.t });
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.request(`http://x${path}`, { method, headers: { host: 'my-site.localhost:8090', ...headers } });
  return { app, storage, meter, get, clock };
};

describe('static server: host handling (Review Focus 2)', () => {
  it('lowercases the host, ignores the port, 404s for unknown apps and apps without a live deployment', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { get } = setup(db, FILES(s.prefix));
    expect((await get('/', { host: 'MY-SITE.Localhost:8090' })).status).toBe(200);
    expect((await get('/', { host: 'my-site.localhost' })).status).toBe(200);
    expect((await get('/', { host: 'nope.localhost:8090' })).status).toBe(404);
    expect((await get('/', { host: 'localhost:8090' })).status).toBe(404);
    expect((await get('/', { host: 'my-site.example.com' })).status).toBe(404);
    const [a] = await db.select().from(accounts).limit(1);
    const own = await ensureAccountOwner(db, a!.id);
    await db.insert(apps).values({ ownerId: own, name: 'empty-app' });
    expect((await get('/', { host: 'empty-app.localhost' })).status).toBe(404);
  }));
});

describe('static server: serving rules (Review Focus 4)', () => {
  it('serves index.html for / and /dir/, /dir, /dir/index.html, and <path>.html for extension-less paths', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { get } = setup(db, FILES(s.prefix));
    expect(await (await get('/')).text()).toBe('<h1>home</h1>');
    expect(await (await get('/foo/')).text()).toBe('<h1>foo dir</h1>');
    expect(await (await get('/foo')).text()).toBe('<h1>foo dir</h1>');
    expect(await (await get('/foo/index.html')).text()).toBe('<h1>foo dir</h1>');
    expect(await (await get('/about')).text()).toBe('<h1>about</h1>');
    expect(await (await get('/about.html')).text()).toBe('<h1>about</h1>');
    expect(await (await get('/a//about.html')).status).toBe(404);
    expect(await (await get('//about.html')).text()).toBe('<h1>about</h1>');
  }));

  it('decodes percent-encoded Japanese file names', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { get } = setup(db, FILES(s.prefix));
    const r = await get('/%E6%97%A5%E6%9C%AC.html');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<h1>nihon</h1>');
    expect((await get('/%E6%97%A5%E6%9C%AC')).status).toBe(200);
  }));

  it('rejects .. with 400 (also encoded) and never reads storage for it', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { get, storage } = setup(db, FILES(s.prefix));
    for (const p of ['/%2e%2e%2fetc/passwd', '/a%2f..%2fb', '/%00', '/..%2f']) expect((await get(p)).status, p).toBe(400);
    expect(storage.gets).toEqual([]);
  }));

  it('rejects a raw ../ request target over a real socket (no client-side normalisation)', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { app } = setup(db, FILES(s.prefix));
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    try {
      await new Promise((r) => server.once('listening', r));
      const port = (server.address() as AddressInfo).port;
      const raw = (target: string) => new Promise<string>((resolve, reject) => {
        const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: my-site.localhost\r\nConnection: close\r\n\r\n`));
        let out = '';
        sock.on('data', (d) => (out += d));
        sock.on('end', () => resolve(out));
        sock.on('error', reject);
      });
      expect(await raw('/about.html')).toMatch(/^HTTP\/1.1 200/);
      expect(await raw('/a/../about.html')).toMatch(/^HTTP\/1.1 400/);
      expect(await raw('/%2e%2e/about.html')).toMatch(/^HTTP\/1.1 400/);
      expect(await raw('/./about.html')).toMatch(/^HTTP\/1.1 404/);
    } finally {
      server.close();
    }
  }));

  it('404s dot-files (but serves .well-known) and uses the site 404.html or a default page', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { get } = setup(db, FILES(s.prefix));
    expect((await get('/.env')).status).toBe(404);
    expect((await get('/.git/config')).status).toBe(404);
    expect((await get('/x/.hidden/y')).status).toBe(404);
    const wk = await get('/.well-known/security.txt');
    expect(wk.status).toBe(200);
    expect(await wk.text()).toBe('Contact: x');
    const dflt = await get('/missing');
    expect(dflt.status).toBe(404);
    expect(await dflt.text()).toContain('404');
    const custom = setup(db, { ...FILES(s.prefix), [`${s.prefix}404.html`]: '<h1>custom 404</h1>' });
    const c = await custom.get('/missing');
    expect(c.status).toBe(404);
    expect(await c.text()).toBe('<h1>custom 404</h1>');
    expect((await custom.get('/.env')).status).toBe(404);
    expect(await (await custom.get('/.env')).text()).toBe('<h1>custom 404</h1>');
  }));

  it('sets content type, ETag, cache and security headers (no X-Frame-Options), supports 304, HEAD, and rejects other methods', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { get } = setup(db, FILES(s.prefix));
    const r = await get('/style.css');
    expect(r.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(r.headers.get('x-frame-options')).toBeNull();
    expect(r.headers.get('content-length')).toBe('6');
    const etag = r.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    await r.text();
    const nm = await get('/style.css', { 'if-none-match': etag });
    expect(nm.status).toBe(304);
    expect(await nm.text()).toBe('');
    const h = await get('/style.css', {}, 'HEAD');
    expect(h.status).toBe(200);
    expect(h.headers.get('content-length')).toBe('6');
    expect(await h.text()).toBe('');
    expect((await get('/style.css', {}, 'POST')).status).toBe(405);
  }));
});

describe('static server: transfer metering and limits', () => {
  it('counts bytes actually sent (not HEAD, not 304) and flushes them', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const { get, meter } = setup(db, FILES(s.prefix));
    await (await get('/')).text();
    await (await get('/style.css')).text();
    await get('/style.css', {}, 'HEAD');
    await meter.flush();
    const [row] = await db.select().from(transferUsage).where(eq(transferUsage.appId, s.appId));
    expect(row?.bytes).toBe('<h1>home</h1>'.length + 6);
    expect(row?.month).toBe('2026-10');
  }));

  it('returns 503 in ja or en by Accept-Language once the limit is reached, and resumes next UTC month', () => withTestDb(async (db) => {
    const s = await liveSite(db);
    const clock = { t: new Date('2026-10-15T00:00:00Z') };
    const { get, meter } = setup(db, FILES(s.prefix), { limit: 20, clock });
    await (await get('/')).text(); // 13 bytes
    await (await get('/about')).text(); // 14 more: 27 >= 20
    await meter.flush();
    clock.t = new Date('2026-10-15T00:01:00Z'); // past the 30s limit cache
    const ja = await get('/', { 'accept-language': 'ja,en;q=0.5' });
    expect(ja.status).toBe(503);
    expect(await ja.text()).toContain('今月の転送量の上限に達しました');
    expect(ja.headers.get('retry-after')).toBeTruthy();
    expect(ja.headers.get('cache-control')).toBe('no-store');
    const en = await get('/', { 'accept-language': 'en-US,en;q=0.9,ja;q=0.1' });
    expect(en.status).toBe(503);
    expect(await en.text()).toContain('Monthly transfer limit reached');
    expect((await get('/missing')).status).toBe(503); // 404s are blocked too
    await meter.flush();
    const [row] = await db.select().from(transferUsage).where(eq(transferUsage.appId, s.appId));
    expect(row?.bytes).toBe(27); // 503 pages are not metered
    clock.t = new Date('2026-11-01T00:00:00Z');
    expect((await get('/')).status).toBe(200);
  }));
});
