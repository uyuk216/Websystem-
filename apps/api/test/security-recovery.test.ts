import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import * as schema from '../src/db/schema.js';
import { accounts, adminAuditLog, apps, operators, securityAppeals, securityBlocks, securityIncidents, securityNotifications, securityOutbox, usageStates } from '../src/db/schema.js';
import { encryptEmail, hashEmail } from '../src/crypto/email.js';
import { ensureAccountOwner, createTeam } from '../src/teams/teams.js';
import { buildSignal } from '../src/security/signals.js';
import { handleSecuritySignal } from '../src/security/incidents.js';
import { notificationHandlers } from '../src/security/notifications.js';
import { drainSecurityOutbox, stopAppHandlers } from '../src/security/actions.js';
import { submitAppeal, userIncidents } from '../src/security/appeals.js';
import { blockedAppIds, isAppBlocked } from '../src/security/gate.js';
import { createApp } from '../src/http/app.js';
import { createAdminApp, defaultDangerousHandlers } from '../src/admin/server.js';
import { createSession } from '../src/auth/sessions.js';
import { createAdminSession } from '../src/admin/admin-session.js';
import { transitionUsageState } from '../src/usage/state.js';
import { runDueDangerous, DANGEROUS_LEAD_MS, scheduleDangerous } from '../src/admin/dangerous.js';
import { withAccount } from '../src/db/client.js';

const key = Buffer.alloc(32, 7), origin = 'https://admin.example.ts.net', now = new Date('2026-10-24T12:00:00Z');
async function account(db: TestDb, locale: 'ja' | 'en' = 'ja') {
  const email = `${randomUUID()}@example.test`;
  const [a] = await db.insert(accounts).values({ emailHash: hashEmail(email, key), emailEnc: encryptEmail(email, key), displayName: 'Test', locale, adultFrom: '2030-01' }).returning();
  return { ...a!, email, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function app(db: TestDb, ownerId: string, kind: 'static' | 'dynamic' = 'dynamic') {
  const [a] = await db.insert(apps).values({ ownerId, kind, name: `a-${randomUUID().slice(0, 10)}` }).returning();
  return a!.id;
}
function signal(target: Parameters<typeof buildSignal>[0]['target'], extra: Partial<Parameters<typeof buildSignal>[0]> = {}) {
  return buildSignal({ source: 'falco', sourceEventId: randomUUID(), ruleVersion: '1', occurredAt: now, severity: 'high', target, reasonCode: 'shell.internal_rule', evidence: { rule: 'private_detector' }, ...extra });
}
async function admin(db: TestDb) {
  const op = await account(db);
  await db.insert(operators).values({ accountId: op.id, tailscaleLogin: op.email, role: 'owner' });
  const session = await createAdminSession(db, op.id);
  const mailer = createFakeMailer();
  const api = createAdminApp({ db, mailer, emailEncKey: key, passkey: { rpId: 'example.ts.net', appOrigin: origin, emailEncKey: key }, tailscale: { required: true, devLoopback: false } });
  const call = (path: string, action?: string, body: unknown = { reason: 'reviewed' }, options: { ip?: string; cookie?: boolean } = {}) => api.request(`/admin/security${path}${action ? `/${action}` : ''}`, { method: action ? 'POST' : 'GET', headers: { 'tailscale-user-login': op.email, ...(options.cookie === false ? {} : { cookie: `asid=${session.token}` }), 'content-type': 'application/json' }, body: action ? JSON.stringify(body) : undefined }, { incoming: { socket: { remoteAddress: options.ip ?? '100.100.1.2' } } });
  return { op, call, mailer };
}

describe('Task 9 notifications', () => {
  it.each(['ja', 'en'] as const)('delivers safe %s owner/operator mail and web notices once, retries failed mail', (locale) => withTestDb(async (db) => {
    const a = await account(db, locale), op = await account(db, locale), id = await app(db, a.ownerId);
    await db.insert(operators).values({ accountId: op.id, tailscaleLogin: op.email, role: 'owner' });
    const incident = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }), { now });
    let fail = true;
    const sent: { to: string; body: string; key?: string }[] = [];
    const handlers = notificationHandlers(db, { emailKey: key, appOrigin: 'https://public.example', adminOrigin: origin, mailer: { sendMail: async (to, _s, body, key) => { if (fail) throw new Error('secret SMTP error'); sent.push({ to, body, key }); } } });
    const result = await drainSecurityOutbox(db, handlers, { now: new Date(now.getTime() + 60_000) });
    expect(result.failed).toBe(2);
    expect(await db.select().from(securityNotifications)).toHaveLength(2);
    fail = false;
    await drainSecurityOutbox(db, handlers, { now: new Date(now.getTime() + 120_000) });
    await drainSecurityOutbox(db, handlers, { now: new Date(now.getTime() + 180_000) });
    expect(sent).toHaveLength(2);
    const owner = sent.find((r) => r.to === a.email)!, operator = sent.find((r) => r.to === op.email)!;
    expect(owner.body).toContain(`/${locale}/security`);
    expect(owner.body).toContain(locale === 'ja' ? '自分で解除' : 'cannot lift');
    expect(owner.body).not.toMatch(/private_detector|internal_rule|evidence|ts.net/);
    expect(operator.body).toContain(incident.incidentId);
    expect(operator.body).toContain(origin);
    expect(sent.every((r) => /^[a-f0-9]{64}$/.test(r.key ?? ''))).toBe(true);
    expect((await db.select().from(securityOutbox)).every((r) => !r.failureCode?.includes('secret'))).toBe(true);
  }));
  it('prioritizes a honeytoken fanout AND its delivery ahead of a normal backlog', () => withTestDb(async (db) => {
    const a = await account(db), id = await app(db, a.ownerId), { op } = await admin(db);
    await handleSecuritySignal(db, signal({ kind: 'app', appId: id }, { source: 'cpu', severity: 'low' }), { now });
    const trap = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }, { source: 'honeytoken' }), { now });
    const mailer = createFakeMailer();
    const handlers = notificationHandlers(db, { mailer, emailKey: key, appOrigin: 'https://public.example', adminOrigin: origin });
    await drainSecurityOutbox(db, handlers, { now: new Date(now.getTime() + 60_000), limit: 3 });
    expect(mailer.lastBodyTo(op.email)).toContain(trap.incidentId);
    expect((await db.select().from(securityOutbox).where(and(eq(securityOutbox.kind, 'notify_operator'), eq(securityOutbox.priority, 0))))[0]!.doneAt).toBeNull();
  }));
  it('reserves urgent capacity while a normal handler is still waiting', () => withTestDb(async (db) => {
    const a = await account(db), id = await app(db, a.ownerId);
    await handleSecuritySignal(db, signal({ kind: 'app', appId: id }, { source: 'cpu', severity: 'low' }));
    const trap = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }, { source: 'honeytoken' }));
    const result = await db.execute<{ name: string }>(sql`select current_database() as name`);
    const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform');
    url.pathname = `/${result[0]!.name}`;
    const client = postgres(url.toString(), { max: 2, onnotice: () => {} });
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pool = drizzle(client, { schema });
    const normal = drainSecurityOutbox(pool, { notify_operator: async () => { entered(); await waiting; } }, { queue: 'normal', limit: 1 });
    try {
      await started;
      const delivered: string[] = [];
      expect(await drainSecurityOutbox(pool, { notify_operator: async (_p, row) => { delivered.push(row.incidentId); } }, { queue: 'urgent', limit: 1 })).toEqual({ done: 1, failed: 0 });
      expect(delivered).toEqual([trap.incidentId]);
    } finally { release(); await normal; await client.end(); }
  }));
  it('rejects non-Tailscale operator destinations', () => {
    for (const adminOrigin of ['https://public.example', 'http://admin.example.ts.net', 'https://x.ts.net.evil.test', 'https://x.ts.net/path']) expect(() => notificationHandlers({} as never, { mailer: createFakeMailer(), emailKey: key, appOrigin: 'https://public.example', adminOrigin })).toThrow();
  });
});

describe('Task 9 recovery boundary', () => {
  it('allows authenticated appeals/logout through IP and account blocks, rejects strangers, bearer tokens and general changes', () => withTestDb(async (db) => {
    const a = await account(db), other = await account(db), id = await app(db, a.ownerId);
    const incident = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }));
    await handleSecuritySignal(db, signal({ kind: 'account', accountId: a.id }));
    const { hashIp } = await import('../src/security/ip.js');
    await handleSecuritySignal(db, signal({ kind: 'ip', ipHash: hashIp('203.0.113.4', key)! }));
    const session = await createSession(db, a.id, 'Test'), stranger = await createSession(db, other.id, 'Test');
    const api = createApp({ db, mailer: createFakeMailer(), security: { hashKey: key }, config: { emailEncKey: key, emailHashKey: key, appOrigin: 'https://public.example', rpId: 'public.example', adminEmail: 'admin@example.test' } });
    const request = (path: string, method = 'GET', token = session.token, body?: unknown) => api.request(path, { method, headers: { cookie: `sid=${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, { incoming: { socket: { remoteAddress: '203.0.113.4' } } });
    const list = await request('/security/incidents?locale=en');
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toMatch(/internal_rule|private_detector|ipHash|evidence/);
    expect((await request(`/security/incidents/${incident.incidentId}/appeals`, 'POST', session.token, { message: 'Please review' })).status).toBe(200);
    expect((await request(`/security/incidents/${incident.incidentId}/appeals`, 'POST', stranger.token, { message: 'other account' })).status).toBe(404);
    expect((await request('/security/incidents', 'GET', 'invalid')).status).toBe(401);
    expect((await request('/teams', 'POST', session.token, { name: 'bypass' })).status).toBe(403);
    expect((await request('/auth/email/start', 'POST', session.token, { email: a.email, purpose: 'login' })).status).toBe(403);
    expect((await request('/auth/logout', 'POST')).status).toBe(200);
  }));
  it('proves identity from a blocked IP without enabling registration or unauthenticated appeals', () => withTestDb(async (db) => {
    const a = await account(db);
    const { hashIp } = await import('../src/security/ip.js');
    const incident = await handleSecuritySignal(db, signal({ kind: 'account', accountId: a.id }));
    await handleSecuritySignal(db, signal({ kind: 'ip', ipHash: hashIp('203.0.113.5', key)! }));
    const mailer = createFakeMailer();
    const api = createApp({ db, mailer, security: { hashKey: key }, config: { emailEncKey: key, emailHashKey: key, appOrigin: 'https://public.example', rpId: 'public.example', adminEmail: 'admin@example.test' } });
    let cookie = '';
    const request = async (path: string, body?: unknown) => {
      const response = await api.request(path, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, { incoming: { socket: { remoteAddress: '203.0.113.5' } } });
      const did = /did=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
      const sid = /sid=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
      if (did) cookie = `did=${did}`;
      if (sid) cookie += `; sid=${sid}`;
      return response;
    };
    expect((await request(`/security/incidents/${incident.incidentId}/appeals`, { message: 'unauthenticated' })).status).toBe(401);
    const start = await request('/security/session/start', { email: a.email, locale: 'en', purpose: 'signup' });
    expect(start.status).toBe(200);
    const { challengeId } = await start.json() as { challengeId: string };
    expect((await request('/security/session/verify', { challengeId, code: 'wrong' })).status).toBe(400);
    expect((await request('/security/session/verify', { challengeId, code: mailer.lastCode() })).status).toBe(200);
    expect((await request('/security/incidents')).status).toBe(200);
    expect((await request(`/security/incidents/${incident.incidentId}/appeals`, { message: 'review' })).status).toBe(200);
    expect((await request('/auth/signup', { challengeId, code: mailer.lastCode() })).status).toBe(403);
    for (let i = 0; i < 4; i++) await request('/security/session/start', { email: `unknown${i}@example.test` });
    expect((await request('/security/session/start', { email: 'another@example.test' })).status).toBe(429);
  }));
  it('enforces persistent incident and daily limits, length, ownership, and denies direct RLS access', () => withTestDb(async (db) => {
    const a = await account(db), b = await account(db), id = await app(db, a.ownerId);
    const incident = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }));
    expect(await submitAppeal(db, b.id, incident.incidentId, 'no')).toBe('not_found');
    expect(await submitAppeal(db, a.id, incident.incidentId, 'x'.repeat(2001))).toBe('invalid');
    expect(await submitAppeal(db, a.id, incident.incidentId, '  ')).toBe('invalid');
    expect(await Promise.all(Array.from({ length: 4 }, () => submitAppeal(db, a.id, incident.incidentId, 'review', now)))).toEqual(['ok', 'ok', 'ok', 'rate_limited']);
    const second = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }));
    expect(await submitAppeal(db, a.id, second.incidentId, 'review', now)).toBe('ok');
    expect(await submitAppeal(db, a.id, second.incidentId, 'review', now)).toBe('ok');
    expect(await submitAppeal(db, a.id, second.incidentId, 'review', now)).toBe('rate_limited');
    await expect(withAccount(db, a.id, (tx) => tx.select().from(securityAppeals))).rejects.toThrow();
    await expect(withAccount(db, a.id, (tx) => tx.select().from(securityNotifications))).rejects.toThrow();
    expect(await userIncidents(db, b.id, 'en')).toHaveLength(0);
  }));
});

describe('Task 9 admin operations', () => {
  it('gates all routes, audits views, keeps same-code incidents independent and preserves manual/quota reasons', () => withTestDb(async (db) => {
    const a = await account(db), id = await app(db, a.ownerId), { call, op } = await admin(db);
    const first = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }));
    const second = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }));
    expect((await call('')).status).toBe(200);
    expect((await call(`/${first.incidentId}`)).status).toBe(200);
    expect((await call('', undefined, {}, { ip: '203.0.113.4' })).status).toBe(404);
    expect((await call('', undefined, {}, { cookie: false })).status).toBe(401);
    expect((await db.select().from(adminAuditLog)).map((r) => r.action)).toContain('security.view');
    await transitionUsageState(db, a.ownerId, 'manual_suspend');
    expect((await call(`/${first.incidentId}`, 'release')).status).toBe(200);
    expect(await isAppBlocked(db, id)).toBe(true);
    expect((await call(`/${second.incidentId}`, 'continue')).status).toBe(200);
    expect((await call(`/${second.incidentId}`, 'release')).status).toBe(200);
    expect(await isAppBlocked(db, id)).toBe(false);
    expect((await db.select().from(usageStates))[0]!.reasons).toContain('manual_suspend');
    const stopped: string[] = [];
    await drainSecurityOutbox(db, stopAppHandlers({ stop: async (id) => { stopped.push(id); } }), { now: new Date(Date.now() + 60_000) });
    expect(stopped).toHaveLength(0); // stale stops cannot interrupt the recovered application
    await db.update(operators).set({ role: 'reviewer' }).where(eq(operators.accountId, op.id));
    expect((await call(`/${first.incidentId}`, 'freeze')).status).toBe(403);
  }));
  it('freezes static/dynamic/team apps, incident release cannot unfreeze, and the 24-hour executor preserves other reasons', () => withTestDb(async (db) => {
    const a = await account(db), b = await account(db), { call, op, mailer } = await admin(db);
    const team = await createTeam(db, a.id, 'Team');
    const ids = [await app(db, a.ownerId), await app(db, a.ownerId, 'static'), await app(db, team.ownerId, 'static')];
    const unrelated = await app(db, b.ownerId, 'static');
    const incident = await handleSecuritySignal(db, signal({ kind: 'account', accountId: a.id }));
    expect(await isAppBlocked(db, ids[2]!)).toBe(true);
    expect((await call(`/${incident.incidentId}`, 'freeze')).status).toBe(200);
    expect((await call(`/${incident.incidentId}`, 'release')).status).toBe(200);
    expect(await blockedAppIds(db, [...ids, unrelated])).toEqual(new Set(ids));
    await transitionUsageState(db, a.ownerId, 'manual_block');
    await transitionUsageState(db, a.ownerId, 'manual_freeze');
    const booking = await scheduleDangerous(db, mailer, key, defaultDangerousHandlers, { accountId: op.id, role: 'owner', tailscaleLogin: op.email }, { action: 'unfreeze_security_account', target: a.ownerId }, now);
    expect(booking).not.toHaveProperty('error');
    expect(await runDueDangerous(db, defaultDangerousHandlers, new Date(now.getTime() + DANGEROUS_LEAD_MS - 1))).toBe(0);
    expect(await isAppBlocked(db, ids[1]!)).toBe(true);
    expect(await runDueDangerous(db, defaultDangerousHandlers, new Date(now.getTime() + DANGEROUS_LEAD_MS))).toBe(1);
    expect(await blockedAppIds(db, ids)).toEqual(new Set());
    const [state] = await db.select().from(usageStates).where(eq(usageStates.ownerId, a.ownerId));
    expect(state!.reasons).toContain('manual_block');
    expect(state!.reasons).toContain('manual_freeze');
    expect(state!.reasons).not.toContain('security_freeze');
  }));
  it('rolls back release when audit fails', () => withTestDb(async (db) => {
    const a = await account(db), id = await app(db, a.ownerId), { call } = await admin(db);
    const incident = await handleSecuritySignal(db, signal({ kind: 'app', appId: id }));
    await db.execute(sql`CREATE FUNCTION reject_admin_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_admin_write BEFORE INSERT ON admin_audit_log FOR EACH ROW EXECUTE FUNCTION reject_admin_write()`);
    expect((await call(`/${incident.incidentId}`, 'release')).status).toBe(500);
    expect(await isAppBlocked(db, id)).toBe(true);
    expect((await db.select().from(securityIncidents))[0]!.status).toBe('open');
  }));
  it('serializes concurrent account release and new incident across real connections', () => withTestDb(async (db) => {
    const a = await account(db), id = await app(db, a.ownerId), { call } = await admin(db);
    const incident = await handleSecuritySignal(db, signal({ kind: 'account', accountId: a.id }));
    const result = await db.execute<{ name: string }>(sql`select current_database() as name`);
    const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform');
    url.pathname = `/${result[0]!.name}`;
    const client = postgres(url.toString(), { max: 2, onnotice: () => {} });
    try {
      const other = drizzle(client, { schema });
      const [released] = await Promise.all([call(`/${incident.incidentId}`, 'release'), handleSecuritySignal(other, signal({ kind: 'account', accountId: a.id }))]);
      expect(released.status).toBe(200);
      expect(await isAppBlocked(db, id)).toBe(true);
      expect((await db.select().from(usageStates).where(eq(usageStates.ownerId, a.ownerId)))[0]!.reasons).toContain('security_block');
      expect((await db.select().from(securityBlocks)).filter((r) => !r.releasedAt)).toHaveLength(1);
    } finally { await client.end(); }
  }));
});
