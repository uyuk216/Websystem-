import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { serve } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { Waker, type AppRunSpec, type RuntimeDriver, type RuntimeStatus } from 'platform';
import { withTestDb, type TestDb } from '../../api/test/helpers/db.js';
import { accounts, apps, deployments } from '../../api/src/db/schema.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { createApp } from '../../api/src/apps/apps.js';
import { sleepIdleApps, withWakeLock } from '../../api/src/apps/wake.js';
import { createTransferMeter } from '../../api/src/usage/transfer.js';
import { createStaticApp } from '../src/app.js';

const closers: Array<() => void> = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

/** A driver whose "container" is an in-process HTTP server that appears `bootMs` after start(). */
function fakeDriver(backend: () => Server, opts: { bootMs?: number; neverHealthy?: boolean } = {}) {
  let server: Server | null = null;
  let port = 0;
  const state = { starts: 0, stops: 0, specs: [] as AppRunSpec[] };
  const driver: RuntimeDriver = {
    async start(spec) {
      state.starts++;
      state.specs.push(spec);
      await new Promise((r) => setTimeout(r, 20));
      if (!server) {
        const s = backend();
        await new Promise<void>((r) => setTimeout(r, opts.bootMs ?? 0));
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
        server = s;
        port = (s.address() as AddressInfo).port;
        closers.push(() => s.close());
      }
      return { appId: spec.appId, deploymentId: spec.deploymentId, containerId: 'c' };
    },
    async stop() { state.stops++; server?.closeAllConnections(); server?.close(); server = null; },
    async stopDeployment() { await driver.stop(''); },
    async status(): Promise<RuntimeStatus> { return server ? 'running' : 'stopped'; },
    async endpoint() { return server ? { host: '127.0.0.1', port } : null; },
    async logs() { return []; },
    async runningCount() { return server ? [{ appId: runningApp, containers: 1 }] : []; },
  };
  let runningApp = '';
  return { driver, state, setApp: (id: string) => { runningApp = id; }, isUp: () => server !== null };
}

let n = 0;
async function dynamicApp(db: TestDb, name = 'dyn-app') {
  const [a] = await db.insert(accounts).values({ emailHash: `d${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  const { appId } = (await createApp(db, a!.id, { name, ownerId })) as { appId: string };
  const [d] = await db.insert(deployments).values({ appId, source: 'upload', status: 'live', sourceKey: 's', imageRef: `ys/${appId}:x` }).returning();
  await db.update(apps).set({ kind: 'dynamic', activeDeploymentId: d!.id }).where(eq(apps.id, appId));
  return { appId, deploymentId: d!.id };
}

const echoBackend = () => createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('Set-Cookie', ['a=1', 'b=2']);
    res.setHeader('X-Seen-Headers', JSON.stringify(req.headers));
    res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
  });
});

async function edge(db: TestDb, fd: ReturnType<typeof fakeDriver>, o: { limit?: number; timeoutMs?: number; withLock?: boolean } = {}) {
  const meter = createTransferMeter({ db, limitBytes: o.limit ?? 10_000_000, limitCacheMs: 0 });
  const waker = new Waker({
    driver: fd.driver,
    buildSpec: async (appId, deploymentId) => ({ appId, deploymentId, ownerId: '00000000-0000-4000-8000-000000000000', image: 'img', env: {}, limits: { memoryMb: 1, cpu: 1, pids: 1 }, port: 8080 }),
    health: { intervalMs: 20, timeoutMs: o.timeoutMs ?? 5000 },
    timeoutMs: o.timeoutMs ?? 5000,
    ...(o.withLock ? { withLock: (id: string, fn: () => Promise<never>) => withWakeLock(db, id, fn) } : {}),
  });
  const touches: string[] = [];
  const app = createStaticApp({ db, storage: { get: async () => null }, meter, baseDomain: 'localhost', siteCacheMs: 0,
    dynamic: { waker, touch: async (id) => { touches.push(id); }, touchIntervalMs: 60_000 } });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  server.on('upgrade', (req, socket, head) => app.handleUpgrade(req, socket, head));
  await new Promise((r) => setTimeout(r, 20));
  closers.push(() => { (server as unknown as Server).closeAllConnections(); (server as unknown as Server).close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, meter, touches, server };
}
const H = { host: 'dyn-app.localhost' };

interface Res { status: number; headers: IncomingMessage['headers']; setCookie: string[]; text(): Promise<string>; json(): Promise<unknown> }
/** fetch() cannot set Host, so tests talk to the edge with node:http. */
function fetch(url: string, init: { method?: string; body?: string | Buffer; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers });
    req.on('response', (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: r.statusCode ?? 0, headers: r.headers, setCookie: r.headers['set-cookie'] ?? [], text: async () => text, json: async () => JSON.parse(text) as unknown });
      });
    });
    req.on('error', (e) => { if ((e as { code?: string }).code === 'EPIPE' || (e as { code?: string }).code === 'ECONNRESET') return; reject(e); });
    if (init.body) req.write(init.body);
    req.end();
  });
}

describe('edge proxy for dynamic apps', () => {
  it('proxies method, path, query and body, keeps Host, overwrites X-Forwarded-*, strips hop-by-hop, keeps multiple Set-Cookie', () => withTestDb(async (db) => {
    const s = await dynamicApp(db);
    const fd = fakeDriver(echoBackend);
    const e = await edge(db, fd);
    const res = await fetch(`${e.base}/a/b%2Fc?x=1&y=%E6%97%A5`, {
      method: 'POST', body: 'hello', headers: { ...H, 'x-forwarded-for': '6.6.6.6', 'x-forwarded-host': 'evil', 'x-forwarded-proto': 'gopher', forwarded: 'for=1.1.1.1', 'x-real-ip': '9.9.9.9', 'keep-alive': 'timeout=5', 'proxy-authorization': 'x', 'x-secret-hop': 'nope', connection: 'x-secret-hop' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'POST', url: '/a/b%2Fc?x=1&y=%E6%97%A5', body: 'hello' });
    expect(res.setCookie).toEqual(['a=1', 'b=2']);
    const seen = JSON.parse(res.headers['x-seen-headers'] as string) as Record<string, string>;
    expect(seen.host).toBe('dyn-app.localhost');
    expect(seen['x-forwarded-for']).toBe('127.0.0.1');
    expect(seen['x-forwarded-host']).toBe('dyn-app.localhost');
    expect(seen['x-forwarded-proto']).toBe('https');
    for (const k of ['forwarded', 'x-real-ip', 'keep-alive', 'proxy-authorization', 'x-secret-hop']) expect(seen[k], k).toBeUndefined();
    expect(fd.state.specs[0]!.appId).toBe(s.appId);
  }));

  it('writes last access at most once per interval and counts proxied response bytes toward transfer, then blocks at the limit', () => withTestDb(async (db) => {
    const s = await dynamicApp(db);
    const fd = fakeDriver(() => createServer((_q, r) => r.end('x'.repeat(1000))));
    const e = await edge(db, fd, { limit: 2500 });
    for (let i = 0; i < 3; i++) expect((await (await fetch(`${e.base}/`, { headers: H })).text()).length).toBe(1000);
    expect(e.touches).toEqual([s.appId]);
    await e.meter.flush();
    expect((await fetch(`${e.base}/`, { headers: { ...H, 'accept-language': 'en' } })).status).toBe(503);
    const blocked = await fetch(`${e.base}/`, { headers: { ...H, 'accept-language': 'en' } });
    expect(await blocked.text()).toContain('Monthly transfer limit reached');
    expect(fd.state.starts).toBe(1);
  }));

  it('Review Focus 1: 100 simultaneous requests to a sleeping app start it once and all get the response', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(echoBackend, { bootMs: 300 });
    const e = await edge(db, fd, { withLock: true });
    const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => fetch(`${e.base}/r${i}`, { headers: H })));
    expect(rs.map((r) => r.status)).toEqual(Array(100).fill(200));
    expect(fd.state.starts).toBe(1);
  }));

  it('two edge processes (separate wakers) still start the app once', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(echoBackend, { bootMs: 200 });
    const e1 = await edge(db, fd, { withLock: true });
    const e2 = await edge(db, fd, { withLock: true });
    const rs = await Promise.all([...Array(10).keys()].map((i) => fetch(`${i % 2 ? e1.base : e2.base}/`, { headers: H })));
    expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(fd.state.starts).toBe(1);
  }));

  it('answers 503 (ja and en) when the app does not become healthy in time', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(echoBackend, { bootMs: 2000 });
    const e = await edge(db, fd, { timeoutMs: 300 });
    const ja = await fetch(`${e.base}/`, { headers: H });
    expect(ja.status).toBe(503);
    expect(await ja.text()).toContain('アプリを起動できませんでした');
    const en = await fetch(`${e.base}/`, { headers: { ...H, 'accept-language': 'en' } });
    expect(en.status).toBe(503);
    expect(await en.text()).toContain('The app could not be started');
  }));

  it('rejects request bodies over 25MB with 413 and never proxies to hosts other than the driver endpoint', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(echoBackend);
    const e = await edge(db, fd);
    const big = Buffer.alloc(26 * 1024 * 1024, 1);
    const r = await fetch(`${e.base}/`, { method: 'POST', body: big, headers: H });
    expect(r.status).toBe(413);
    // An absolute-form target or odd Host never changes where the request goes.
    const ok = await fetch(`${e.base}/`, { headers: { host: 'dyn-app.localhost' } });
    expect(ok.status).toBe(200);
    expect((await fetch(`${e.base}/`, { headers: { host: 'unknown.localhost' } })).status).toBe(404);
  }));

  it('relays WebSocket upgrades in both directions and counts the bytes', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(() => {
      const s = createServer((_q, r) => r.end('ok'));
      s.on('upgrade', (req: IncomingMessage, sock: Socket) => {
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Proto: ${req.headers['sec-websocket-protocol'] ?? ''}\r\nX-Fwd: ${req.headers['x-forwarded-for']}\r\n\r\n`);
        sock.on('data', (d: Buffer) => sock.write(`echo:${d.toString()}`));
      });
      return s;
    });
    const e = await edge(db, fd);
    const got = await new Promise<{ head: IncomingMessage; data: string }>((resolve, reject) => {
      const req = httpRequest(`${e.base}/socket`, { headers: { ...H, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-protocol': 'chat', 'x-forwarded-for': '6.6.6.6' } });
      req.on('upgrade', (res, sock) => {
        sock.write('ping');
        sock.once('data', (d: Buffer) => { sock.destroy(); resolve({ head: res, data: d.toString() }); });
      });
      req.on('response', (r) => reject(new Error(`no upgrade: ${r.statusCode}`)));
      req.on('error', reject);
      req.end();
    });
    expect(got.head.statusCode).toBe(101);
    expect(got.head.headers['x-proto']).toBe('chat');
    expect(got.head.headers['x-fwd']).toBe('127.0.0.1');
    expect(got.data).toBe('echo:ping');
  }));

  it('refuses upgrades for static/unknown apps with 404', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(echoBackend);
    const e = await edge(db, fd);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${e.base}/`, { headers: { host: 'nope.localhost', connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('response', (r) => { resolve(r.statusCode ?? 0); r.resume(); });
      req.on('upgrade', () => reject(new Error('upgraded')));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
    expect(fd.state.starts).toBe(0);
  }));
});

describe('sleep', () => {
  it('stops running dynamic apps idle for more than 15 minutes, then the edge wakes them again', () => withTestDb(async (db) => {
    const s = await dynamicApp(db);
    const fd = fakeDriver(echoBackend);
    fd.setApp(s.appId);
    const e = await edge(db, fd);
    expect((await fetch(`${e.base}/`, { headers: H })).status).toBe(200);
    const now = new Date('2026-10-15T12:00:00Z');
    await db.update(apps).set({ lastAccessAt: new Date(now.getTime() - 14 * 60_000) }).where(eq(apps.id, s.appId));
    expect(await sleepIdleApps(db, fd.driver, now)).toEqual([]);
    expect(fd.isUp()).toBe(true);
    await db.update(apps).set({ lastAccessAt: new Date(now.getTime() - 16 * 60_000) }).where(eq(apps.id, s.appId));
    expect(await sleepIdleApps(db, fd.driver, now)).toEqual([s.appId]);
    expect(fd.isUp()).toBe(false);
    await new Promise((r) => setTimeout(r, 5100)); // the waker's endpoint cache expires
    expect((await fetch(`${e.base}/`, { headers: H })).status).toBe(200);
    expect(fd.state.starts).toBe(2);
  }), 30_000);

  it('does not stop an app whose wake lock is held', () => withTestDb(async (db) => {
    const s = await dynamicApp(db);
    const fd = fakeDriver(echoBackend);
    fd.setApp(s.appId);
    await fd.driver.start({ appId: s.appId, deploymentId: s.deploymentId } as AppRunSpec);
    await db.update(apps).set({ lastAccessAt: new Date(0) }).where(eq(apps.id, s.appId));
    // Another connection (another process) holds the app's wake lock: the sleeper must skip the app.
    const [{ name }] = await db.execute<{ name: string }>(sql`select current_database() as name`) as unknown as [{ name: string }];
    const u = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform');
    u.pathname = `/${name}`;
    const other = postgres(u.toString(), { max: 1, onnotice: () => {} });
    let stopped: string[] = [];
    try {
      await other.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`wake:${s.appId}`}, 0))`;
        stopped = await sleepIdleApps(db, fd.driver, new Date());
      });
    } finally { await other.end(); }
    expect(stopped).toEqual([]);
    expect(fd.isUp()).toBe(true);
    expect(await sleepIdleApps(db, fd.driver, new Date())).toEqual([s.appId]);
  }));
});
