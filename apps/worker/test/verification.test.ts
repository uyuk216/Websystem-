/**
 * 本体 DB と個人情報 DB の両方を実物で使う結合テスト（apps/api のテストは個人情報 DB を知らないので、ここに置く）。
 * 要 dev:up（ys-pii-db と本体 Postgres）。
 */
import { describe, expect, it } from 'vitest';
import { createIdBlobStore, handleIdUpload, JOBS } from 'platform';
import { withTestDb } from '../../api/test/helpers/db.js';
import { createFakeMailer } from '../../api/test/helpers/fake-mailer.js';
import { withPiiTestDb } from '../../../packages/platform/test/pii/helpers.js';
import { accounts } from '../../api/src/db/schema.js';
import { encryptEmail } from '../../api/src/crypto/email.js';
import { consumeUploadToken, startVerification } from '../../api/src/verification/submissions.js';
import { approveVerification, rejectVerification } from '../../api/src/verification/review.js';
import { defaultHandlers } from '../src/worker.js';

const KEY = Buffer.alloc(32, 3);
const year = new Date().getUTCFullYear();
type MainDb = Parameters<Parameters<typeof withTestDb>[0]>[0];
const statusOf = async (db: MainDb, id: string) =>
  (await db.$client`SELECT status FROM student_verifications WHERE id = ${id}`)[0]!.status;
const envelope = (): Uint8Array => { const b = new Uint8Array(1300); b[0] = 1; b.fill(5, 1); return b; };

async function submit(db: MainDb, piiIngest: Parameters<typeof handleIdUpload>[0]['sql'], email: string) {
  const [a] = await db.insert(accounts).values({ emailHash: email, emailEnc: encryptEmail(email, KEY), displayName: 'n', locale: 'ja', adultFrom: '2030-01' }).returning();
  const started = await startVerification(db, a!.id, { schoolName: '東京大学', schoolKind: 'university', expectedGraduationYear: year + 3 },
    { network: { check: async () => ({ blocked: false }) } as never, ip: '203.0.113.5', uploadOrigin: 'https://upload.example.com', locale: 'ja' });
  if (!('ok' in started)) throw new Error('start failed');
  const token = new URL(started.ok.uploadUrl).searchParams.get('token')!;
  const res = await handleIdUpload({ sql: piiIngest, consumeToken: (t) => consumeUploadToken(db, t), log: () => undefined }, { token, contentType: 'application/octet-stream', body: envelope() });
  expect(res.status).toBe(204);
  return { account: a!, verificationId: started.ok.verificationId, uploadId: started.ok.uploadId };
}

describe('review across both databases', () => {
  it('approve deletes the real ciphertext and keeps only the review record', () => withTestDb((db) => withPiiTestDb(async (pii) => {
    const store = createIdBlobStore(pii.admin);
    const s = await submit(db, pii.ingest, 'ok@example.com');
    expect(await pii.admin`SELECT 1 FROM student_id_blobs`).toHaveLength(1);
    const mailer = createFakeMailer();
    const granted: string[] = [];
    const r = await approveVerification(db, { store, mailer, emailKey: KEY, grantStudent: async (_tx, id) => { granted.push(id); } },
      { verificationId: s.verificationId, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: true });
    expect('ok' in r).toBe(true);
    expect(await pii.admin`SELECT 1 FROM student_id_blobs`).toHaveLength(0);
    expect((await pii.admin`SELECT result FROM verification_reviews`).map((x) => x.result)).toEqual(['approved']);
    expect(granted).toEqual([s.account.id]);
    expect(mailer.sentTo('ok@example.com')).toBe(1);
  })));

  it('a failing deletion (revoked privilege) keeps the verification pending and the ciphertext in place', () => withTestDb((db) => withPiiTestDb(async (pii) => {
    const store = createIdBlobStore(pii.admin);
    const s = await submit(db, pii.ingest, 'fail@example.com');
    await pii.owner.unsafe('REVOKE DELETE ON student_id_blobs FROM pii_admin');
    const spy = console.error;
    console.error = () => undefined;
    let r;
    try {
      r = await approveVerification(db, { store, grantStudent: async () => undefined }, { verificationId: s.verificationId, operatorId: crypto.randomUUID(), newFiscalYearDocConfirmed: true });
    } finally { console.error = spy; }
    expect(r).toEqual({ error: 'delete_failed' });
    expect(await statusOf(db, s.verificationId)).toBe('pending');
    expect(await pii.admin`SELECT 1 FROM student_id_blobs`).toHaveLength(1);
    expect(await pii.admin`SELECT 1 FROM verification_reviews`).toHaveLength(0);
  })));

  it('reject deletes the ciphertext and the worker job removes orphans and expires stale submissions', () => withTestDb((db) => withPiiTestDb(async (pii) => {
    const store = createIdBlobStore(pii.admin);
    const mailer = createFakeMailer();
    const rej = await submit(db, pii.ingest, 'rej@example.com');
    expect('ok' in await rejectVerification(db, { store, grantStudent: async () => undefined }, { verificationId: rej.verificationId, operatorId: crypto.randomUUID(), reason: 'blurry' })).toBe(true);
    expect(await pii.admin`SELECT 1 FROM student_id_blobs`).toHaveLength(0);

    // 孤児: 差し戻し済みなのに暗号文が残っている状態を作る。
    await pii.ingest`INSERT INTO student_id_blobs (upload_id, account_id, ciphertext, size_bytes, expires_at)
                     VALUES (${rej.uploadId}, ${rej.account.id}, ${Buffer.from([1, 2])}, 2, now() + interval '7 days')`;
    // 期限切れ: 8 日前に提出されて審査されていない申請。
    const old = await submit(db, pii.ingest, 'old@example.com');
    const eightDays = new Date(Date.now() - 8 * 86_400_000);
    await db.$client`UPDATE verification_uploads SET expires_at = ${new Date(eightDays.getTime() + 7 * 86_400_000).toISOString()}::timestamptz WHERE id = ${old.uploadId}`;
    const live = await submit(db, pii.ingest, 'live@example.com');

    const handlers = defaultHandlers({ db, storage: {} as never, verification: { store, mailer, emailKey: KEY } });
    await handlers[JOBS.verificationPurge]({});
    const left = (await pii.admin`SELECT upload_id FROM student_id_blobs`).map((x) => x.upload_id);
    expect(left).toEqual([live.uploadId]);
    expect(await statusOf(db, old.verificationId)).toBe('expired');
    expect(mailer.sentTo('old@example.com')).toBe(1);
  })));
});

it('without a PII connection the purge job is a no-op', async () => {
  const handlers = defaultHandlers({ db: {} as never, storage: {} as never });
  const warn = console.warn;
  console.warn = () => undefined;
  try { await expect(handlers[JOBS.verificationPurge]({})).resolves.toBeUndefined(); } finally { console.warn = warn; }
});
