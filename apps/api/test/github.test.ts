import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createStorage, JOBS, loadStorageConfig, type Storage } from 'platform';
import { makeTarGz } from '../../../packages/platform/test/ingest/helpers.js';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, deployments } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { deleteAppStorage, processDeployment } from '../src/ingest/publish.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createSession } from '../src/auth/sessions.js';
import { verifyWebhook } from '../src/github/webhook.js';
import type { GithubClient } from '../src/github/client.js';
import { loadConfig } from '../src/config.js';

const env = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
};
let storage: Storage;
beforeAll(async () => { storage = createStorage(loadStorageConfig(env)); await storage.ensureBuckets(); });
afterAll(() => storage.close());

const SECRET = 'whsec';
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const SHA = 'a'.repeat(40);

let n = 0;
async function setup(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `g${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  const { appId } = await createApp(db, a!.id, { name: `g-${randomUUID().slice(0, 8)}`, ownerId }) as { appId: string };
  return { accountId: a!.id, appId };
}

function harness(db: TestDb, overrides: Partial<GithubClient> = {}) {
  const jobs: { name: string; data: unknown }[] = [];
  const queue = { send: async (name: string, data: object) => { jobs.push({ name, data }); return 'j'; } };
  const downloads: { installationId: string; repo: string; sha: string }[] = [];
  const client: GithubClient = {
    verifyInstallation: async () => true,
    downloadTarball: async (installationId, repo, sha) => {
      downloads.push({ installationId, repo, sha });
      return Readable.from([makeTarGz([
        { path: `octo-site-${sha}/index.html`, data: Buffer.from('<h1>gh</h1>') },
        { path: `octo-site-${sha}/css/a.css`, data: Buffer.from('a{}') },
      ])]);
    },
    ...overrides,
  };
  const pending: Promise<unknown>[] = [];
  const app = createHttpApp({
    db, mailer: createFakeMailer(), storage, queue,
    config: { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'x@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' },
    github: { webhookSecret: SECRET, client, background: (p) => { pending.push(p); } },
  });
  const push = (payload: object, headers: Record<string, string> = {}, secret = SECRET) => {
    const body = JSON.stringify(payload);
    return app.request('/github/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sign(body, secret), ...headers } });
  };
  return { app, jobs, downloads, pending, push, client };
}
const payload = (o: Record<string, unknown> = {}) => ({
  ref: 'refs/heads/main', after: SHA, deleted: false, installation: { id: 42 }, repository: { full_name: 'octo/site' }, ...o,
});
const connect = (db: TestDb, appId: string) =>
  db.update(apps).set({ githubRepo: 'octo/site', githubBranch: 'main', githubInstallationId: '42' }).where(eq(apps.id, appId));

describe('github', () => {
  it('verifyWebhook: valid, wrong, missing, malformed signatures', async () => {
    const body = '{"a":1}';
    expect(await verifyWebhook(SECRET, body, sign(body))).toBe(true);
    expect(await verifyWebhook(SECRET, body, sign(body, 'other'))).toBe(false);
    expect(await verifyWebhook(SECRET, body, undefined)).toBe(false);
    expect(await verifyWebhook(SECRET, body, 'garbage')).toBe(false);
  });

  it('push on the tracked branch creates a github deployment with the commit sha; stripped tarball goes live', () => withTestDb(async (db) => {
    const { appId } = await setup(db);
    await connect(db, appId);
    const h = harness(db);
    const res = await h.push(payload());
    expect(res.status).toBe(202);
    await Promise.all(h.pending);
    expect(h.downloads).toEqual([{ installationId: '42', repo: 'octo/site', sha: SHA }]);
    const [d] = await db.select().from(deployments).where(eq(deployments.appId, appId));
    expect(d).toMatchObject({ source: 'github', status: 'queued', commitSha: SHA, createdBy: null, sourceKey: `${appId}/${d!.id}.tar.gz` });
    expect(h.jobs.at(-1)).toEqual({ name: JOBS.processDeployment, data: { deploymentId: d!.id } });
    await processDeployment(db, storage, d!.id);
    const live = (await db.select().from(deployments).where(eq(deployments.id, d!.id)))[0]!;
    expect(live).toMatchObject({ status: 'live', fileCount: 2 });
    expect(await text((await storage.sites.get(`${live.siteKey}index.html`))!.body)).toBe('<h1>gh</h1>');
    await deleteAppStorage(storage, appId);
  }));

  it('rejects missing/bad signatures with 401 and does nothing', () => withTestDb(async (db) => {
    const { appId } = await setup(db);
    await connect(db, appId);
    const h = harness(db);
    const body = JSON.stringify(payload());
    expect((await h.app.request('/github/webhook', { method: 'POST', body, headers: { 'x-github-event': 'push' } })).status).toBe(401);
    expect((await h.push(payload(), {}, 'wrong')).status).toBe(401);
    await Promise.all(h.pending);
    expect(h.downloads).toEqual([]);
    expect(await db.select().from(deployments)).toEqual([]);
  }));

  it('ignores other branches, deleted pushes, other repos/installations, other events (200)', () => withTestDb(async (db) => {
    const { appId } = await setup(db);
    await connect(db, appId);
    const h = harness(db);
    for (const p of [
      payload({ ref: 'refs/heads/dev' }), payload({ ref: 'refs/tags/main' }), payload({ deleted: true }),
      payload({ repository: { full_name: 'octo/other' } }), payload({ installation: { id: 7 } }),
    ]) expect((await h.push(p)).status).toBe(200);
    expect((await h.push(payload(), { 'x-github-event': 'ping' })).status).toBe(200);
    expect((await h.push(payload(), { 'x-github-event': 'issues' })).status).toBe(200);
    await Promise.all(h.pending);
    expect(h.downloads).toEqual([]);
    expect(await db.select().from(deployments)).toEqual([]);
  }));

  it('malformed signed payload is 400', () => withTestDb(async (db) => {
    const h = harness(db);
    const body = 'not json';
    const res = await h.app.request('/github/webhook', { method: 'POST', body, headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(body) } });
    expect(res.status).toBe(400);
  }));

  it('a failing tarball download for one app does not block others', () => withTestDb(async (db) => {
    const a = await setup(db);
    const b = await setup(db);
    await connect(db, a.appId);
    await connect(db, b.appId);
    let calls = 0;
    const h = harness(db, {
      downloadTarball: async (_i, _r, sha) => {
        if (calls++ === 0) throw new Error('boom');
        return Readable.from([makeTarGz([{ path: `octo-site-${sha}/index.html`, data: Buffer.from('x') }])]);
      },
    });
    expect((await h.push(payload())).status).toBe(202);
    await Promise.all(h.pending);
    expect(await db.select().from(deployments)).toHaveLength(1);
    await deleteAppStorage(storage, a.appId);
    await deleteAppStorage(storage, b.appId);
  }));

  it('PATCH /apps/:id/github validates, verifies the installation, needs deploy permission', () => withTestDb(async (db) => {
    const { accountId, appId } = await setup(db);
    const [o] = await db.insert(accounts).values({ emailHash: `g${n++}`, emailEnc: 'e', displayName: 'B', locale: 'ja', adultFrom: '2030-01' }).returning();
    const ck = `sid=${(await createSession(db, accountId, 'x')).token}`;
    const ok = `sid=${(await createSession(db, o!.id, 'x')).token}`;
    let valid = true;
    const h = harness(db, { verifyInstallation: async () => valid });
    const patch = (cookie: string | null, body: unknown) => h.app.request(`/apps/${appId}/github`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    });
    const good = { repo: 'octo/site', branch: 'main', installationId: '42' };
    expect((await patch(null, good)).status).toBe(401);
    expect((await patch(ok, good)).status).toBe(404);
    expect((await patch(ck, { ...good, repo: 'nope' })).status).toBe(400);
    expect((await patch(ck, { ...good, installationId: 'x' })).status).toBe(400);
    valid = false;
    expect((await patch(ck, good)).status).toBe(400);
    valid = true;
    expect((await patch(ck, { ...good, installationId: 42 })).status).toBe(200);
    expect((await db.select().from(apps).where(eq(apps.id, appId)))[0]).toMatchObject({ githubRepo: 'octo/site', githubBranch: 'main', githubInstallationId: '42' });
  }));

  it('routes are absent without github deps; config reads GitHub env only when complete', () => withTestDb(async (db) => {
    const app = createHttpApp({ db, mailer: createFakeMailer(), storage, queue: { send: async () => 'j' }, config: { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'x@example.com', appOrigin: 'https://a', rpId: 'a' } });
    expect((await app.request('/github/webhook', { method: 'POST', body: '{}' })).status).toBe(404);
    const base = { DATABASE_URL: 'x', EMAIL_ENC_KEY: Buffer.alloc(32).toString('base64'), EMAIL_HASH_KEY: Buffer.alloc(32).toString('base64'), APP_ORIGIN: 'x', SMTP_URL: 'x', ADMIN_EMAIL: 'x', RP_ID: 'x' };
    expect(loadConfig(base).github).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_APP_ID: '1' }).github).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'a\\nb', GITHUB_WEBHOOK_SECRET: 's' }).github).toEqual({ appId: '1', privateKey: 'a\nb', webhookSecret: 's' });
  }));
});
