/** Test-only listeners and software authenticator. No test routes are loaded by production entrypoints. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { withTestDb } from '../../api/test/helpers/db.js';
import { withPiiTestDb } from '../../../packages/platform/test/pii/helpers.js';
import { createIdBlobStore } from '../../../packages/platform/src/pii/store.js';
import { handleIdUpload } from '../../../packages/platform/src/pii/ingest.js';
import { generateRecipientKeyPair } from '../../../packages/shared/src/idcrypt/index.js';
import { createAdminApp } from '../../api/src/admin/server.js';
import { getRequestListener } from '../../api/src/admin/listen.js';
import { createAdminShell } from '../src/server.js';
import { buildClientAssets } from '../../upload/src/client-build.js';
import { createUploadServer } from '../../upload/src/server.js';
import { accounts, operators, githubInstallationLinks } from '../../api/src/db/schema.js';
import { encryptEmail, hashEmail } from '../../api/src/crypto/email.js';
import { fakeAuthenticator } from '../../api/test/helpers/fake-authenticator.js';
import { startPasskeyRegistration, finishPasskeyRegistration } from '../../api/src/auth/passkeys.js';
import { createFakeMailer } from '../../api/test/helpers/fake-mailer.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { startVerification, consumeUploadToken } from '../../api/src/verification/submissions.js';
import { resolveEntitlements } from '../../api/src/grants/entitlements.js';
import { createApp } from '../../api/src/apps/apps.js';
import { applyStarter, sendStarterNotices } from '../../api/src/grants/starter.js';
import { requestEventBoost } from '../../api/src/grants/event-boost.js';

await withTestDb((db) => withPiiTestDb(async (pii) => {
  const key = Buffer.alloc(32, 1), hash = Buffer.alloc(32, 2), origin = 'http://127.0.0.1:5185';
  const pk = { rpId: '127.0.0.1', appOrigin: origin, emailEncKey: key };
  const mailer = createFakeMailer(), keys = await generateRecipientKeyPair();
  async function account(email: string) {
    const [a] = await db.insert(accounts).values({ emailHash: hashEmail(email, hash), emailEnc: encryptEmail(email, key), displayName: email.split('@')[0]!, locale: 'ja', adultFrom: '2030-01' }).returning();
    return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id), email };
  }
  const operator = await account('owner@example.com');
  await db.insert(operators).values({ accountId: operator.id, role: 'owner', tailscaleLogin: 'owner@tailnet' });
  const authenticator = fakeAuthenticator({ rpId: pk.rpId, origin });
  const reg = await startPasskeyRegistration(db, operator.id, pk);
  await finishPasskeyRegistration(db, operator.id, { challengeId: reg.challengeId, response: authenticator.register(reg.options) as never }, pk);
  const students = new Map<string, Awaited<ReturnType<typeof account>>>();
  const review = { store: createIdBlobStore(pii.admin), async readCiphertext(uploadId: string, accountId: string) {
    const [r] = await pii.admin`select ciphertext from student_id_blobs where upload_id = ${uploadId} and account_id = ${accountId} and expires_at > now()`;
    return r ? r.ciphertext as Buffer : null;
  } };
  const app = createAdminApp({ db, mailer, emailEncKey: key, emailHashKey: hash, passkey: pk, tailscale: { required: true, devLoopback: true }, secureCookie: false, review });
  const listener = getRequestListener(app.fetch), shell = createAdminShell();
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/admin/')) { void listener(req, res); return; }
    if (!req.url?.startsWith('/__test/')) { shell.emit('request', req, res); return; }
    void (async () => {
      const url = new URL(req.url!, origin);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      const b = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string> : {};
      let value: unknown;
      if (url.pathname === '/__test/assert') value = authenticator.assert({ challenge: b.challenge! });
      else if (url.pathname === '/__test/submit') {
        const id = b.id;
        const a = id ? students.get(id)! : await account(`${randomUUID()}@example.com`);
        students.set(a.id, a);
        const r = await startVerification(db, a.id, { schoolName: 'Test University', schoolKind: 'university', expectedGraduationYear: new Date().getUTCFullYear() + 3 }, { network: { check: async () => ({ blocked: false }) }, ip: '127.0.0.1', uploadOrigin: 'http://127.0.0.1:5186', locale: 'ja' });
        value = { ...a, ...r, secretKey: Buffer.from(keys.secretKey).toString('base64') };
      } else if (url.pathname === '/__test/check') {
        const a = students.get(b.id!)!;
        const plan = await resolveEntitlements(db, a.ownerId);
        value = { plan, blobs: (await pii.admin`select upload_id from student_id_blobs where account_id = ${a.id}`).length,
          created: b.create ? await createApp(db, a.id, { ownerId: a.ownerId, name: `e2e-${randomUUID().slice(0, 8)}`, kind: 'dynamic' }) : undefined };
      } else if (url.pathname === '/__test/starter') {
        const a = await account(`${randomUUID()}@example.com`); students.set(a.id, a);
        await db.insert(githubInstallationLinks).values({ accountId: a.id, installationId: randomUUID() });
        value = { ...a, ...await applyStarter(db, a.id, { project: 'E2E project', githubLogin: 'octo', introduction: 'Hello' }, { githubAge: { createdAt: async () => new Date('2020-01-01') } }) };
      } else if (url.pathname === '/__test/notices') {
        const now = new Date(Number(b.at));
        value = { sent: await sendStarterNotices(db, { now, mailer, emailKey: key }) };
      } else if (url.pathname === '/__test/boost') {
        const a = students.get(b.id!)!, created = await createApp(db, a.id, { ownerId: a.ownerId, name: `boost-${randomUUID().slice(0, 8)}`, kind: 'dynamic' });
        if ('error' in created) throw new Error(created.error);
        const start = new Date(Date.now() + 4 * 86400_000), end = new Date(start.getTime() + 86400_000);
        value = { appId: created.appId, start: start.toISOString(), end: end.toISOString(), ...await requestEventBoost(db, a.id, created.appId, { eventName: 'E2E event', startsAt: start.toISOString(), endsAt: end.toISOString(), expectedVisits: 100 }) };
      } else if (url.pathname === '/__test/limits') {
        const a = students.get(b.id!)!;
        value = await resolveEntitlements(db, a.ownerId, new Date(b.at!), { appId: b.appId });
      } else throw new Error('unknown fixture');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
    })().catch((e: unknown) => { console.error(e); res.writeHead(500).end('fixture failed'); });
  });
  const upload = createUploadServer({ assets: await buildClientAssets(), recipientPublicKeyB64: Buffer.from(keys.publicKey).toString('base64'), ingest: (input) => handleIdUpload({ sql: pii.ingest, consumeToken: (token) => consumeUploadToken(db, token), log: () => undefined }, input) });
  await new Promise<void>((r) => server.listen(5185, '127.0.0.1', r));
  await new Promise<void>((r) => upload.listen(5186, '127.0.0.1', r));
  await new Promise<void>((r) => { process.once('SIGTERM', r); process.once('SIGINT', r); });
  await Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => upload.close(() => r()))]);
}));
