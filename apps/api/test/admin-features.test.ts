import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, adminAuditLog, operators, grants, starterApplications, eventBoosts, studentVerifications, verificationUploads, apps } from '../src/db/schema.js';
import { encryptEmail, hashEmail } from '../src/crypto/email.js';
import { createAdminApp, type AdminDeps } from '../src/admin/server.js';
import { createAdminSession } from '../src/admin/admin-session.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { resolveEntitlements } from '../src/grants/entitlements.js';
import { readUsageState } from '../src/usage/state.js';
import { verifyAuditChain } from '../src/admin/audit-log.js';

const KEY = Buffer.alloc(32, 1), HASH = Buffer.alloc(32, 2);
async function account(db: TestDb, email = `${randomUUID()}@example.com`) {
  const [a] = await db.insert(accounts).values({ emailHash: hashEmail(email, HASH), emailEnc: encryptEmail(email, KEY), displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  return { ...a!, email, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function setup(db: TestDb, extra: Partial<AdminDeps> = {}) {
  const op = await account(db), reviewer = await account(db), mailer = createFakeMailer();
  await db.insert(operators).values([{ accountId: op.id, role: 'owner', tailscaleLogin: 'owner@tailnet' }, { accountId: reviewer.id, role: 'reviewer', tailscaleLogin: 'review@tailnet' }]);
  const session = await createAdminSession(db, op.id), rs = await createAdminSession(db, reviewer.id);
  const app = createAdminApp({ db, mailer, emailEncKey: KEY, emailHashKey: HASH, passkey: { rpId: 'localhost', appOrigin: 'http://localhost', emailEncKey: KEY }, tailscale: { required: true, devLoopback: false }, ...extra });
  const call = (path: string, body?: unknown, role = 'owner', headers: Record<string, string> = {}) => app.request('/admin' + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'tailscale-user-login': role + '@tailnet', cookie: `asid=${role === 'owner' ? session.token : rs.token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }, { incoming: { socket: { remoteAddress: '100.100.1.2' } } });
  return { call, mailer, op, reviewer };
}

describe('Task 10 admin features', () => {
  it('exact email search does not reveal email until an audited display; role and origin enforcement', () => withTestDb(async (db) => {
    const { call } = await setup(db), a = await account(db, 'student@example.com');
    expect((await call('/accounts/search', { email: 'student' })).status).toBe(400);
    expect(await (await call('/accounts/search', { email: 'STUDENT@example.com' })).json()).toMatchObject({ accounts: [{ id: a.id, owners: [{ id: a.ownerId }] }] });
    expect(await (await call('/accounts/search', { email: 'other@example.com' })).json()).toEqual({ accounts: [] });
    expect((await call('/accounts/search', { email: a.email }, 'review')).status).toBe(403);
    expect((await call(`/accounts/${a.id}/email`, undefined, 'review')).status).toBe(403);
    expect(await (await call(`/accounts/${a.id}/email`)).json()).toEqual({ email: a.email });
    expect((await call('/accounts/search', { email: a.email }, 'owner', { origin: 'https://evil.example' })).status).toBe(403);
    const logs = await db.select().from(adminAuditLog);
    expect(logs.some((r) => r.action === 'accounts.email' && r.target === a.id)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(a.email);
    expect(await verifyAuditChain(db)).toBeNull();
  }));

  it('Student manual grant/revoke refreshes state; suspension and priority survive unrelated release; unfreeze cannot bypass booking', () => withTestDb(async (db) => {
    const stopped: string[] = [], { call } = await setup(db, { driver: { stop: async (id) => { stopped.push(id); } } }), a = await account(db);
    await db.insert(apps).values({ ownerId: a.ownerId, kind: 'dynamic', name: `adm-${randomUUID().slice(0, 8)}` });
    const grant = { accountId: a.id, validUntil: '2099-03-31T14:59:59Z', reason: 'manual review' };
    expect((await call('/grants/student', grant, 'review')).status).toBe(403);
    expect((await call('/grants/student', { ...grant, validUntil: 'garbage' })).status).toBe(400);
    expect((await call('/grants/student', grant)).status).toBe(200);
    expect((await resolveEntitlements(db, a.ownerId)).plan).toBe('student');
    for (const event of ['manual_suspend', 'manual_block', 'manual_freeze', 'manual_resume', 'manual_unblock']) expect((await call(`/accounts/${a.ownerId}/state`, { event })).status).toBe(200);
    expect(await readUsageState(db, a.ownerId)).toBe('frozen');
    expect(stopped.length).toBeGreaterThan(0);
    expect((await call(`/accounts/${a.ownerId}/state`, { event: 'manual_unfreeze' })).status).toBe(400);
    const [g] = await db.select().from(grants);
    expect((await call(`/grants/${g!.id}/revoke`, {})).status).toBe(200);
    expect((await resolveEntitlements(db, a.ownerId)).plan).toBe('none');
    expect(await readUsageState(db, a.ownerId)).toBe('frozen');
    expect(rows(await (await call('/grants')).json(), 'grants')[0]).toHaveProperty('revokedAt');
    expect(await verifyAuditChain(db)).toBeNull();
  }));

  it('audits each image read; approve grants Student and deletes ciphertext; rejects and accepts resubmission', () => withTestDb(async (db) => {
    const blobs = new Map<string, Uint8Array>();
    const store = {
      async finalizeReview(i: { deleteUploadIds: string[] }) { let n = 0; for (const id of i.deleteUploadIds) if (blobs.delete(id)) n++; return n; },
      async deleteBlobs() { return 0; }, async listBlobs() { return []; },
    };
    const { call } = await setup(db, { review: { store, readCiphertext: async (id) => blobs.get(id) ?? null } });
    const a = await account(db);
    const [v] = await db.insert(studentVerifications).values({ accountId: a.id, schoolName: 'University', schoolKind: 'university', expectedGraduationYear: 2099 }).returning();
    async function submit() {
      const [u] = await db.insert(verificationUploads).values({ verificationId: v!.id, tokenHash: randomUUID(), tokenExpiresAt: new Date(Date.now() + 60_000), tokenUsedAt: new Date(), expiresAt: new Date(Date.now() + 86400_000), blobRef: 'x' }).returning();
      blobs.set(u!.id, new Uint8Array([1, 2, 3])); return u!.id;
    }
    await submit();
    expect(rows(await (await call('/reviews', undefined, 'review')).json(), 'reviews')).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await call(`/reviews/${v!.id}/image`, undefined, 'review')).status).toBe(200);
    expect((await db.select().from(adminAuditLog).where(eq(adminAuditLog.action, 'reviews.image')))).toHaveLength(2);
    expect((await call(`/reviews/${v!.id}/reject`, { reason: 'Please resubmit' }, 'review')).status).toBe(200);
    expect(blobs.size).toBe(0);
    await db.update(studentVerifications).set({ status: 'pending' }).where(eq(studentVerifications.id, v!.id));
    await submit();
    expect((await call(`/reviews/${v!.id}/approve`, { newFiscalYearDocConfirmed: true }, 'review')).status).toBe(200);
    expect(blobs.size).toBe(0);
    expect((await resolveEntitlements(db, a.ownerId)).plan).toBe('student');
    expect((await call(`/reviews/${v!.id}/image`, undefined, 'review')).status).toBe(404);
    expect(await verifyAuditChain(db)).toBeNull();
  }));

  it('Starter and boost approvals use operator-supplied period/amounts; malformed bodies and reviewer writes are rejected', () => withTestDb(async (db) => {
    const { call } = await setup(db), a = await account(db);
    const [s] = await db.insert(starterApplications).values({ accountId: a.id, project: 'Project', githubLogin: 'octo', githubCreatedAt: new Date('2020-01-01'), introduction: 'Hello' }).returning();
    const end = new Date(Date.now() + 60 * 86400_000).toISOString();
    expect((await call(`/grants/starter/${s!.id}/approve`, { endsAt: end }, 'review')).status).toBe(403);
    expect((await call(`/grants/starter/${s!.id}/approve`, { endsAt: 'invalid' })).status).toBe(400);
    expect((await call(`/grants/starter/${s!.id}/approve`, { endsAt: end })).status).toBe(200);
    expect((await resolveEntitlements(db, a.ownerId)).plan).toBe('starter');
    const [app] = await db.insert(apps).values({ ownerId: a.ownerId, kind: 'dynamic', name: `boost-${randomUUID().slice(0, 8)}` }).returning();
    const start = new Date(Date.now() + 4 * 86400_000), endsAt = new Date(start.getTime() + 86400_000);
    const [b] = await db.insert(eventBoosts).values({ appId: app!.id, ownerId: a.ownerId, requestedBy: a.id, eventName: 'Event', startsAt: start, endsAt, expectedVisits: 200 }).returning();
    expect((await call(`/grants/boost/${b!.id}/approve`, { extraMemoryMb: '512' })).status).toBe(400);
    expect((await call(`/grants/boost/${b!.id}/approve`, { extraMemoryMb: 256, extraTransferBytes: 1024 })).status).toBe(200);
    const e = await resolveEntitlements(db, a.ownerId, start, { appId: app!.id });
    const base = await resolveEntitlements(db, a.ownerId, new Date(endsAt.getTime() + 1), { appId: app!.id });
    expect(e.dynamic.memoryMb - base.dynamic.memoryMb).toBe(256);
    expect(e.static.monthlyTransferBytes - base.static.monthlyTransferBytes).toBe(1024);
    expect(await verifyAuditChain(db)).toBeNull();
  }));

  it('failed audit prevents a mutation', () => withTestDb(async (db) => {
    const { call } = await setup(db), a = await account(db);
    await db.execute(sql`alter table admin_audit_log add constraint no_student check (action <> 'grants.student')`);
    expect((await call('/grants/student', { accountId: a.id, validUntil: '2099-03-31T14:59:59Z', reason: 'manual' })).status).toBe(500);
    expect(await db.select().from(grants)).toHaveLength(0);
  }));
});
function rows(data: unknown, key: string): Record<string, unknown>[] { return (data as Record<string, Record<string, unknown>[]>)[key]!; }
