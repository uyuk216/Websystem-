import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Waker, type RuntimeDriver } from 'platform';
import { closeLockers, holdWakeLock, openLocker } from './helpers/lockdb.js';
afterEach(closeLockers);
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { giveStudent } from './helpers/grants.js';
import { accounts, apps, deployments, securityBlocks } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createSession } from '../src/auth/sessions.js';
import { createApp } from '../src/http/app.js';
import { createApp as createAppRecord } from '../src/apps/apps.js';
import { restart, rollback as rollbackReal } from '../src/apps/deployments.js';
import { buildRunSpec, rolloutDynamic as rolloutDynamicReal, type DynamicRuntime } from '../src/ingest/dynamic.js';
import { transitionUsageState } from '../src/usage/state.js';
import { buildSignal } from '../src/security/signals.js';
import { activeBlocks, handleSecuritySignal } from '../src/security/incidents.js';
import { isAppBlocked, securityGate } from '../src/security/gate.js';
import { createSecurityGateApp } from '../src/security/internal-server.js';
import { hashIp, isInternalPeer, normalizeIp } from '../src/security/ip.js';
import { trustedClientIp } from '../src/security/client-ip.js';
import { loadSecurityKey } from '../src/security/config.js';

const KEY = Buffer.alloc(32, 5);
let n = 0;
async function acct(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `g${n++}-${randomUUID().slice(0, 6)}`, emailEnc: 'x', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function dynApp(db: TestDb, name = `g-${randomUUID().slice(0, 8)}`) {
  const a = await acct(db);
  await giveStudent(db, a.id);
  const r = await createAppRecord(db, a.id, { name, ownerId: a.ownerId, kind: 'dynamic' }) as { appId: string };
  const [d] = await db.insert(deployments).values({ appId: r.appId, source: 'upload', status: 'live', sourceKey: 'k', imageRef: 'img:1' }).returning();
  await db.update(apps).set({ activeDeploymentId: d!.id }).where(eq(apps.id, r.appId));
  return { accountId: a.id, ownerId: a.ownerId, appId: r.appId, deploymentId: d!.id, name };
}
const block = (db: TestDb, target: Parameters<typeof buildSignal>[0]['target'], over: Partial<Parameters<typeof buildSignal>[0]> = {}) =>
  handleSecuritySignal(db, buildSignal({ source: 'falco', sourceEventId: `e-${randomUUID().slice(0, 8)}`, ruleVersion: '1', occurredAt: new Date(), severity: 'high', target, reasonCode: 'falco.shell', evidence: { rule: 'x' }, ...over }));
const peerEnv = (addr: string) => ({ incoming: { socket: { remoteAddress: addr } } });
const srv = createServer((_q, r) => r.end('ok'));
let port = 1;
beforeAll(async () => { await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as AddressInfo).port; });
afterAll(() => { srv.close(); });
function fakeRt(healthy = true) {
  const calls: string[] = [];
  const driver = {
    start: async () => { calls.push('start'); return {}; }, stopDeployment: async () => { calls.push('stop'); },
    status: async () => (healthy ? 'running' : 'crashed'), endpoint: async () => ({ host: '127.0.0.1', port }), logs: async () => [],
  } as unknown as RuntimeDriver;
  return { calls, rt: { driver, envKey: Buffer.alloc(32, 7), health: { timeoutMs: 300, intervalMs: 50 } } as DynamicRuntime };
}

describe('IP の正規化と信頼するクライアント IP', () => {
  it('IPv4-mapped と IPv6 の表記ゆれは同じ正規形・同じ HMAC になる', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::FFFF:0102:0304')).toBe('1.2.3.4');
    expect(normalizeIp('[2001:DB8:0:0:0:0:0:1]')).toBe('2001:db8:0:0:0:0:0:1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0:0:0:0:1');
    expect(normalizeIp('fe80::1%en0')).toBe('fe80:0:0:0:0:0:0:1');
    expect(normalizeIp('not an ip')).toBeNull();
    expect(normalizeIp('999.1.1.1')).toBeNull();
    expect(hashIp('2001:db8::1', KEY)).toBe(hashIp('2001:DB8:0:0:0:0:0:1', KEY));
    expect(hashIp('::ffff:1.2.3.4', KEY)).toBe(hashIp('1.2.3.4', KEY));
    expect(hashIp('1.2.3.4', KEY)).not.toBe(hashIp('1.2.3.4', Buffer.alloc(32, 6)));
    expect(hashIp('1.2.3.4', KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('内部ネットワークの判定', () => {
    for (const ok of ['127.0.0.1', '::1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '::ffff:10.0.0.1', 'fd00::5', '100.100.1.1']) expect(isInternalPeer(ok), ok).toBe(true);
    for (const no of ['8.8.8.8', '172.32.0.1', '203.0.113.9', '2001:db8::1', '', undefined, 'x']) expect(isInternalPeer(no), String(no)).toBe(false);
  });
  it('trustedClientIp: 直アクセス（公開アドレスの接続元）・不足・IP でない値では XFF を採らず、IPv4-mapped は IPv4 に直す', () => {
    expect(trustedClientIp('6.6.6.6', '203.0.113.50', 1)).toBe('203.0.113.50'); // プロキシを通らない直アクセス
    expect(trustedClientIp('6.6.6.6, 9.9.9.9', '10.0.0.1', 1)).toBe('9.9.9.9');
    expect(trustedClientIp('6.6.6.6, ::ffff:9.9.9.9', '10.0.0.1', 1)).toBe('9.9.9.9');
    expect(trustedClientIp('6.6.6.6, garbage', '10.0.0.1', 1)).toBe('10.0.0.1');
    expect(trustedClientIp('9.9.9.9', '10.0.0.1', 2)).toBe('10.0.0.1');
    expect(trustedClientIp('9.9.9.9', '10.0.0.1', 0)).toBe('10.0.0.1');
    expect(trustedClientIp('9.9.9.9', '::ffff:10.0.0.1', 1)).toBe('9.9.9.9');
    expect(trustedClientIp(undefined, undefined, 1)).toBeNull();
  });
  it('SECURITY_IP_KEY: 本番では必須、32 バイト以外は拒否', () => {
    expect(() => loadSecurityKey({ NODE_ENV: 'production' })).toThrow(/SECURITY_IP_KEY/);
    expect(() => loadSecurityKey({ SECURITY_IP_KEY: 'AAAA' })).toThrow(/32 bytes/);
    expect(loadSecurityKey({ SECURITY_IP_KEY: Buffer.alloc(32, 1).toString('base64') })).toEqual(Buffer.alloc(32, 1));
  });
});

describe('securityGate', () => {
  it('アプリ・アカウント（オーナー経由を含む）・IP のどれかに当たれば拒否し、解除後は次の判定から通る（許可を覚えない）', () => withTestDb(async (db) => {
    const a = await dynApp(db); const b = await dynApp(db);
    expect(await securityGate(db, { appId: a.appId, clientIp: '1.2.3.4', hashKey: KEY })).toEqual({ allow: true });
    await block(db, { kind: 'app', appId: a.appId });
    expect(await securityGate(db, { appId: a.appId, hashKey: KEY })).toMatchObject({ allow: false, scope: 'app' });
    expect(await securityGate(db, { appId: b.appId, hashKey: KEY })).toEqual({ allow: true });
    await block(db, { kind: 'account', accountId: b.accountId }, { reasonCode: 'abuse.account' });
    expect(await securityGate(db, { appId: b.appId, hashKey: KEY })).toMatchObject({ allow: false, scope: 'account' });
    const ipHash = hashIp('203.0.113.7', KEY)!;
    await block(db, { kind: 'ip', ipHash }, { source: 'honeytoken', reasonCode: 'honey.scan', severity: 'medium' });
    expect(await securityGate(db, { clientIp: '::ffff:203.0.113.7', hashKey: KEY })).toMatchObject({ allow: false, scope: 'ip' });
    expect(await securityGate(db, { clientIp: '203.0.113.8', hashKey: KEY })).toEqual({ allow: true });
    await db.update(securityBlocks).set({ releasedAt: new Date() }).where(eq(securityBlocks.targetKind, 'app'));
    expect(await isAppBlocked(db, a.appId)).toBe(false);
  }));

  it('月初・年度の切り替え・付与の期限でも、セキュリティの遮断は外れない', () => withTestDb(async (db) => {
    const a = await dynApp(db);
    await block(db, { kind: 'app', appId: a.appId });
    for (const ev of ['month_start_reset', 'fiscal_year_rollover', 'grant_expired', 'reregistered'] as const) {
      await transitionUsageState(db, a.ownerId, ev, { now: new Date('2027-05-01T00:00:00+09:00') });
    }
    expect(await activeBlocks(db, { appId: a.appId })).toHaveLength(1);
    expect(await isAppBlocked(db, a.appId)).toBe(true);
  }));
});

describe('内部の判定口（Traefik ForwardAuth）', () => {
  const build = (db: TestDb, hops = 1) => createSecurityGateApp({ db, hashKey: KEY, trustedProxyHops: hops, siteName: (h) => /^([a-z0-9-]+)\.localhost(:\d+)?$/.exec(h)?.[1] ?? null });
  const call = (app: ReturnType<typeof build>, peer: string, headers: Record<string, string>) => app.request('/gate', { headers }, peerEnv(peer));

  it('許可は 204、遮断は 503（日英の一時停止ページ・no-store）、他のアプリは通る', () => withTestDb(async (db) => {
    const a = await dynApp(db, 'blocked-one'); await dynApp(db, 'fine-one');
    const app = build(db);
    expect((await call(app, '10.0.0.1', { 'x-forwarded-host': 'fine-one.localhost', 'x-forwarded-for': '203.0.113.1' })).status).toBe(204);
    await block(db, { kind: 'app', appId: a.appId });
    const ja = await call(app, '10.0.0.1', { 'x-forwarded-host': 'blocked-one.localhost', 'x-forwarded-for': '203.0.113.1', 'accept-language': 'ja' });
    expect(ja.status).toBe(503);
    expect(ja.headers.get('cache-control')).toBe('no-store');
    expect(await ja.text()).toContain('一時停止中');
    const en = await call(app, '10.0.0.1', { 'x-forwarded-host': 'blocked-one.localhost', 'x-forwarded-for': '203.0.113.1', 'accept-language': 'en-US' });
    expect(await en.text()).toContain('temporarily paused');
    expect((await call(app, '10.0.0.1', { 'x-forwarded-host': 'fine-one.localhost', 'x-forwarded-for': '203.0.113.1' })).status).toBe(204);
  }));

  it('内部ネットワーク以外の接続元は何を名乗っても 403。許可を意味するヘッダーは無い', () => withTestDb(async (db) => {
    const app = build(db);
    for (const peer of ['203.0.113.9', '8.8.8.8', '2001:db8::1']) {
      const r = await call(app, peer, { 'x-forwarded-host': 'fine.localhost', 'x-security-allow': '1', 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '127.0.0.1' });
      expect(r.status, peer).toBe(403);
    }
    expect((await app.request('/gate', { headers: { 'x-forwarded-host': 'x.localhost' } })).status).toBe(403); // 接続元不明
  }));

  it('IP ブロックは XFF の右側（プロキシが付けた値）で判定。左側の偽装では逃れも巻き込みもない。サイトの Host でなくても IP は見る', () => withTestDb(async (db) => {
    await dynApp(db, 'site-a');
    await block(db, { kind: 'ip', ipHash: hashIp('203.0.113.7', KEY)! }, { source: 'honeytoken', reasonCode: 'honey.scan', severity: 'medium' });
    const app = build(db);
    expect((await call(app, '10.0.0.1', { 'x-forwarded-host': 'site-a.localhost', 'x-forwarded-for': '203.0.113.7' })).status).toBe(503);
    expect((await call(app, '10.0.0.1', { 'x-forwarded-host': 'site-a.localhost', 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })).status).toBe(503);
    expect((await call(app, '10.0.0.1', { 'x-forwarded-host': 'site-a.localhost', 'x-forwarded-for': '203.0.113.7, 1.1.1.1' })).status).toBe(204);
    expect((await call(app, '10.0.0.1', { 'x-forwarded-host': 'app.example.org', 'x-forwarded-for': '::ffff:203.0.113.7' })).status).toBe(503);
    expect((await call(app, '10.0.0.1', {})).status).toBe(204);
  }));

  it('判定できないとき（DB 障害）は 503 で通さない。復旧すれば通る', () => withTestDb(async (db) => {
    await dynApp(db, 'site-b');
    const app = build(db);
    await db.execute(sql`alter table security_blocks rename to security_blocks_x`);
    const bad = await call(app, '10.0.0.1', { 'x-forwarded-host': 'site-b.localhost', 'x-forwarded-for': '1.1.1.1' });
    expect(bad.status).toBe(503);
    expect(bad.headers.get('cache-control')).toBe('no-store');
    await db.execute(sql`alter table security_blocks_x rename to security_blocks`);
    expect((await call(app, '10.0.0.1', { 'x-forwarded-host': 'site-b.localhost', 'x-forwarded-for': '1.1.1.1' })).status).toBe(204);
  }));
});

describe('本体 API の入口', () => {
  const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'a@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };
  it('IP ブロックはすべての経路（/healthz 以外）を止め、アカウントのブロックは変更系だけを止める。判定不能は 503', () => withTestDb(async (db) => {
    const app = createApp({ db, mailer: createFakeMailer(), config: cfg, security: { hashKey: KEY }, trustedProxyHops: 1 } as never);
    const a = await acct(db);
    const s = await createSession(db, a.id, 'dev');
    const h = { cookie: `sid=${s.token}` };
    const viaProxy = (ip: string, init: RequestInit = {}) => app.request('/me/sessions', { ...init, headers: { ...h, 'x-forwarded-for': ip, ...(init.headers as Record<string, string>) } }, peerEnv('127.0.0.1'));
    expect((await viaProxy('203.0.113.7')).status).toBe(200);
    await block(db, { kind: 'ip', ipHash: hashIp('203.0.113.7', KEY)! }, { source: 'honeytoken', reasonCode: 'honey.scan', severity: 'medium' });
    expect((await viaProxy('203.0.113.7')).status).toBe(403);
    expect((await viaProxy('203.0.113.8')).status).toBe(200);
    expect((await app.request('/healthz', { headers: { 'x-forwarded-for': '203.0.113.7' } }, peerEnv('127.0.0.1'))).status).toBe(200);
    // アカウント: 閲覧は続けられ、変更（ログアウト以外の POST など）は止まる
    await block(db, { kind: 'account', accountId: a.id }, { reasonCode: 'abuse.account' });
    expect((await viaProxy('203.0.113.8')).status).toBe(200);
    const del = await app.request('/teams', { method: 'POST', body: '{"name":"t"}', headers: { ...h, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' } }, peerEnv('127.0.0.1'));
    expect(del.status).toBe(403);
    expect(await del.json()).toEqual({ error: 'security_blocked' });
    await db.execute(sql`alter table security_blocks rename to security_blocks_x`);
    expect((await viaProxy('203.0.113.8')).status).toBe(503);
    await db.execute(sql`alter table security_blocks_x rename to security_blocks`);
  }));
});

describe('起動・再デプロイ・ロールバック・再起動の迂回', () => {
  it('rechecks a block committed while a different connection holds the wake lock', () => withTestDb(async (db) => {
    const a = await dynApp(db); const locker = await openLocker(db);
    const release = await holdWakeLock(db, a.appId);
    let built!: () => void; const specBuilt = new Promise<void>((resolve) => { built = resolve; });
    const f = fakeRt();
    f.rt.driver.status = async () => 'stopped';
    const waker = new Waker({ driver: f.rt.driver, withLock: locker.lock,
      buildSpec: async () => { built(); return { appId: a.appId, deploymentId: a.deploymentId, ownerId: a.ownerId, image: 'img', env: {}, limits: { memoryMb: 128, cpu: 1, pids: 64 }, port: 8080 }; },
      allowStart: async (id) => !(await isAppBlocked(db, id)), timeoutMs: 10000,
    });
    const waking = waker.ensure(a.appId, a.deploymentId);
    try { await specBuilt; await block(db, { kind: 'app', appId: a.appId }); }
    finally { await release(); }
    expect(await waking).toEqual({ ok: false, reason: 'blocked' });
    expect(f.calls).toEqual([]);
  }));

  it('buildRunSpec refuses blocked apps without exposing decrypted environment', () => withTestDb(async (db) => {
    const a = await dynApp(db);
    await block(db, { kind: 'app', appId: a.appId });
    expect(await buildRunSpec(db, fakeRt().rt, a.appId, a.deploymentId)).toBeNull();
  }));

  it('遮断中は rolloutDynamic が起動せず（built のまま・画像は残す）、解除後の再実行は通る', () => withTestDb(async (db) => {
    const a = await dynApp(db);
    const [d2] = await db.insert(deployments).values({ appId: a.appId, source: 'upload', status: 'processing', sourceKey: 'k2', imageRef: 'img:2' }).returning();
    await block(db, { kind: 'app', appId: a.appId });
    const f = fakeRt();
    await rolloutDynamic(db, d2!.id, f.rt);
    expect(f.calls).toEqual([]);
    const [row] = await db.select().from(deployments).where(eq(deployments.id, d2!.id));
    expect(row).toMatchObject({ status: 'built', imageRef: 'img:2', message: 'deploy.error.security_blocked' });
    expect((await db.select().from(apps).where(eq(apps.id, a.appId)))[0]!.activeDeploymentId).toBe(a.deploymentId); // 切り替わらない
  }));

  it('起動の後・切り替えの前に遮断されたら、起動した分を止めて切り替えない', () => withTestDb(async (db) => {
    const a = await dynApp(db);
    const [d2] = await db.insert(deployments).values({ appId: a.appId, source: 'upload', status: 'processing', sourceKey: 'k2', imageRef: 'img:2' }).returning();
    const calls: string[] = [];
    const driver = {
      start: async () => { calls.push('start'); await block(db, { kind: 'app', appId: a.appId }); return {}; },
      stopDeployment: async (_a: string, id: string) => { calls.push(`stop:${id === d2!.id ? 'new' : 'old'}`); },
      status: async () => 'running', endpoint: async () => ({ host: '127.0.0.1', port }), logs: async () => [],
    } as unknown as RuntimeDriver;
    await rolloutDynamic(db, d2!.id, { driver, envKey: Buffer.alloc(32, 7), health: { timeoutMs: 300, intervalMs: 50 } });
    expect(calls).toEqual(['start', 'stop:new']);
    expect((await db.select().from(apps).where(eq(apps.id, a.appId)))[0]!.activeDeploymentId).toBe(a.deploymentId);
    expect((await db.select().from(deployments).where(eq(deployments.id, d2!.id)))[0]!.status).toBe('built');
  }));

  it('ロールバックと再起動も、遮断中は起動しない（security_blocked）。解除後は通る', () => withTestDb(async (db) => {
    const a = await dynApp(db);
    const [old] = await db.insert(deployments).values({ appId: a.appId, source: 'upload', status: 'superseded', sourceKey: 'k0', imageRef: 'img:0' }).returning();
    await block(db, { kind: 'app', appId: a.appId });
    const f = fakeRt();
    expect(await rollback(db, a.accountId, a.appId, old!.id, f.rt)).toMatchObject({ error: 'security_blocked' });
    expect(await restart(db, a.accountId, a.appId, f.rt)).toMatchObject({ error: 'security_blocked' });
    expect(f.calls).toEqual([]);
    await db.update(securityBlocks).set({ releasedAt: new Date() });
    expect(await restart(db, a.accountId, a.appId, f.rt)).toEqual({ ok: true });
    expect(f.calls).toContain('start');
  }));
});

const rollback = (...a: Parameters<typeof rollbackReal>) => rollbackReal(a[0], a[1], a[2], a[3], a[4], { installed: true, check: async () => 'allow' });
const rolloutDynamic = (...a: Parameters<typeof rolloutDynamicReal>) => rolloutDynamicReal(a[0], a[1], a[2] ? { ...a[2], publication: { installed: true, check: async () => 'allow' } } : undefined);
