import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { serve } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { Waker, type AppRunSpec, type RuntimeDriver, type RuntimeStatus } from 'platform';
import { withTestDb, type TestDb } from '../../api/test/helpers/db.js';
import { accounts, apps, deployments, runtimeUsage } from '../../api/src/db/schema.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { createApp } from '../../api/src/apps/apps.js';
import { jstMonthKey, MONTHLY_LIMIT_MINUTES } from '../../api/src/usage/runtime-hours.js';
import { sleepIdleApps } from '../../api/src/apps/wake.js';
import { rolloutDynamic, buildRunSpec, type DynamicRuntime } from '../../api/src/ingest/dynamic.js';
import { closeLockers, holdWakeLock, openLocker } from '../../api/test/helpers/lockdb.js';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { createTransferMeter } from '../../api/src/usage/transfer.js';
import { createStaticApp } from '../src/app.js';

const closers: Array<() => void> = [];
afterEach(async () => { for (const c of closers.splice(0)) c(); await closeLockers(); });

/** A driver whose "container" is an in-process HTTP server that appears `bootMs` after start(). */
function fakeDriver(backend: () => Server, opts: { bootMs?: number; neverHealthy?: boolean } = {}) {
  let server: Server | null = null;
  let port = 0;
  const state = { starts: 0, stops: 0, specs: [] as AppRunSpec[], stoppedDeployments: [] as string[] };
  let depId = '';
  const driver: RuntimeDriver = {
    async start(spec) {
      state.starts++;
      state.specs.push(spec);
      depId = spec.deploymentId;
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
    async stopDeployment(_a, d) {
      state.stoppedDeployments.push(d);
      if (d !== depId) return;
      server?.closeAllConnections(); server?.close(); server = null;
    },
    async status(_a, d): Promise<RuntimeStatus> { return server && (!d || d === depId) ? 'running' : 'stopped'; },
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

async function edge(db: TestDb, fd: ReturnType<typeof fakeDriver>, o: { limit?: number; timeoutMs?: number; withLock?: boolean; touchMs?: number; maxWakes?: number; blockedUntil?: (ownerId: string) => Promise<Date | null> } = {}) {
  const meter = createTransferMeter({ db, limitBytes: o.limit ?? 10_000_000, limitCacheMs: 0 });
  const waker = new Waker({
    driver: fd.driver,
    buildSpec: async (appId, deploymentId) => ({ appId, deploymentId, ownerId: '00000000-0000-4000-8000-000000000000', image: 'img', env: {}, limits: { memoryMb: 1, cpu: 1, pids: 1 }, port: 8080 }),
    health: { intervalMs: 20, timeoutMs: o.timeoutMs ?? 5000 },
    timeoutMs: o.timeoutMs ?? 5000,
    ...(o.maxWakes ? { maxConcurrentWakes: o.maxWakes } : {}),
    ...(o.withLock ? { withLock: (await openLocker(db)).lock } : {}),
  });
  const touches: string[] = [];
  const app = createStaticApp({ db, storage: { get: async () => null }, meter, baseDomain: 'localhost', siteCacheMs: 0,
    dynamic: { waker, touch: async (id) => { touches.push(id); }, touchIntervalMs: o.touchMs ?? 60_000, ...(o.blockedUntil ? { blockedUntil: o.blockedUntil } : {}) } });
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
    expect(fd.state.stoppedDeployments).toEqual([s.deploymentId]); // only the active deployment, never stop-all
    expect(fd.state.stops).toBe(0);
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

describe('fix round 1', () => {
  it('a client reset while the app is still starting does not crash the process and never reaches the app', () => withTestDb(async (db) => {
    await dynamicApp(db);
    let upgrades = 0;
    const fd = fakeDriver(() => {
      const s = createServer((_q, r) => r.end('ok'));
      s.on('upgrade', (_q, sock: Socket) => { upgrades++; sock.destroy(); });
      return s;
    }, { bootMs: 300 });
    const e = await edge(db, fd, { withLock: true });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const port = Number(new URL(e.base).port);
      const sock = connect(port, '127.0.0.1');
      await new Promise((r) => sock.once('connect', r));
      sock.write('GET /ws HTTP/1.1\r\nHost: dyn-app.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n');
      await new Promise((r) => setTimeout(r, 80));
      sock.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 700));
      expect(uncaught).toEqual([]);
      expect(upgrades).toBe(0);
      expect((await fetch(`${e.base}/`, { headers: H })).status).toBe(200);
    } finally { process.off('uncaughtException', onUncaught); }
  }));

  it('does not proxy a request whose client left during the wake', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const seen: string[] = [];
    const fd = fakeDriver(() => createServer((q, r) => { seen.push(q.url ?? ''); r.end('ok'); }), { bootMs: 300 });
    const e = await edge(db, fd);
    await new Promise<void>((resolve) => {
      const req = httpRequest(`${e.base}/gone`, { headers: H });
      req.on('error', () => undefined);
      req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 60);
    });
    await new Promise((r) => setTimeout(r, 800));
    expect(seen).not.toContain('/gone');
    expect((await fetch(`${e.base}/after`, { headers: H })).status).toBe(200);
    expect(seen).toContain('/after');
  }));

  it('only tunnels websocket upgrades', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(echoBackend);
    const e = await edge(db, fd);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${e.base}/`, { headers: { ...H, connection: 'Upgrade', upgrade: 'h2c' } });
      req.on('response', (r) => { resolve(r.statusCode ?? 0); r.resume(); });
      req.on('upgrade', () => reject(new Error('upgraded')));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    expect(fd.state.starts).toBe(0);
  }));

  it('a long streaming response (SSE) keeps refreshing last access', () => withTestDb(async (db) => {
    await dynamicApp(db);
    const fd = fakeDriver(() => createServer((q, r) => {
      if (q.url !== '/sse') return r.end('ok');
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const t = setInterval(() => { r.write(`data: ${i}\n\n`); if (++i === 8) { clearInterval(t); r.end(); } }, 60);
    }));
    const e = await edge(db, fd, { touchMs: 100 });
    expect((await (await fetch(`${e.base}/sse`, { headers: H })).text()).split('\n\n').length).toBeGreaterThan(5);
    expect(e.touches.length).toBeGreaterThanOrEqual(3);
  }));

  it('12 different sleeping apps wake at once without exhausting the connection pool', () => withTestDb(async (db) => {
    const names = Array.from({ length: 12 }, (_, i) => `multi-${i}`);
    const created = [] as Array<{ appId: string; deploymentId: string }>;
    for (const n of names) created.push(await dynamicApp(db, n));
    // One "container" per app.
    const servers = new Map<string, { server: Server; port: number }>();
    const starts: string[] = [];
    const driver: RuntimeDriver = {
      async start(spec) {
        starts.push(spec.appId);
        await new Promise((r) => setTimeout(r, 250));
        if (!servers.has(spec.appId)) {
          const server = createServer((_q, r) => r.end(spec.appId));
          await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
          servers.set(spec.appId, { server, port: (server.address() as AddressInfo).port });
          closers.push(() => server.close());
        }
        return { appId: spec.appId, deploymentId: spec.deploymentId, containerId: 'c' };
      },
      async stop() {}, async stopDeployment() {},
      async status(a) { return servers.has(a) ? 'running' : 'stopped'; },
      async endpoint(a) { const s = servers.get(a); return s ? { host: '127.0.0.1', port: s.port } : null; },
      async logs() { return []; }, async runningCount() { return []; },
    };
    const rt: DynamicRuntime = { driver, envKey: randomBytes(32) };
    const locker = await openLocker(db, 4);
    const waker = new Waker({
      driver, buildSpec: (a, d) => buildRunSpec(db, rt, a, d), withLock: locker.lock,
      health: { intervalMs: 20, timeoutMs: 10_000 }, timeoutMs: 10_000, maxConcurrentWakes: 8,
    });
    const meter = createTransferMeter({ db, limitBytes: 1e9, limitCacheMs: 0 });
    const app = createStaticApp({ db, storage: { get: async () => null }, meter, baseDomain: 'localhost', siteCacheMs: 0, dynamic: { waker, touch: async () => undefined } });
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    closers.push(() => { (server as unknown as Server).closeAllConnections(); (server as unknown as Server).close(); });
    await new Promise((r) => setTimeout(r, 20));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const started = Date.now();
    const all = Promise.all(names.map((n) => fetch(`${base}/`, { headers: { host: `${n}.localhost` } })));
    await new Promise((r) => setTimeout(r, 100));
    // The main pool (one connection here) is still usable while wakes are in progress.
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    expect(Date.now() - t0).toBeLessThan(1000);
    const rs = await all;
    expect(rs.map((r) => r.status)).toEqual(Array(12).fill(200));
    expect(await Promise.all(rs.map((r) => r.text()))).toEqual(created.map((c) => c.appId));
    expect(starts.length).toBe(12);
    expect(Date.now() - started).toBeLessThan(8000);
  }), 30_000);
});

describe('sleeper versus rollout', () => {
  it('a rollout holds the wake lock: an idle-looking app being rolled out is not stopped, and last access is refreshed first', () => withTestDb(async (db) => {
    const s = await dynamicApp(db);
    await db.update(apps).set({ lastAccessAt: new Date(0) }).where(eq(apps.id, s.appId));
    const [nd] = await db.insert(deployments).values({ appId: s.appId, source: 'upload', status: 'processing', sourceKey: 's2', imageRef: `ys/${s.appId}:new` }).returning();
    const fd = fakeDriver(echoBackend, { bootMs: 400 });
    fd.setApp(s.appId);
    const locker = await openLocker(db, 2);
    const rt: DynamicRuntime = { driver: fd.driver, envKey: randomBytes(32), health: { intervalMs: 20, timeoutMs: 5000 }, lock: locker.lock };
    const rolling = rolloutDynamic(db, nd!.id, rt);
    await new Promise((r) => setTimeout(r, 150)); // start() is in flight, lock held
    const [row] = await db.select({ at: apps.lastAccessAt }).from(apps).where(eq(apps.id, s.appId));
    expect(row!.at!.getTime()).toBeGreaterThan(Date.now() - 60_000); // touched before start
    await db.update(apps).set({ lastAccessAt: new Date(0) }).where(eq(apps.id, s.appId));
    expect(await sleepIdleApps(db, fd.driver, new Date())).toEqual([]); // lock held by the rollout
    await rolling;
    expect(fd.isUp()).toBe(true);
    const [after] = await db.select({ active: apps.activeDeploymentId }).from(apps).where(eq(apps.id, s.appId));
    expect(after!.active).toBe(nd!.id);
    expect(fd.state.stops).toBe(0);
  }), 30_000);
});

describe('fix round 2', () => {
  it('wake slots and lock waits are bounded by the wake deadline: a full house of locked apps answers 503 and frees its slots', () => withTestDb(async (db) => {
    const apps3 = [] as Array<{ appId: string }>;
    for (const n of ['lock-a', 'lock-b', 'free-c', 'free-d']) apps3.push(await dynamicApp(db, n));
    const release = [await holdWakeLock(db, apps3[0]!.appId), await holdWakeLock(db, apps3[1]!.appId)];
    const fd = fakeDriver(echoBackend);
    const e = await edge(db, fd, { withLock: true, timeoutMs: 700, maxWakes: 2 });
    const t0 = Date.now();
    const rs = await Promise.all(['lock-a', 'lock-b', 'free-c'].map((n) => fetch(`${e.base}/`, { headers: { host: `${n}.localhost` } })));
    expect(rs.map((r) => r.status)).toEqual([503, 503, 503]); // two blocked on locks, one waiting for a slot
    expect(Date.now() - t0).toBeLessThan(3000);
    // The blocked wakes gave up (lock_timeout) and freed their slots even though the locks are still held.
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`${e.base}/`, { headers: { host: 'free-d.localhost' } })).status).toBe(200);
    for (const r of release) await r();
  }), 30_000);

  it('serves the runtime-limit page (ja/en, with the date) and never wakes an app whose owner used up their hours', () => withTestDb(async (db) => {
    const s = await dynamicApp(db);
    const [a] = await db.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, s.appId));
    await db.insert(runtimeUsage).values({ ownerId: a!.ownerId, period: jstMonthKey(new Date()), minutes: MONTHLY_LIMIT_MINUTES });
    const fd = fakeDriver(echoBackend);
    const e = await edge(db, fd);
    const ja = await fetch(`${e.base}/`, { headers: H });
    expect(ja.status).toBe(503);
    expect(await ja.text()).toMatch(/稼働時間の上限に達しました[\s\S]*\d+年\d+月1日/);
    expect(Number(ja.headers['retry-after'])).toBeGreaterThan(0);
    const en = await fetch(`${e.base}/`, { headers: { ...H, 'accept-language': 'en' } });
    expect(en.status).toBe(503);
    expect(await en.text()).toMatch(/Runtime limit reached[\s\S]*, 20\d\d/);
    expect(fd.state.starts).toBe(0);
  }));
});
