import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { withTestDb } from '../../api/test/helpers/db.js';
import { withPiiTestDb } from '../../../packages/platform/test/pii/helpers.js';
import { createIdBlobStore } from '../../../packages/platform/src/pii/store.js';
import { handleIdUpload } from '../../../packages/platform/src/pii/ingest.js';
import { generateRecipientKeyPair, encryptIdImage, serializeEnvelope, parseEnvelope, LocalKeyDecryptor } from '../../../packages/shared/src/idcrypt/index.js';
import { accounts, operators } from '../../api/src/db/schema.js';
import { encryptEmail } from '../../api/src/crypto/email.js';
import { createAdminApp } from '../../api/src/admin/server.js';
import { createAdminSession } from '../../api/src/admin/admin-session.js';
import { createFakeMailer } from '../../api/test/helpers/fake-mailer.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { startVerification, consumeUploadToken } from '../../api/src/verification/submissions.js';
import { resolveEntitlements } from '../../api/src/grants/entitlements.js';
import { createApp } from '../../api/src/apps/apps.js';
import { verifyAuditChain } from '../../api/src/admin/audit-log.js';

it('real encrypted intake → audited local decryption → reject/resubmit → approval deletes blobs and enables dynamic apps', () => withTestDb((db) => withPiiTestDb(async (pii) => {
  const key = Buffer.alloc(32, 1), mailer = createFakeMailer(), keys = await generateRecipientKeyPair();
  const [op, student] = await db.insert(accounts).values(['owner', 'student'].map((name) => ({ emailHash: randomUUID(), emailEnc: encryptEmail(`${name}@example.com`, key), displayName: name, locale: 'ja', adultFrom: '2030-01' }))).returning();
  await db.insert(operators).values({ accountId: op!.id, role: 'owner', tailscaleLogin: 'owner@tailnet' });
  const session = await createAdminSession(db, op!.id), ownerId = await ensureAccountOwner(db, student!.id);
  const app = createAdminApp({ db, mailer, emailEncKey: key, passkey: { rpId: 'localhost', appOrigin: 'http://localhost', emailEncKey: key }, tailscale: { required: true, devLoopback: false },
    review: { store: createIdBlobStore(pii.admin), async readCiphertext(uploadId, accountId) {
      const [r] = await pii.admin`select ciphertext from student_id_blobs where upload_id = ${uploadId} and account_id = ${accountId} and expires_at > now()`;
      return r ? r.ciphertext as Buffer : null;
    } },
  });
  const call = (path: string, body?: unknown) => app.request('/admin' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'tailscale-user-login': 'owner@tailnet', cookie: `asid=${session.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '100.100.1.2' } } });
  const image = new Uint8Array([255, 216, 255, 1, 2, 3]);
  async function submit() {
    const r = await startVerification(db, student!.id, { schoolName: 'University', schoolKind: 'university', expectedGraduationYear: new Date().getUTCFullYear() + 3 }, { network: { check: async () => ({ blocked: false }) }, ip: '127.0.0.1', uploadOrigin: 'http://localhost:5174', locale: 'ja' });
    if (!('ok' in r)) throw new Error(r.error);
    const token = new URL(r.ok.uploadUrl).searchParams.get('token')!;
    const envelope = await encryptIdImage({ image, recipientPublicKey: keys.publicKey, uploadId: r.ok.uploadId, accountId: student!.id });
    expect((await handleIdUpload({ sql: pii.ingest, consumeToken: (t) => consumeUploadToken(db, t) }, { token, contentType: 'application/octet-stream', body: serializeEnvelope(envelope) })).status).toBe(204);
    return r.ok;
  }
  expect((await createApp(db, student!.id, { ownerId, name: 'before-review', kind: 'dynamic' }))).toEqual({ error: 'plan_required' });
  const first = await submit();
  expect((await (await call('/reviews')).json()).reviews).toHaveLength(1);
  const encrypted = await (await call(`/reviews/${first.verificationId}/image`)).json();
  const plaintext = await new LocalKeyDecryptor(keys.secretKey).decrypt({ envelope: parseEnvelope(Buffer.from(encrypted.ciphertext, 'base64')), uploadId: encrypted.uploadId, accountId: encrypted.accountId });
  expect(plaintext).toEqual(image); plaintext.fill(0);
  expect((await call(`/reviews/${first.verificationId}/reject`, { reason: 'Resubmit a current document' })).status).toBe(200);
  expect(await pii.admin`select upload_id from student_id_blobs`).toHaveLength(0);
  const next = await submit();
  expect((await call(`/reviews/${next.verificationId}/approve`, { newFiscalYearDocConfirmed: true })).status).toBe(200);
  expect((await resolveEntitlements(db, ownerId)).plan).toBe('student');
  expect(await createApp(db, student!.id, { ownerId, name: `reviewed-${randomUUID().slice(0, 8)}`, kind: 'dynamic' })).toHaveProperty('appId');
  expect(await pii.admin`select upload_id from student_id_blobs`).toHaveLength(0);
  expect((await pii.admin`select result from verification_reviews order by reviewed_at`).map((r) => r.result)).toEqual(['rejected', 'approved']);
  expect((await db.$client`select action from admin_audit_log where action = 'reviews.image'`)).toHaveLength(1);
  expect(await verifyAuditChain(db)).toBeNull();
})));
