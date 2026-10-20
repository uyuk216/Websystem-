import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { fakeAuthenticator, type FakeAuthenticator } from './helpers/fake-authenticator.js';
import { accounts, adminAuditLog, adminSessions, operators, platformSettings, scheduledDangerousActions } from '../src/db/schema.js';
import { encryptEmail, hashEmail } from '../src/crypto/email.js';
import { startPasskeyRegistration, finishPasskeyRegistration } from '../src/auth/passkeys.js';
import { withAccount } from '../src/db/client.js';
import { createApp } from '../src/http/app.js';
import { createAdminApp, defaultDangerousHandlers } from '../src/admin/server.js';
import { isTailscaleAddress, sourceAllowed } from '../src/admin/tailscale.js';
import { verifyAuditChain, withAdmin } from '../src/admin/audit-log.js';
import { runDueDangerous, DANGEROUS_LEAD_MS } from '../src/admin/dangerous.js';
import { loadConfig } from '../src/config.js';

const ADMIN_ORIGIN = 'https://admin.example.ts.net';
const pk = { rpId: 'example.ts.net', appOrigin: ADMIN_ORIGIN, emailEncKey: Buffer.alloc(32, 1) };
const HASH_KEY = Buffer.alloc(32, 2);
const TS_IP = '100.101.102.103';
const json = { 'content-type': 'application/json' };
// A fake socket: this is how the admin gate sees a "Tailscale" peer without Tailscale being installed.
const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });

async function mkAccount(db: TestDb, email: string) {
  const [a] = await db.insert(accounts).values({
    emailHash: hashEmail(email, HASH_KEY), emailEnc: encryptEmail(email, pk.emailEncKey), displayName: 'Op', locale: 'ja', adultFrom: '2030-01',
  }).returning();
  return a!;
}
async function mkOperator(db: TestDb, email: string, role: 'reviewer' | 'owner', opts: { active?: boolean } = {}) {
  const a = await mkAccount(db, email);
  const login = `${email.split('@')[0]}@tailnet.example`;
  await db.insert(operators).values({ accountId: a.id, tailscaleLogin: login, role, active: opts.active ?? true });
  const au = fakeAuthenticator({ rpId: pk.rpId, origin: ADMIN_ORIGIN });
  const s = await startPasskeyRegistration(db, a.id, pk);
  expect(await finishPasskeyRegistration(db, a.id, { challengeId: s.challengeId, response: au.register(s.options) as never }, pk)).toEqual({ ok: true });
  return { a, login, au, op: { accountId: a.id } };
}

function build(db: TestDb, extra: Partial<Parameters<typeof createAdminApp>[0]> = {}) {
  const mailer = createFakeMailer();
  const app = createAdminApp({ db, mailer, emailEncKey: pk.emailEncKey, passkey: pk, tailscale: { required: true, devLoopback: false }, ...extra });
  const call = (path: string, init: { method?: string; login?: string; ip?: string; cookie?: string; body?: unknown } = {}) => app.request(path, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined ? json : {}), ...(init.login ? { 'tailscale-user-login': init.login } : {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }, from(init.ip ?? TS_IP));
  return { app, call, mailer };
}

async function login(call: ReturnType<typeof build>['call'], op: { login: string; au: FakeAuthenticator }): Promise<string> {
  const start = await (await call('/admin/session/start', { method: 'POST', login: op.login, body: {} })).json() as { challengeId: string; options: { challenge: string } };
  const res = await call('/admin/session/finish', { method: 'POST', login: op.login, body: { challengeId: start.challengeId, response: op.au.assert(start.options) } });
  expect(res.status).toBe(200);
  return /asid=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
}

/** drizzle wraps driver errors; the Postgres message is on `cause`. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { const x = e as { message: string; cause?: { message?: string } }; return `${x.message} ${x.cause?.message ?? ''}`; }
  return '';
}

describe('tailscale source check', () => {
  it('accepts exactly 100.64.0.0/10 and fd7a:115c:a1e0::/48', () => {
    for (const ip of ['100.64.0.0', '100.100.1.1', '100.127.255.255', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12::5', '::ffff:100.64.1.1']) expect(isTailscaleAddress(ip), ip).toBe(true);
    for (const ip of ['100.63.255.255', '100.128.0.0', '10.0.0.1', '127.0.0.1', '192.168.1.1', '8.8.8.8', 'fd7a:115c:a1e1::1', 'fd7b:115c:a1e0::1', '::1', '::ffff:8.8.8.8', 'garbage', '', undefined]) expect(isTailscaleAddress(ip), String(ip)).toBe(false);
  });
  it('loopback counts only in dev mode', () => {
    expect(sourceAllowed('127.0.0.1', { required: true, devLoopback: false })).toBe(false);
    expect(sourceAllowed('127.0.0.1', { required: true, devLoopback: true })).toBe(true);
    expect(sourceAllowed('::1', { required: true, devLoopback: true })).toBe(true);
    expect(sourceAllowed('8.8.8.8', { required: true, devLoopback: true })).toBe(false);
  });
  it('production refuses the dev relaxations at startup', () => {
    const env = { DATABASE_URL: 'postgres://x', EMAIL_ENC_KEY: Buffer.alloc(32).toString('base64'), EMAIL_HASH_KEY: Buffer.alloc(32).toString('base64'), APP_ORIGIN: 'http://localhost', SMTP_URL: 'smtp://l', ADMIN_EMAIL: 'a@b.c', RP_ID: 'localhost' };
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', ADMIN_DEV_TAILSCALE: '1' })).toThrow();
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', ADMIN_TAILSCALE_REQUIRED: '0' })).toThrow();
    expect(loadConfig({ ...env, NODE_ENV: 'production' })).toMatchObject({ tailscaleRequired: true, adminDevTailscale: false, adminApiPort: 3002, adminBind: '127.0.0.1' });
    expect(loadConfig({ ...env, ADMIN_DEV_TAILSCALE: '1' })).toMatchObject({ adminDevTailscale: true });
  });
});

describe('admin gate (Review Focus 4)', () => {
  it('answers 404 without the header, from a non-Tailscale IP, for non-operators and inactive operators, and with no socket', () => withTestDb(async (db) => {
    const op = await mkOperator(db, 'owner1@x.y', 'owner');
    const off = await mkOperator(db, 'off1@x.y', 'reviewer', { active: false });
    await mkAccount(db, 'plain@x.y');
    const { call, app } = build(db);
    expect((await call('/admin/me')).status).toBe(404); // no header
    expect((await call('/admin/me', { login: op.login, ip: '203.0.113.9' })).status).toBe(404); // public IP
    expect((await call('/admin/me', { login: op.login, ip: '127.0.0.1' })).status).toBe(404); // loopback is not tailnet outside dev
    expect((await call('/admin/me', { login: 'plain@tailnet.example' })).status).toBe(404); // not an operator
    expect((await call('/admin/me', { login: off.login })).status).toBe(404); // deactivated
    expect((await call('/admin/session/start', { method: 'POST', login: 'nobody@tailnet.example', body: {} })).status).toBe(404);
    expect((await call('/nothing-here', { login: op.login })).status).toBe(404);
    // No socket at all (e.g. a request that bypassed the listener) is never a tailnet peer.
    expect((await app.request('/admin/me', { headers: { 'tailscale-user-login': op.login } })).status).toBe(404);
  }));

  it('a valid Tailscale operator without an elevated login gets 401, the header is case-insensitive, IPv6 tailnet works', () => withTestDb(async (db) => {
    const op = await mkOperator(db, 'owner2@x.y', 'owner');
    const { call } = build(db);
    expect((await call('/admin/me', { login: op.login })).status).toBe(401);
    expect((await call('/admin/audit', { login: op.login.toUpperCase() })).status).toBe(401);
    expect((await call('/admin/me', { login: op.login, ip: 'fd7a:115c:a1e0::7' })).status).toBe(401);
    expect((await call('/admin/me', { login: op.login, cookie: 'asid=forged' })).status).toBe(401);
  }));

  it('dev mode lets loopback in, but the header and operator are still required', () => withTestDb(async (db) => {
    const op = await mkOperator(db, 'owner3@x.y', 'owner');
    const { call } = build(db, { tailscale: { required: true, devLoopback: true } });
    expect((await call('/admin/me', { login: op.login, ip: '127.0.0.1' })).status).toBe(401);
    expect((await call('/admin/me', { ip: '127.0.0.1' })).status).toBe(404);
  }));

  it('the public app has no /admin routes and does not import the admin app', () => withTestDb(async (db) => {
    const op = await mkOperator(db, 'owner4@x.y', 'owner');
    const pub = createApp({ db, mailer: createFakeMailer(), config: { emailEncKey: pk.emailEncKey, emailHashKey: HASH_KEY, adminEmail: 'a@b.c', appOrigin: 'https://app.example.com', rpId: 'app.example.com' } });
    for (const [m, p] of [['GET', '/admin/me'], ['POST', '/admin/session/start'], ['GET', '/admin/audit'], ['GET', '/admin/audit/verify'], ['POST', '/admin/dangerous'], ['GET', '/admin']] as const) {
      const r = await pub.request(p, { method: m, headers: { 'tailscale-user-login': op.login } }, from(TS_IP));
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    const appSrc = readFileSync(fileURLToPath(new URL('../src/http/app.ts', import.meta.url)), 'utf8');
    expect(appSrc).not.toMatch(/from '\.\.\/admin\//);
    expect(appSrc).not.toMatch(/['"`]\/admin/);
  }));
});

describe('elevated login (passkey)', () => {
  it('logs in with the operator\'s own passkey; another account\'s passkey, an expired or revoked session, and a swapped header are 401', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner5@x.y', 'owner');
    const b = await mkOperator(db, 'rev5@x.y', 'reviewer');
    const { call } = build(db);
    // B's passkey presented under A's Tailscale identity.
    const start = await (await call('/admin/session/start', { method: 'POST', login: a.login, body: {} })).json() as { challengeId: string; options: { challenge: string; userVerification?: string } };
    expect(start.options.userVerification).toBe('required');
    const bad = await call('/admin/session/finish', { method: 'POST', login: a.login, body: { challengeId: start.challengeId, response: b.au.assert(start.options) } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();

    const tokenA = await login(call, a);
    const cookieA = `asid=${tokenA}`;
    const me = await call('/admin/me', { login: a.login, cookie: cookieA });
    expect(await me.json()).toEqual({ accountId: a.a.id, role: 'owner' });
    // The session belongs to A: B's Tailscale identity with A's cookie is refused.
    expect((await call('/admin/me', { login: b.login, cookie: cookieA })).status).toBe(401);

    // Only a hash is stored; lifetime is 30 minutes and is not extended by use.
    const [row] = await db.select().from(adminSessions);
    expect(JSON.stringify(row)).not.toContain(tokenA);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(30 * 60_000);
    await db.update(adminSessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await call('/admin/me', { login: a.login, cookie: cookieA })).status).toBe(401);

    const tokenA2 = await login(call, a);
    expect((await call('/admin/me', { login: a.login, cookie: `asid=${tokenA2}` })).status).toBe(200);
    expect((await call('/admin/session/logout', { method: 'POST', login: a.login, cookie: `asid=${tokenA2}`, body: {} })).status).toBe(200);
    expect((await call('/admin/me', { login: a.login, cookie: `asid=${tokenA2}` })).status).toBe(401);
  }));

  it('deactivating an operator ends an existing session immediately', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner6@x.y', 'owner');
    const { call } = build(db);
    const t = await login(call, a);
    await db.update(operators).set({ active: false });
    expect((await call('/admin/me', { login: a.login, cookie: `asid=${t}` })).status).toBe(404);
  }));

  it('login and logout are recorded', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner7@x.y', 'owner');
    const { call } = build(db);
    const t = await login(call, a);
    await call('/admin/session/logout', { method: 'POST', login: a.login, cookie: `asid=${t}`, body: {} });
    expect((await db.select().from(adminAuditLog).orderBy(adminAuditLog.seq)).map((r) => r.action)).toEqual(['session.login', 'session.logout']);
  }));
});

describe('audit log (Review Focus 5)', () => {
  it('rejects UPDATE, DELETE and TRUNCATE even for the owner role', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner8@x.y', 'owner');
    await withAdmin(db, a.op, { action: 'x.one', target: 't1' }, async () => undefined);
    expect(await pgError(db.update(adminAuditLog).set({ action: 'edited' }))).toMatch(/append-only/);
    expect(await pgError(db.delete(adminAuditLog))).toMatch(/append-only/);
    expect(await pgError(db.execute(sql`truncate admin_audit_log`))).toMatch(/append-only/);
    await expect(withAdmin(db, a.op, { action: 'x.two', target: 't' }, (tx) => tx.delete(adminAuditLog))).rejects.toThrow();
    expect(await db.select().from(adminAuditLog)).toHaveLength(1);
  }));

  it('chains every entry (seq, prev_hash, hash) and the verifier reports the first break', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner9@x.y', 'owner');
    expect(await verifyAuditChain(db)).toBeNull(); // empty log
    for (let i = 1; i <= 4; i++) await withAdmin(db, a.op, { action: 'x.step', target: `t${i}`, detail: { i } }, async () => undefined);
    const rows = await db.select().from(adminAuditLog).orderBy(adminAuditLog.seq);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.prevHash).toBe('0'.repeat(64));
    for (let i = 1; i < 4; i++) expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
    expect(new Set(rows.map((r) => r.hash)).size).toBe(4);
    expect(await verifyAuditChain(db)).toBeNull();

    // Tampering needs the triggers switched off (superuser); the chain still exposes it.
    const tamper = async (stmt: string) => {
      await db.execute(sql.raw('alter table admin_audit_log disable trigger admin_audit_no_update_delete'));
      await db.execute(sql.raw(stmt));
      await db.execute(sql.raw('alter table admin_audit_log enable trigger admin_audit_no_update_delete'));
    };
    await tamper(`update admin_audit_log set target = 'forged' where seq = 3`);
    expect(await verifyAuditChain(db)).toBe(3);
    await tamper(`update admin_audit_log set target = 't3' where seq = 3`);
    expect(await verifyAuditChain(db)).toBeNull();
    await tamper(`delete from admin_audit_log where seq = 2`);
    expect(await verifyAuditChain(db)).toBe(3); // the gap is where the chain breaks
  }));

  it('a recomputed row hash cannot hide an edit: the next row\'s prev_hash no longer matches', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner10@x.y', 'owner');
    for (let i = 1; i <= 3; i++) await withAdmin(db, a.op, { action: 'x.step', target: `t${i}` }, async () => undefined);
    await db.execute(sql.raw('alter table admin_audit_log disable trigger admin_audit_no_update_delete'));
    await db.execute(sql`update admin_audit_log set target = 'forged', hash = admin_audit_row_hash(seq, prev_hash, operator_id, action, 'forged', detail, created_at) where seq = 2`);
    await db.execute(sql.raw('alter table admin_audit_log enable trigger admin_audit_no_update_delete'));
    expect(await verifyAuditChain(db)).toBe(3);
  }));

  it('withAdmin records first and atomically: a failing operation leaves neither effect nor record; the record needs no cooperation from the operation', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner11@x.y', 'owner');
    await expect(withAdmin(db, a.op, { action: 'settings.try', target: 'k' }, async (tx) => {
      await tx.insert(platformSettings).values({ key: 'k', value: 1, updatedBy: a.a.id });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await db.select().from(adminAuditLog)).toHaveLength(0);
    expect(await db.select().from(platformSettings)).toHaveLength(0);
    await withAdmin(db, a.op, { action: 'settings.try', target: 'k' }, (tx) => tx.insert(platformSettings).values({ key: 'k', value: 1, updatedBy: a.a.id }));
    expect((await db.select().from(adminAuditLog)).map((r) => r.action)).toEqual(['settings.try']);
  }));

  it('the admin role cannot write without an operator context or under another operator\'s name; platform_api cannot read any admin table', () => withTestDb(async (db) => {
    const a = await mkOperator(db, 'owner12@x.y', 'owner');
    const b = await mkOperator(db, 'rev12@x.y', 'reviewer');
    const asAdmin = (opId: string | null, fn: (tx: never) => Promise<unknown>) => db.transaction(async (tx) => {
      await tx.execute(sql`set local role platform_admin`);
      if (opId) await tx.execute(sql`select set_config('app.operator_id', ${opId}, true)`);
      return fn(tx as never);
    });
    const ins = (opId: string, forOp: string) => (tx: { insert: typeof db.insert }) => tx.insert(adminAuditLog).values({ seq: 0, operatorId: forOp, action: 'sneak', target: 't' });
    await expect(asAdmin(null, ins('', a.a.id) as never)).rejects.toThrow();
    await expect(asAdmin(a.a.id, ins(a.a.id, b.a.id) as never)).rejects.toThrow(); // someone else's name
    await expect(asAdmin(null, ((tx: typeof db) => tx.insert(platformSettings).values({ key: 's', value: 1, updatedBy: a.a.id })) as never)).rejects.toThrow();
    await expect(asAdmin(a.a.id, ((tx: typeof db) => tx.insert(platformSettings).values({ key: 's', value: 1, updatedBy: b.a.id })) as never)).rejects.toThrow();
    await expect(asAdmin(a.a.id, ((tx: typeof db) => tx.select().from(adminSessions)) as never)).rejects.toThrow(); // sessions are owner-only
    await asAdmin(a.a.id, ins(a.a.id, a.a.id) as never); // the legitimate path works
    for (const t of [operators, adminSessions, adminAuditLog, platformSettings, scheduledDangerousActions]) {
      expect(await pgError(withAccount(db, a.a.id, (tx) => tx.select().from(t)))).toMatch(/permission denied/);
    }
    await expect(withAccount(db, a.a.id, (tx) => tx.insert(platformSettings).values({ key: 'z', value: 1, updatedBy: a.a.id }))).rejects.toThrow();
  }));

  it('settings changes keep the before and after values; reviewers cannot change settings', () => withTestDb(async (db) => {
    const owner = await mkOperator(db, 'owner13@x.y', 'owner');
    const rev = await mkOperator(db, 'rev13@x.y', 'reviewer');
    const { call } = build(db);
    const co = `asid=${await login(call, owner)}`;
    const cr = `asid=${await login(call, rev)}`;
    expect((await call('/admin/settings/limits.dynamic.appsPerOwner', { method: 'PUT', login: owner.login, cookie: co, body: { value: 2 } })).status).toBe(200);
    expect((await call('/admin/settings/limits.dynamic.appsPerOwner', { method: 'PUT', login: owner.login, cookie: co, body: { value: 3 } })).status).toBe(200);
    expect((await call('/admin/settings/limits.dynamic.appsPerOwner', { method: 'PUT', login: rev.login, cookie: cr, body: { value: 99 } })).status).toBe(403);
    expect((await call('/admin/settings/bad key', { method: 'PUT', login: owner.login, cookie: co, body: { value: 1 } })).status).toBe(400);
    const [s] = await db.select().from(platformSettings);
    expect(s!.value).toEqual(3);
    const changed = (await db.select().from(adminAuditLog).where(eq(adminAuditLog.action, 'settings.changed')).orderBy(adminAuditLog.seq)).map((r) => r.detail);
    expect(changed).toEqual([{ before: null, after: 2 }, { before: 2, after: 3 }]);
    // Unknown limit keys and non-numeric values are refused (they would silently do nothing).
    expect((await call('/admin/settings/limits.dynamic.nope', { method: 'PUT', login: owner.login, cookie: co, body: { value: 1 } })).status).toBe(400);
    expect((await call('/admin/settings/limits.dynamic.appsPerOwner', { method: 'PUT', login: owner.login, cookie: co, body: { value: -1 } })).status).toBe(400);
    // The HTTP API reports the chain as intact, and notices tampering.
    expect(await (await call('/admin/audit/verify', { login: owner.login, cookie: co })).json()).toEqual({ ok: true, firstBadSeq: null });
    const list = await (await call('/admin/audit?limit=3', { login: owner.login, cookie: co })).json() as { entries: unknown[] };
    expect(list.entries).toHaveLength(3);
    await db.execute(sql.raw('alter table admin_audit_log disable trigger admin_audit_no_update_delete'));
    await db.execute(sql`update admin_audit_log set action = 'forged' where seq = 1`);
    expect(await (await call('/admin/audit/verify', { login: owner.login, cookie: co })).json()).toEqual({ ok: false, firstBadSeq: 1 });
  }));

  it('viewing the log is itself recorded', () => withTestDb(async (db) => {
    const owner = await mkOperator(db, 'owner14@x.y', 'owner');
    const { call } = build(db);
    const co = `asid=${await login(call, owner)}`;
    await call('/admin/audit', { login: owner.login, cookie: co });
    expect((await db.select().from(adminAuditLog).orderBy(adminAuditLog.seq)).map((r) => r.action)).toEqual(['session.login', 'audit.view']);
  }));
});

describe('dangerous actions: 24-hour booking (example: unfreeze_account)', () => {
  it('books 24 h ahead, notifies owners, runs once when due, and can be cancelled', () => withTestDb(async (db) => {
    const owner = await mkOperator(db, 'owner15@x.y', 'owner');
    const owner2 = await mkOperator(db, 'owner16@x.y', 'owner');
    const rev = await mkOperator(db, 'rev15@x.y', 'reviewer');
    const { call, mailer } = build(db);
    const co = `asid=${await login(call, owner)}`;
    const cr = `asid=${await login(call, rev)}`;
    const victim = await mkAccount(db, 'victim@x.y');

    expect((await call('/admin/dangerous', { method: 'POST', login: rev.login, cookie: cr, body: { action: 'unfreeze_account', target: victim.id } })).status).toBe(403);
    expect((await call('/admin/dangerous', { method: 'POST', login: owner.login, cookie: co, body: { action: 'wipe_everything', target: 'all' } })).status).toBe(400);
    const before = Date.now();
    const res = await call('/admin/dangerous', { method: 'POST', login: owner.login, cookie: co, body: { action: 'unfreeze_account', target: victim.id } });
    expect(res.status).toBe(200);
    const out = await res.json() as { id: string; executeAfter: string };
    expect(new Date(out.executeAfter).getTime() - before).toBeGreaterThanOrEqual(DANGEROUS_LEAD_MS - 1000);
    expect(mailer.sentTo('owner15@x.y')).toBe(1);
    expect(mailer.sentTo('owner16@x.y')).toBe(1);
    expect(mailer.sentTo('rev15@x.y')).toBe(0);
    expect(mailer.lastBodyTo('owner15@x.y')).toContain('unfreeze_account');
    const [row] = await db.select().from(scheduledDangerousActions);
    expect(row).toMatchObject({ status: 'scheduled', requestedBy: owner.a.id });
    expect(row!.notifiedAt).not.toBeNull();

    // Not due yet: nothing happens, even if asked repeatedly.
    expect(await runDueDangerous(db, defaultDangerousHandlers, new Date(before + 23 * 3600_000))).toBe(0);
    expect(await db.select().from(platformSettings)).toHaveLength(0);
    // Due: runs exactly once.
    const due = new Date(before + DANGEROUS_LEAD_MS + 5000);
    expect(await runDueDangerous(db, defaultDangerousHandlers, due)).toBe(1);
    expect(await runDueDangerous(db, defaultDangerousHandlers, due)).toBe(0);
    expect((await db.select().from(platformSettings))[0]!.key).toBe(`account.unfrozen.${victim.id}`);
    expect((await db.select().from(scheduledDangerousActions))[0]!.status).toBe('executed');
    const actions = (await db.select().from(adminAuditLog)).map((r) => r.action);
    expect(actions).toContain('dangerous.schedule');
    expect(actions).toContain('dangerous.execute');

    // A cancelled booking never runs and the owners hear about it.
    const r2 = await (await call('/admin/dangerous', { method: 'POST', login: owner.login, cookie: co, body: { action: 'unfreeze_account', target: 'other' } })).json() as { id: string };
    mailer.clear();
    expect((await call(`/admin/dangerous/${r2.id}/cancel`, { method: 'POST', login: owner.login, cookie: co, body: {} })).status).toBe(200);
    expect((await call(`/admin/dangerous/${r2.id}/cancel`, { method: 'POST', login: owner.login, cookie: co, body: {} })).status).toBe(404);
    expect(mailer.sentTo('owner16@x.y')).toBe(1);
    expect(await runDueDangerous(db, defaultDangerousHandlers, new Date(Date.now() + 2 * DANGEROUS_LEAD_MS))).toBe(0);
    expect(owner2.a.id).toBeTruthy();
  }));

  it('a failing handler leaves the booking scheduled (no half-executed state)', () => withTestDb(async (db) => {
    const owner = await mkOperator(db, 'owner17@x.y', 'owner');
    const handlers = { unfreeze_account: async () => { throw new Error('nope'); } };
    const { call } = build(db, { handlers });
    const co = `asid=${await login(call, owner)}`;
    await call('/admin/dangerous', { method: 'POST', login: owner.login, cookie: co, body: { action: 'unfreeze_account', target: 'x' } });
    expect(await runDueDangerous(db, handlers, new Date(Date.now() + 2 * DANGEROUS_LEAD_MS))).toBe(0);
    expect((await db.select().from(scheduledDangerousActions))[0]!.status).toBe('scheduled');
  }));
});
