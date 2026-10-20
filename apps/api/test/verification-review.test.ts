import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { endOfMarchJst } from 'shared';
import { encryptEmail } from '../src/crypto/email.js';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, studentVerifications, verificationUploads } from '../src/db/schema.js';
import { approveVerification, listPendingReviews, rejectVerification, type GrantStudent } from '../src/verification/review.js';
import { purgeVerifications } from '../src/verification/purge.js';
import type { IdBlobStore } from '../src/verification/blob-store.js';

const KEY = Buffer.alloc(32, 7);
const jst = (s: string) => new Date(`${s}+09:00`);

/** 暗号文の置き場の代わり（メモリ）。deleteFails で削除の失敗を再現する。 */
function memoryStore() {
  const blobs = new Map<string, { accountId: string; createdAt: Date; expiresAt: Date }>();
  const reviews: { uploadId: string; result: string; operatorId: string }[] = [];
  const state = { deleteFails: false };
  const store: IdBlobStore = {
    async finalizeReview(i) {
      if (state.deleteFails) throw new Error('boom');
      if (i.result === 'approved' && !blobs.has(i.uploadId)) throw new Error('ciphertext not found');
      reviews.push({ uploadId: i.uploadId, result: i.result, operatorId: i.operatorId });
      let n = 0;
      for (const id of i.deleteUploadIds) if (blobs.delete(id)) n++;
      return n;
    },
    async deleteBlobs(ids) {
      if (state.deleteFails) throw new Error('boom');
      let n = 0;
      for (const id of ids) if (blobs.delete(id)) n++;
      return n;
    },
    async listBlobs() {
      return [...blobs].map(([uploadId, b]) => ({ uploadId, ...b }));
    },
  };
  return { store, blobs, reviews, state };
}

async function seed(db: TestDb, mem: ReturnType<typeof memoryStore>, opts: { gradYear: number; submittedAt: Date; email?: string; locale?: string }) {
  const email = opts.email ?? 'student@example.com';
  const [a] = await db.insert(accounts).values({ emailHash: email, emailEnc: encryptEmail(email, KEY), displayName: 'n', locale: opts.locale ?? 'ja', adultFrom: '2030-01' }).returning();
  const [v] = await db.insert(studentVerifications).values({ accountId: a!.id, schoolName: '東京大学', schoolKind: 'university', expectedGraduationYear: opts.gradYear }).returning();
  const expiresAt = new Date(opts.submittedAt.getTime() + 7 * 86_400_000);
  const [u] = await db.insert(verificationUploads).values({
    verificationId: v!.id, tokenHash: `h-${v!.id}`, tokenExpiresAt: new Date(opts.submittedAt.getTime() + 600_000),
    tokenUsedAt: opts.submittedAt, blobRef: 'x', expiresAt,
  }).returning();
  mem.blobs.set(u!.id, { accountId: a!.id, createdAt: opts.submittedAt, expiresAt });
  return { a: a!, v: v!, u: u! };
}

const fixture = () => {
  const mem = memoryStore();
  const mailer = createFakeMailer();
  const granted: { accountId: string; validUntil: Date }[] = [];
  const grantStudent: GrantStudent = async (_tx, accountId, validUntil) => { granted.push({ accountId, validUntil }); };
  return { mem, mailer, granted, grantStudent, deps: (now: Date, extra: Partial<{ grantStudent: GrantStudent }> = {}) => ({ store: mem.store, grantStudent, mailer, emailKey: KEY, now, ...extra }) };
};
const row = async (db: TestDb, id: string) => (await db.select().from(studentVerifications).where(eq(studentVerifications.id, id)))[0]!;

describe('approve / reject', () => {
  it('approves: status, expiry 3/31, Student grant, ciphertext deleted, mail sent', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-02-10T12:00:00');
    const { a, v, u } = await seed(db, f.mem, { gradYear: 2028, submittedAt: now });
    const r = await approveVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false });
    expect(r).toEqual({ ok: { validUntil: endOfMarchJst(2027) } });
    const after = await row(db, v.id);
    expect(after).toMatchObject({ status: 'approved', validUntil: endOfMarchJst(2027) });
    expect(f.granted).toEqual([{ accountId: a.id, validUntil: endOfMarchJst(2027) }]);
    expect(f.mem.blobs.has(u.id)).toBe(false);
    expect(f.mem.reviews).toHaveLength(1);
    expect(f.mailer.sentTo('student@example.com')).toBe(1);
    expect(f.mailer.lastBodyTo('student@example.com')).toContain('2027-03-31');
    const [up] = await db.select().from(verificationUploads).where(eq(verificationUploads.id, u.id));
    expect(up!.blobRef).toBeNull();
  }));

  it('April onwards needs the new-fiscal-year confirmation; March judges the next year by graduation year', () => withTestDb(async (db) => {
    const f = fixture();
    const april = jst('2027-04-10T12:00:00');
    const s1 = await seed(db, f.mem, { gradYear: 2029, submittedAt: april, email: 'a@example.com' });
    expect(await approveVerification(db, f.deps(april), { verificationId: s1.v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false })).toEqual({ error: 'new_year_doc_required' });
    expect((await row(db, s1.v.id)).status).toBe('pending');
    expect(f.mem.blobs.has(s1.u.id)).toBe(true);
    const ok = await approveVerification(db, f.deps(april), { verificationId: s1.v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: true });
    expect(ok).toEqual({ ok: { validUntil: endOfMarchJst(2028) } });

    const march = jst('2027-03-10T12:00:00');
    const s2 = await seed(db, f.mem, { gradYear: 2027, submittedAt: march, email: 'b@example.com' });
    expect(await approveVerification(db, f.deps(march), { verificationId: s2.v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: true })).toEqual({ error: 'not_enrolled' });
    const s3 = await seed(db, f.mem, { gradYear: 2028, submittedAt: march, email: 'c@example.com' });
    expect(await approveVerification(db, f.deps(march), { verificationId: s3.v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false })).toEqual({ ok: { validUntil: endOfMarchJst(2028) } });
  }));

  it('is atomic: when the ciphertext cannot be deleted, nothing is approved, granted or mailed', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-02-10T12:00:00');
    const { v, u } = await seed(db, f.mem, { gradYear: 2028, submittedAt: now });
    f.mem.state.deleteFails = true;
    expect(await approveVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false })).toEqual({ error: 'delete_failed' });
    expect(await row(db, v.id)).toMatchObject({ status: 'pending', validUntil: null, reviewedAt: null });
    expect(f.mem.blobs.has(u.id)).toBe(true);
    expect(f.mailer.sentTo('student@example.com')).toBe(0);
    const [up] = await db.select().from(verificationUploads).where(eq(verificationUploads.id, u.id));
    expect(up!.blobRef).toBe('x');
  }));

  it('is atomic the other way: when the grant fails the ciphertext is kept and the verification stays pending', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-02-10T12:00:00');
    const { v, u } = await seed(db, f.mem, { gradYear: 2028, submittedAt: now });
    const failing: GrantStudent = async () => { throw new Error('grant failed'); };
    await expect(approveVerification(db, f.deps(now, { grantStudent: failing }), { verificationId: v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false })).rejects.toThrow('grant failed');
    expect((await row(db, v.id)).status).toBe('pending');
    expect(f.mem.blobs.has(u.id)).toBe(true);
  }));

  it('refuses a missing ciphertext, double decisions and unknown ids', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-02-10T12:00:00');
    const { v, u } = await seed(db, f.mem, { gradYear: 2028, submittedAt: now });
    f.mem.blobs.delete(u.id);
    expect(await approveVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false })).toEqual({ error: 'delete_failed' });
    f.mem.blobs.set(u.id, { accountId: 'x', createdAt: now, expiresAt: now });
    await approveVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false });
    expect(await approveVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false })).toEqual({ error: 'not_pending' });
    expect(await approveVerification(db, f.deps(now), { verificationId: crypto.randomUUID(), operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: false })).toEqual({ error: 'not_found' });
  }));

  it('rejects with a reason: ciphertext deleted, reason mailed, and the account can submit again', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-02-10T12:00:00');
    const { v, u } = await seed(db, f.mem, { gradYear: 2028, submittedAt: now, locale: 'en' });
    expect(await rejectVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), reason: ' ' })).toEqual({ error: 'reason_required' });
    expect(await rejectVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), reason: 'The photo is blurry' })).toEqual({ ok: true });
    expect(await row(db, v.id)).toMatchObject({ status: 'rejected', rejectReason: 'The photo is blurry' });
    expect(f.mem.blobs.has(u.id)).toBe(false);
    expect(f.mailer.lastBodyTo('student@example.com')).toContain('The photo is blurry');
    expect(f.granted).toHaveLength(0);
  }));

  it('does not reject when the deletion fails', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-02-10T12:00:00');
    const { v } = await seed(db, f.mem, { gradYear: 2028, submittedAt: now });
    f.mem.state.deleteFails = true;
    expect(await rejectVerification(db, f.deps(now), { verificationId: v.id, operatorId: crypto.randomUUID(), reason: 'blurry' })).toEqual({ error: 'delete_failed' });
    expect((await row(db, v.id)).status).toBe('pending');
  }));

  it('lists pending reviews with the eligibility preview', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-04-10T12:00:00');
    const { v } = await seed(db, f.mem, { gradYear: 2029, submittedAt: now });
    const list = await listPendingReviews(db, now);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ verificationId: v.id, eligibility: { enrolled: true, requiresNewFiscalYearDoc: true } });
  }));
});

describe('purgeVerifications', () => {
  it('expires submissions not reviewed within 7 days, deletes the ciphertext and asks for a resubmission', () => withTestDb(async (db) => {
    const f = fixture();
    const t0 = jst('2027-02-10T12:00:00');
    const old = await seed(db, f.mem, { gradYear: 2028, submittedAt: t0, email: 'old@example.com' });
    const fresh = await seed(db, f.mem, { gradYear: 2028, submittedAt: new Date(t0.getTime() + 6 * 86_400_000), email: 'fresh@example.com' });
    const now = new Date(t0.getTime() + 7 * 86_400_000 + 1000);
    const r = await purgeVerifications(db, { store: f.mem.store, mailer: f.mailer, emailKey: KEY }, now);
    expect(r.expired).toBe(1);
    expect((await row(db, old.v.id)).status).toBe('expired');
    expect((await row(db, fresh.v.id)).status).toBe('pending');
    expect(f.mem.blobs.has(old.u.id)).toBe(false);
    expect(f.mem.blobs.has(fresh.u.id)).toBe(true);
    expect(f.mailer.sentTo('old@example.com')).toBe(1);
    expect(f.mailer.sentTo('fresh@example.com')).toBe(0);
    // 2 回目は何もしない（メールも重複しない）
    await purgeVerifications(db, { store: f.mem.store, mailer: f.mailer, emailKey: KEY }, now);
    expect(f.mailer.sentTo('old@example.com')).toBe(1);
  }));

  it('keeps the submission pending (and retries later) when the deletion fails', () => withTestDb(async (db) => {
    const f = fixture();
    const t0 = jst('2027-02-10T12:00:00');
    const s = await seed(db, f.mem, { gradYear: 2028, submittedAt: t0 });
    const now = new Date(t0.getTime() + 8 * 86_400_000);
    f.mem.state.deleteFails = true;
    const spy = console.error;
    console.error = () => undefined;
    try { await expect(purgeVerifications(db, { store: f.mem.store, mailer: f.mailer, emailKey: KEY }, now)).rejects.toThrow(); } finally { console.error = spy; }
    expect((await row(db, s.v.id)).status).toBe('pending');
    f.mem.state.deleteFails = false;
    expect((await purgeVerifications(db, { store: f.mem.store, mailer: f.mailer, emailKey: KEY }, now)).expired).toBe(1);
  }));

  it('removes orphaned ciphertext: decided submissions, rows unknown to the main DB (after a grace period), self-expired blobs', () => withTestDb(async (db) => {
    const f = fixture();
    const t0 = jst('2027-02-10T12:00:00');
    const approved = await seed(db, f.mem, { gradYear: 2028, submittedAt: t0, email: 'ap@example.com' });
    await db.update(studentVerifications).set({ status: 'approved' }).where(eq(studentVerifications.id, approved.v.id));
    const rejected = await seed(db, f.mem, { gradYear: 2028, submittedAt: t0, email: 'rj@example.com' });
    await db.update(studentVerifications).set({ status: 'rejected' }).where(eq(studentVerifications.id, rejected.v.id));
    const live = await seed(db, f.mem, { gradYear: 2028, submittedAt: t0, email: 'lv@example.com' });
    const now = new Date(t0.getTime() + 86_400_000);
    f.mem.blobs.set(crypto.randomUUID(), { accountId: 'u', createdAt: new Date(now.getTime() - 3 * 3600_000), expiresAt: new Date(now.getTime() + 86_400_000) }); // unknown, old
    const fresh = crypto.randomUUID();
    f.mem.blobs.set(fresh, { accountId: 'u', createdAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() + 86_400_000) }); // unknown, just written
    const r = await purgeVerifications(db, { store: f.mem.store, mailer: f.mailer, emailKey: KEY }, now);
    expect(r.blobsDeleted).toBe(3);
    expect([...f.mem.blobs.keys()].sort()).toEqual([live.u.id, fresh].sort());
  }));

  it('drops upload-token rows that were never used', () => withTestDb(async (db) => {
    const f = fixture();
    const now = jst('2027-02-10T12:00:00');
    const { v } = await seed(db, f.mem, { gradYear: 2028, submittedAt: now });
    await db.insert(verificationUploads).values({ verificationId: v.id, tokenHash: 'unused', tokenExpiresAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() + 1000) });
    const r = await purgeVerifications(db, { store: f.mem.store, mailer: f.mailer, emailKey: KEY }, now);
    expect(r.staleUploads).toBe(1);
  }));
});
