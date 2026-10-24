import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { staticNetworkReputation } from 'shared';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, studentVerifications, verificationUploads } from '../src/db/schema.js';
import { createApp } from '../src/http/app.js';
import { createSession } from '../src/auth/sessions.js';
import { consumeUploadToken, startVerification } from '../src/verification/submissions.js';
import { hashUploadToken } from '../src/verification/upload-url.js';

const SECRET = 'test-ingest-secret-0123456789abcdef-xyz';
const cfg = {
  emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com',
  uploadOrigin: 'https://upload.example.com', ingestSharedSecret: SECRET,
};
const acct = (h: string) => ({ emailHash: h, emailEnc: 'e', displayName: 'n', locale: 'ja', adultFrom: '2030-01' });
const year = new Date().getUTCFullYear();
const body = { schoolName: '東京大学', schoolKind: 'university', expectedGraduationYear: year + 2 };
const json = { 'content-type': 'application/json' };

async function setup(db: TestDb, extra: Record<string, unknown> = {}, hash = 'a') {
  const [a] = await db.insert(accounts).values(acct(hash)).returning();
  const s = await createSession(db, a!.id, 'Mac');
  const app = createApp({ db, mailer: createFakeMailer(), config: cfg, ...extra } as never);
  return { a: a!, app, cookie: { cookie: `sid=${s.token}`, ...json } };
}
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

describe('POST /verification/start', () => {
  it('needs a login (cookie session, not an API token)', () => withTestDb(async (db) => {
    const { app } = await setup(db);
    expect((await app.request('/verification/start', { method: 'POST', headers: json, body: JSON.stringify(body) })).status).toBe(401);
  }));

  it('issues a one-shot token for the upload origin and stores only its hash and school details', () => withTestDb(async (db) => {
    const { app, cookie, a } = await setup(db);
    const res = await app.request('/verification/start?locale=en', { method: 'POST', headers: cookie, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const out = await res.json() as { uploadId: string; uploadUrl: string; expiresAt: string };
    const url = new URL(out.uploadUrl);
    expect(url.origin).toBe('https://upload.example.com');
    expect(url.pathname).toBe('/en/submit');
    const token = tokenOf(out.uploadUrl);
    expect(token.startsWith(`${out.uploadId}.${a.id}.`)).toBe(true);
    expect(new Date(out.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    const [v] = await db.select().from(studentVerifications);
    expect(v).toMatchObject({ accountId: a.id, status: 'pending', schoolName: '東京大学', schoolKind: 'university', expectedGraduationYear: year + 2, validUntil: null });
    const [u] = await db.select().from(verificationUploads);
    expect(u).toMatchObject({ id: out.uploadId, verificationId: v!.id, tokenHash: hashUploadToken(token), tokenUsedAt: null, blobRef: null });
    // The token itself is nowhere in the database.
    const dump = JSON.stringify([v, u]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.split('.')[2]!);
  }));

  it('reuses the pending verification on a second start and updates its details', () => withTestDb(async (db) => {
    const { app, cookie } = await setup(db);
    await app.request('/verification/start', { method: 'POST', headers: cookie, body: JSON.stringify(body) });
    await app.request('/verification/start', { method: 'POST', headers: cookie, body: JSON.stringify({ ...body, schoolName: '京都大学' }) });
    const vs = await db.select().from(studentVerifications);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.schoolName).toBe('京都大学');
    expect(await db.select().from(verificationUploads)).toHaveLength(2);
  }));

  it('rejects invalid school details', () => withTestDb(async (db) => {
    const { app, cookie } = await setup(db);
    for (const bad of [
      { ...body, schoolName: '' }, { ...body, schoolName: 'x'.repeat(101) }, { ...body, schoolKind: 'wizard' },
      { ...body, expectedGraduationYear: year - 5 }, { ...body, expectedGraduationYear: year + 50 }, { ...body, expectedGraduationYear: '2030' },
    ]) {
      const res = await app.request('/verification/start', { method: 'POST', headers: cookie, body: JSON.stringify(bad) });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await db.select().from(studentVerifications)).toHaveLength(0);
  }));

  it('answers 403 and creates nothing when the network is a VPN / Tor exit', () => withTestDb(async (db) => {
    for (const [reason, ip] of [['vpn', '203.0.113.7'], ['tor', '198.51.100.9']] as const) {
      const { app, cookie } = await setup(db, { network: staticNetworkReputation({ [ip]: reason }), trustedProxyHops: 1 }, ip);
      const res = await app.request('/verification/start', { method: 'POST', headers: { ...cookie, 'x-forwarded-for': ip }, body: JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'network_blocked' });
      expect(await db.select().from(studentVerifications)).toHaveLength(0);
      expect(await db.select().from(verificationUploads)).toHaveLength(0);
    }
  }));

  it('refuses a new submission while an approved verification is still valid', () => withTestDb(async (db) => {
    const { app, cookie, a } = await setup(db);
    await db.insert(studentVerifications).values({ accountId: a.id, status: 'approved', schoolName: 'S', schoolKind: 'university', expectedGraduationYear: year + 1, validUntil: new Date(Date.now() + 86_400_000) });
    const res = await app.request('/verification/start', { method: 'POST', headers: cookie, body: JSON.stringify(body) });
    expect(res.status).toBe(409);
  }));

  it('keeps no image-derived data: no binary column and no file-like column in either table', () => withTestDb(async (db) => {
    const cols = await db.execute<{ table_name: string; column_name: string; data_type: string }>(sql`
      select table_name, column_name, data_type from information_schema.columns where table_name in ('student_verifications', 'verification_uploads')`);
    expect(cols.length).toBeGreaterThan(10);
    expect(cols.filter((c) => c.data_type === 'bytea')).toEqual([]);
    expect(cols.map((c) => c.column_name).filter((n) => /image|ciphertext|envelope|exif|file|photo/i.test(n))).toEqual([]);
  }));
});

describe('one-shot submission tokens', () => {
  async function issue(db: TestDb, now?: Date) {
    const [a] = await db.insert(accounts).values(acct(`x${Math.random()}`)).returning();
    const r = await startVerification(db, a!.id, body, { network: { check: async () => ({ blocked: false }) }, ip: '1.1.1.1', uploadOrigin: 'https://u.example.com', locale: 'ja', now });
    if (!('ok' in r)) throw new Error('start failed');
    return { a: a!, ...r.ok, token: tokenOf(r.ok.uploadUrl) };
  }

  it('consumes once, returning the ids the token was issued for', () => withTestDb(async (db) => {
    const t = await issue(db);
    const first = await consumeUploadToken(db, t.token);
    expect(first).toMatchObject({ uploadId: t.uploadId, accountId: t.a.id });
    expect(first!.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(await consumeUploadToken(db, t.token)).toBeNull();
    const [u] = await db.select().from(verificationUploads).where(eq(verificationUploads.id, t.uploadId));
    expect(u!.tokenUsedAt).not.toBeNull();
  }));

  it('refuses an expired token (10 minutes)', () => withTestDb(async (db) => {
    const t = await issue(db);
    expect(await consumeUploadToken(db, t.token, new Date(Date.now() + 10 * 60_000 + 1000))).toBeNull();
    expect(await consumeUploadToken(db, t.token, new Date(Date.now() + 5 * 60_000))).not.toBeNull();
  }));

  it('refuses malformed tokens and a token whose ids were swapped for another upload', () => withTestDb(async (db) => {
    const t1 = await issue(db);
    const t2 = await issue(db);
    for (const bad of [undefined, null, 42, '', 'abc', `${t1.uploadId}.${t1.a.id}`, `${t1.token}x`]) expect(await consumeUploadToken(db, bad)).toBeNull();
    // Another upload's id with this token's secret never matches: the hash covers the whole string.
    const [, , secret1] = t1.token.split('.');
    expect(await consumeUploadToken(db, `${t2.uploadId}.${t2.a.id}.${secret1}`)).toBeNull();
    expect(await consumeUploadToken(db, t2.token)).toMatchObject({ uploadId: t2.uploadId, accountId: t2.a.id });
    // t1 is untouched by the failed attempts and still works exactly once.
    expect(await consumeUploadToken(db, t1.token)).toMatchObject({ uploadId: t1.uploadId });
  }));

  it('refuses once the verification is no longer pending', () => withTestDb(async (db) => {
    const t = await issue(db);
    await db.update(studentVerifications).set({ status: 'rejected' }).where(eq(studentVerifications.id, t.verificationId));
    expect(await consumeUploadToken(db, t.token)).toBeNull();
    const [u] = await db.select().from(verificationUploads);
    expect(u!.tokenUsedAt).toBeNull(); // rolled back
  }));
});

describe('POST /internal/verification/consume-token', () => {
  it('requires the shared secret and answers 404 without it', () => withTestDb(async (db) => {
    const { app, cookie } = await setup(db);
    const out = await (await app.request('/verification/start', { method: 'POST', headers: cookie, body: JSON.stringify(body) })).json() as { uploadUrl: string };
    const token = tokenOf(out.uploadUrl);
    const call = (headers: Record<string, string>) => app.request('/internal/verification/consume-token', { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ token }) });
    expect((await call({})).status).toBe(404);
    expect((await call({ 'x-ingest-secret': 'wrong' })).status).toBe(404);
    expect((await call({ cookie: cookie.cookie })).status).toBe(404); // a session is not a credential for the intake
    const ok = await call({ 'x-ingest-secret': SECRET });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ accountId: expect.any(String), uploadId: expect.any(String) });
    expect((await call({ 'x-ingest-secret': SECRET })).status).toBe(400); // already used
  }));

  it('does not exist when no secret is configured', () => withTestDb(async (db) => {
    const { app } = await setup(db, { config: { ...cfg, ingestSharedSecret: undefined } });
    const res = await app.request('/internal/verification/consume-token', { method: 'POST', headers: { ...json, 'x-ingest-secret': SECRET }, body: '{"token":"x"}' });
    expect(res.status).toBe(404);
  }));
});
