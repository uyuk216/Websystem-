import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { Waker, type AppRunSpec, type RuntimeDriver, type RuntimeStatus } from 'platform';
import { withTestDb, type TestDb } from '../../api/test/helpers/db.js';
import { giveStudent } from '../../api/test/helpers/grants.js';
import { accounts, apps, deployments, securityBlocks } from '../../api/src/db/schema.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { createApp } from '../../api/src/apps/apps.js';
import { createTransferMeter } from '../../api/src/usage/transfer.js';
import { buildSignal } from '../../api/src/security/signals.js';
import { handleSecuritySignal } from '../../api/src/security/incidents.js';
import { isAppBlocked } from '../../api/src/security/gate.js';
import { hashIp } from '../../api/src/security/ip.js';
import { createStaticApp, type SiteReader } from '../src/app.js';
import { ConnectionRegistry } from '../src/connections.js';

const KEY = Buffer.alloc(32, 9);
const closers: Array<() => void> = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

let n = 0;
async function site(db: TestDb, name: string, kind: 'static' | 'dynamic') {
  const [a] = await db.insert(accounts).values({ emailHash: `sc${n++}-${randomUUID().slice(0, 6)}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  if (kind === 'dynamic') await giveStudent(db, a!.id);
  const { appId } = (await createApp(db, a!.id, { name, ownerId })) as { appId: string };
  const [d] = await db.insert(deployments).values({ appId, source: 'upload', status: 'live', sourceKey: 's', siteKey: kind === 'static' ? `${appId}/d/` : null, imageRef: kind === 'dynamic' ? `ys/${appId}:x` : null }).returning();
  await db.update(apps).set({ activeDeploymentId: d!.id, kind }).where(eq(apps.id, appId));
  return { appId, accountId: a!.id, deploymentId: d!.id };
}
const storage: SiteReader = { get: async () => ({ body: Readable.from([Buffer.from('<h1>hi</h1>')]), size: 11, contentType: 'text/html' }) };
const block = (db: TestDb, target: Parameters<typeof buildSignal>[0]['target'], over: Partial<Parameters<typeof buildSignal>[0]> = {}) =>
  handleSecuritySignal(db, buildSignal({ source: 'falco', sourceEventId: `e-${randomUUID().slice(0, 8)}`, ruleVersion: '1', occurredAt: new Date(), severity: 'high', target, reasonCode: 'falco.shell', evidence: { rule: 'x' }, ...over }));

interface Res { status: number; headers: IncomingMessage['headers']; text(): Promise<string> }
function get(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers });
    req.on('response', (r) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: r.statusCode ?? 0, headers: r.headers, text: async () => text }); });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function backendFactory(hits: { n: number }, upgrades: Socket[] = []) {
  return () => {
    const s = createServer((req, res) => {
      hits.n++;
      if (req.url === '/stream') { res.write('first\n'); return; } // 終わらない長い応答
      res.end('ok');
    });
    s.on('upgrade', (_req: IncomingMessage, sock: Socket) => {
      hits.n++;
      upgrades.push(sock);
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      sock.on('data', (d: Buffer) => sock.write(`echo:${d.toString()}`));
    });
    return s;
  };
}
function fakeDriver(backend: () => Server) {
  let server: Server | null = null;
  let port = 0;
  const state = { starts: 0, stops: 0 };
  const driver: RuntimeDriver = {
    async start(spec: AppRunSpec) {
      state.starts++;
      if (!server) {
        const s = backend();
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
        server = s; port = (s.address() as AddressInfo).port;
        closers.push(() => { s.closeAllConnections(); s.close(); });
      }
      return { appId: spec.appId, deploymentId: spec.deploymentId, containerId: 'c' };
    },
    async stop() { state.stops++; server?.closeAllConnections(); server?.close(); server = null; },
    async stopDeployment() { server?.closeAllConnections(); server?.close(); server = null; },
    async status(): Promise<RuntimeStatus> { return server ? 'running' : 'stopped'; },
    async endpoint() { return server ? { host: '127.0.0.1', port } : null; },
    async logs() { return []; },
    async runningCount() { return []; },
  };
  return { driver, state };
}

async function edge(db: TestDb, o: { hops?: number; backend?: () => Server; allowStart?: boolean; connections?: ConnectionRegistry; reader?: SiteReader } = {}) {
  const meter = createTransferMeter({ db, limitBytes: 10_000_000, limitCacheMs: 0 });
  const fd = fakeDriver(o.backend ?? backendFactory({ n: 0 }));
  const waker = new Waker({
    driver: fd.driver,
    buildSpec: async (appId, deploymentId) => ({ appId, deploymentId, ownerId: randomUUID(), image: 'img', env: {}, limits: { memoryMb: 1, cpu: 1, pids: 1 }, port: 8080 }),
    health: { intervalMs: 20, timeoutMs: 3000 }, timeoutMs: 3000,
    ...(o.allowStart ? { allowStart: async (appId: string) => !(await isAppBlocked(db, appId)) } : {}),
  });
  const app = createStaticApp({ db, storage: o.reader ?? storage, meter, baseDomain: 'localhost', siteCacheMs: 0, trustedProxyHops: o.hops ?? 0,
    security: { hashKey: KEY, ...(o.connections ? { connections: o.connections } : {}) }, dynamic: { waker, touch: async () => undefined } });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  server.on('upgrade', (req, socket, head) => app.handleUpgrade(req, socket, head));
  await new Promise((r) => setTimeout(r, 20));
  closers.push(() => { (server as unknown as Server).closeAllConnections(); (server as unknown as Server).close(); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, fd, waker };
}

describe('edge: 静的サイトと全 HTTP メソッド', () => {
  it('closes an existing static response after a block and prevents shared caching', () => withTestDb(async (db) => {
    const a = await site(db, 'static-stream', 'static');
    const connections = new ConnectionRegistry(); const body = new PassThrough();
    const e = await edge(db, { connections, reader: { get: async () => ({ body, size: 100000, contentType: 'text/html' }) } });
    let received!: () => void; const first = new Promise<void>((r) => { received = r; });
    const ended = new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${e.base}/`, { headers: { host: 'static-stream.localhost' } });
      req.on('response', (res) => {
        expect(res.headers['cache-control']).toBe('no-store');
        res.once('data', received); res.on('error', () => resolve()); res.once('close', () => resolve()); res.resume();
      });
      req.on('error', reject); req.end();
    });
    body.write('first'); await first;
    expect(connections.size).toBe(1);
    await block(db, { kind: 'app', appId: a.appId }, { severity: 'medium' });
    expect(await connections.recheck(db)).toBe(1);
    await ended; expect(body.destroyed).toBe(true); expect(connections.size).toBe(0);
  }));

  it('遮断中のアプリは GET / HEAD / POST のすべてで 503（日英の一時停止ページ・no-store）。ほかのサイトは通る。解除後は次のリクエストから通る', () => withTestDb(async (db) => {
    const a = await site(db, 'static-a', 'static'); await site(db, 'static-b', 'static');
    const e = await edge(db);
    const h = (host: string, extra: Record<string, string> = {}) => ({ host: `${host}.localhost`, ...extra });
    expect((await get(`${e.base}/`, { headers: h('static-a') })).status).toBe(200);
    await block(db, { kind: 'app', appId: a.appId }, { severity: 'medium' });
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
      const r = await get(`${e.base}/`, { method, headers: h('static-a'), body: method === 'POST' ? 'x' : undefined });
      expect(r.status, method).toBe(503);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const ja = await get(`${e.base}/`, { headers: h('static-a', { 'accept-language': 'ja' }) });
    expect(await ja.text()).toContain('一時停止中');
    expect(await ja.text()).not.toContain('転送量');
    expect(await (await get(`${e.base}/`, { headers: h('static-a', { 'accept-language': 'en' }) })).text()).toContain('temporarily paused');
    expect((await get(`${e.base}/`, { headers: h('static-b') })).status).toBe(200);
    expect((await get(`${e.base}/`, { headers: h('nope') })).status).toBe(404);
    await db.update(securityBlocks).set({ releasedAt: new Date() });
    expect((await get(`${e.base}/`, { headers: h('static-a') })).status).toBe(200);
  }));

  it('再デプロイしても遮断は外れない（新しいデプロイが live になっても 503）', () => withTestDb(async (db) => {
    const a = await site(db, 'static-r', 'static');
    const e = await edge(db);
    await block(db, { kind: 'app', appId: a.appId }, { severity: 'medium' });
    const [d2] = await db.insert(deployments).values({ appId: a.appId, source: 'upload', status: 'live', sourceKey: 's2', siteKey: `${a.appId}/d2/` }).returning();
    await db.update(apps).set({ activeDeploymentId: d2!.id }).where(eq(apps.id, a.appId));
    expect((await get(`${e.base}/`, { headers: { host: 'static-r.localhost' } })).status).toBe(503);
  }));

  it('アカウントのブロックはそのオーナーのアプリに効く', () => withTestDb(async (db) => {
    const a = await site(db, 'static-acc', 'static');
    const e = await edge(db);
    await block(db, { kind: 'account', accountId: a.accountId }, { severity: 'medium', reasonCode: 'abuse.account' });
    expect((await get(`${e.base}/`, { headers: { host: 'static-acc.localhost' } })).status).toBe(503);
  }));
});

describe('edge: IP のブロックと X-Forwarded-For の偽装', () => {
  it('hops=0 では XFF を信じない（名乗っても通らず、他人を巻き込めもしない）', () => withTestDb(async (db) => {
    await site(db, 'ip-a', 'static');
    const e = await edge(db, { hops: 0 });
    await block(db, { kind: 'ip', ipHash: hashIp('203.0.113.7', KEY)! }, { source: 'honeytoken', reasonCode: 'honey.scan', severity: 'medium' });
    const host = { host: 'ip-a.localhost' };
    expect((await get(`${e.base}/`, { headers: { ...host, 'x-forwarded-for': '203.0.113.7' } })).status).toBe(200); // 実接続は 127.0.0.1
    await block(db, { kind: 'ip', ipHash: hashIp('127.0.0.1', KEY)! }, { source: 'honeytoken', reasonCode: 'honey.scan', severity: 'medium' });
    expect((await get(`${e.base}/`, { headers: { ...host, 'x-forwarded-for': '1.1.1.1' } })).status).toBe(503); // 偽装で逃げられない
  }));

  it('hops=1 ではプロキシが付けた右端の値で判定（左側の偽装は無視、IPv4-mapped も同じ IP）', () => withTestDb(async (db) => {
    await site(db, 'ip-b', 'static');
    const e = await edge(db, { hops: 1 });
    await block(db, { kind: 'ip', ipHash: hashIp('203.0.113.7', KEY)! }, { source: 'honeytoken', reasonCode: 'honey.scan', severity: 'medium' });
    const host = { host: 'ip-b.localhost' };
    expect((await get(`${e.base}/`, { headers: { ...host, 'x-forwarded-for': '203.0.113.7' } })).status).toBe(503);
    expect((await get(`${e.base}/`, { headers: { ...host, 'x-forwarded-for': '1.1.1.1, ::ffff:203.0.113.7' } })).status).toBe(503);
    expect((await get(`${e.base}/`, { headers: { ...host, 'x-forwarded-for': '203.0.113.7, 1.1.1.1' } })).status).toBe(200);
  }));

  it('判定できないとき（DB 障害）は 503 で通さない。復旧すれば通る', () => withTestDb(async (db) => {
    await site(db, 'ip-c', 'static');
    const e = await edge(db);
    await db.execute(sql`alter table security_blocks rename to security_blocks_x`);
    const bad = await get(`${e.base}/`, { headers: { host: 'ip-c.localhost' } });
    expect(bad.status).toBe(503);
    expect(bad.headers['cache-control']).toBe('no-store');
    await db.execute(sql`alter table security_blocks_x rename to security_blocks`);
    expect((await get(`${e.base}/`, { headers: { host: 'ip-c.localhost' } })).status).toBe(200);
  }));
});

describe('edge: 動的アプリ', () => {
  it('遮断中は GET / POST ともアプリに届かず、起動もしない。別のエッジ（再起動後）でも同じ', () => withTestDb(async (db) => {
    const a = await site(db, 'dyn-a', 'dynamic');
    const hits = { n: 0 };
    const e1 = await edge(db, { backend: backendFactory(hits) });
    expect((await get(`${e1.base}/`, { headers: { host: 'dyn-a.localhost' } })).status).toBe(200);
    const beforeBlock = hits.n; // Includes the runtime health probe.
    expect(beforeBlock).toBeGreaterThanOrEqual(1);
    await e1.fd.driver.stop(a.appId);
    await block(db, { kind: 'app', appId: a.appId });
    const e2 = await edge(db, { backend: backendFactory(hits) }); // 再起動した edge
    for (const [m, body] of [['GET', undefined], ['POST', 'x']] as const) {
      expect((await get(`${e2.base}/`, { method: m, body, headers: { host: 'dyn-a.localhost' } })).status, m).toBe(503);
    }
    expect(e2.fd.state.starts).toBe(0);
    expect(hits.n).toBe(beforeBlock);
  }));

  it('Waker.allowStart: 起動のロックの中で拒否されると起動せず blocked。解除後は起動し、blocked は覚えない', () => withTestDb(async (db) => {
    const a = await site(db, 'dyn-w', 'dynamic');
    const e = await edge(db, { allowStart: true });
    await block(db, { kind: 'app', appId: a.appId });
    expect(await e.waker.ensure(a.appId, a.deploymentId)).toEqual({ ok: false, reason: 'blocked' });
    expect(e.fd.state.starts).toBe(0);
    await db.update(securityBlocks).set({ releasedAt: new Date() });
    expect(await e.waker.ensure(a.appId, a.deploymentId)).toMatchObject({ ok: true });
    expect(e.fd.state.starts).toBe(1);
  }));

  it('WebSocket: 遮断中の新規は 503。確立済みの接続は、遮断の commit 後の再照合で閉じる（通知なしでも定期の再照合で閉じる）', () => withTestDb(async (db) => {
    const a = await site(db, 'dyn-ws', 'dynamic');
    const hits = { n: 0 };
    const connections = new ConnectionRegistry();
    const e = await edge(db, { backend: backendFactory(hits), connections });
    const open = () => new Promise<{ sock: Socket; closed: Promise<void> }>((resolve, reject) => {
      const req = httpRequest(`${e.base}/socket`, { headers: { host: 'dyn-ws.localhost', connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('upgrade', (_res, sock) => resolve({ sock, closed: new Promise((r) => sock.once('close', () => r())) }));
      req.on('response', (r) => reject(new Error(`no upgrade: ${r.statusCode}`)));
      req.on('error', reject);
      req.end();
    });
    const c1 = await open();
    c1.sock.write('ping');
    await new Promise((r) => c1.sock.once('data', r));
    expect(connections.size).toBe(1);

    await block(db, { kind: 'app', appId: a.appId });
    // 遮断を知らされなくても、定期の再照合（ここでは 50ms 間隔）で閉じる。複数 edge で通知が欠けた場合に相当。
    const stop = connections.start(db, 50);
    closers.push(stop);
    await Promise.race([c1.closed, new Promise((_r, rej) => setTimeout(() => rej(new Error('not closed in 2s')), 2000))]);
    expect(connections.size).toBe(0);
    // 新規は拒否される
    await expect(open()).rejects.toThrow(/503/);
  }));

  it('WebSocket: DB の通知相当（recheck の直接呼び出し）で即座に閉じ、遮断されていない接続は残る', () => withTestDb(async (db) => {
    const a = await site(db, 'dyn-ws1', 'dynamic'); const b = await site(db, 'dyn-ws2', 'dynamic');
    const connections = new ConnectionRegistry();
    const e = await edge(db, { connections });
    const open = (host: string) => new Promise<Socket>((resolve, reject) => {
      const req = httpRequest(`${e.base}/socket`, { headers: { host: `${host}.localhost`, connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('upgrade', (_res, sock) => resolve(sock));
      req.on('response', (r) => reject(new Error(`no upgrade: ${r.statusCode}`)));
      req.on('error', reject);
      req.end();
    });
    const sa = await open('dyn-ws1'); const sb = await open('dyn-ws2');
    const aClosed = new Promise<void>((r) => sa.once('close', () => r()));
    let bClosed = false; sb.once('close', () => { bClosed = true; });
    expect(connections.size).toBe(2);
    await block(db, { kind: 'app', appId: a.appId });
    expect(await connections.recheck(db)).toBe(1);
    await aClosed;
    await new Promise((r) => setTimeout(r, 50));
    expect(bClosed).toBe(false);
    expect(b.appId).not.toBe(a.appId);
    sb.destroy();
  }));

  it('長い応答（ストリーム）も、遮断の後の再照合で切られる。再照合が DB 障害で失敗した場合も安全側に切断する', () => withTestDb(async (db) => {
    const a = await site(db, 'dyn-st', 'dynamic');
    const connections = new ConnectionRegistry();
    const e = await edge(db, { backend: backendFactory({ n: 0 }), connections });
    const ended = new Promise<string>((resolve) => {
      const req = httpRequest(`${e.base}/stream`, { headers: { host: 'dyn-st.localhost' } });
      req.on('response', (r) => { r.on('data', () => undefined); r.on('end', () => resolve('end')); r.on('error', () => resolve('error')); r.on('close', () => resolve('close')); });
      req.on('error', () => resolve('error'));
      req.end();
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(connections.size).toBe(1);
    await block(db, { kind: 'app', appId: a.appId });
    await db.execute(sql`alter table security_blocks rename to security_blocks_x`);
    expect(await connections.recheck(db)).toBe(1); // 判定不能: 接続を閉じる（恒久ブロックは作らない）
    expect(connections.size).toBe(0);
    await db.execute(sql`alter table security_blocks_x rename to security_blocks`);
    expect(await connections.recheck(db)).toBe(0);
    expect(['end', 'close', 'error']).toContain(await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r('still open'), 2000))]));
  }));
});
