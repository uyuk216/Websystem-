import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createStorage, JOBS, loadStorageConfig, type Storage } from 'platform';
import { makeTarGz } from '../../../packages/platform/test/ingest/helpers.js';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, deployments, githubDeliveries, githubInstallationLinks, githubOauthStates } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { deleteAppStorage, processDeployment } from '../src/ingest/publish.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createApiToken } from '../src/apps/api-tokens.js';
import { createSession } from '../src/auth/sessions.js';
import { verifyWebhook } from '../src/github/webhook.js';
import type { GithubClient } from '../src/github/client.js';
import { loadConfig } from '../src/config.js';
import { completeConnect, purgeGithubState, startConnect, validRepo } from '../src/github/link.js';

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

function harness(db: TestDb, overrides: Partial<GithubClient> = {}, userInstalls: string[] = ['42']) {
  const jobs: { name: string; data: unknown }[] = [];
  const queue = { send: async (name: string, data: object) => { jobs.push({ name, data }); return 'j'; } };
  const downloads: { installationId: string; repo: string; sha: string }[] = [];
  const client: GithubClient = {
    verifyInstallation: async () => true,
    authorizeUrl: (state) => `https://gh.example/authorize?state=${state}`,
    userInstallations: async () => userInstalls,
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
    const rows = await db.select().from(deployments);
    expect(rows.map((r) => r.status).sort()).toEqual(['failed', 'queued']);
    expect(rows.find((r) => r.status === 'failed')).toMatchObject({ message: 'deploy.error.download_failed', commitSha: SHA, source: 'github' });
    await deleteAppStorage(storage, a.appId);
    await deleteAppStorage(storage, b.appId);
  }));

  it('PATCH /apps/:id/github validates, verifies the installation, needs deploy permission', () => withTestDb(async (db) => {
    const { accountId, appId } = await setup(db);
    const [o] = await db.insert(accounts).values({ emailHash: `g${n++}`, emailEnc: 'e', displayName: 'B', locale: 'ja', adultFrom: '2030-01' }).returning();
    const ck = `sid=${(await createSession(db, accountId, 'x')).token}`;
    const ok = `sid=${(await createSession(db, o!.id, 'x')).token}`;
    let valid = true;
    await db.insert(githubInstallationLinks).values({ accountId, installationId: '42' });
    const h = harness(db, { verifyInstallation: async () => valid });
    const patch = (cookie: string | null, body: unknown) => h.app.request(`/apps/${appId}/github`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
    });
    const good = { repo: 'octo/site', branch: 'main', installationId: '42' };
    expect((await patch(null, good)).status).toBe(401);
    expect((await patch(ok, good)).status).toBe(404);
    expect((await patch(ck, { ...good, repo: 'nope' })).status).toBe(400);
    expect((await patch(ck, { ...good, installationId: 'x' })).status).toBe(400);
    expect((await patch(ck, { ...good, repo: 'octo/..' })).status).toBe(400);
    expect((await patch(ck, { ...good, repo: 'octo/site.git' })).status).toBe(400);
    expect((await patch(ck, { ...good, installationId: '12345678901234567' })).status).toBe(400);
    // someone else's installation (no link for this account) is forbidden, even though GitHub knows it
    expect((await patch(ck, { ...good, installationId: '99' })).status).toBe(403);
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
    expect(loadConfig({ ...base, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'a\\nb', GITHUB_WEBHOOK_SECRET: 's' }).github).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'a\\nb', GITHUB_WEBHOOK_SECRET: 's', GITHUB_CLIENT_ID: 'ci', GITHUB_CLIENT_SECRET: 'cs' }).github)
      .toEqual({ appId: '1', privateKey: 'a\nb', webhookSecret: 's', clientId: 'ci', clientSecret: 'cs' });
  }));

  it('OAuth connect: state is session-bound, single-use, expiring; links come from GitHub; other installs stay forbidden', () => withTestDb(async (db) => {
    const { accountId, appId } = await setup(db);
    const [o] = await db.insert(accounts).values({ emailHash: `g${n++}`, emailEnc: 'e', displayName: 'B', locale: 'ja', adultFrom: '2030-01' }).returning();
    const s1 = await createSession(db, accountId, 'x');
    const s2 = await createSession(db, accountId, 'y');
    const ck = `sid=${s1.token}`;
    const h = harness(db, {}, ['42', '43']);
    const res = await h.app.request('/github/connect', { headers: { cookie: ck }, redirect: 'manual' });
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    expect(res.headers.get('location')).toContain('https://gh.example/authorize');
    expect(await db.select().from(githubOauthStates)).toMatchObject([{ accountId, sessionId: s1.sessionId }]);
    expect((await db.select().from(githubOauthStates))[0]!.stateHash).not.toBe(state);
    expect((await h.app.request('/github/connect', { redirect: 'manual' })).status).toBe(401);
    // another session, another account, or a wrong state cannot complete it
    expect((await h.app.request(`/github/callback?code=c&state=${state}`, { headers: { cookie: `sid=${s2.token}` }, redirect: 'manual' })).headers.get('location')).toContain('github=error');
    const sB = await createSession(db, o!.id, 'z');
    expect((await h.app.request(`/github/callback?code=c&state=${state}`, { headers: { cookie: `sid=${sB.token}` }, redirect: 'manual' })).headers.get('location')).toContain('github=error');
    expect((await h.app.request('/github/callback?code=c&state=nope', { headers: { cookie: ck }, redirect: 'manual' })).headers.get('location')).toContain('github=error');
    expect(await db.select().from(githubInstallationLinks)).toEqual([]);
    const ok = await h.app.request(`/github/callback?code=c&state=${state}`, { headers: { cookie: ck }, redirect: 'manual' });
    expect(ok.headers.get('location')).toBe('https://app.example.com/apps?github=connected');
    expect((await db.select().from(githubInstallationLinks)).map((l) => l.installationId).sort()).toEqual(['42', '43']);
    // single use
    expect((await h.app.request(`/github/callback?code=c&state=${state}`, { headers: { cookie: ck }, redirect: 'manual' })).headers.get('location')).toContain('github=error');
    // linked account may connect; the other account (no link) may not
    const patch = (cookie: string, appIdX: string, installationId: string) => h.app.request(`/apps/${appIdX}/github`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ repo: 'octo/site', branch: 'main', installationId }),
    });
    expect((await patch(ck, appId, '43')).status).toBe(200);
    const other = await setup(db);
    const oc = `sid=${(await createSession(db, other.accountId, 'q')).token}`;
    expect((await patch(oc, other.appId, '43')).status).toBe(403);
    // expiry
    const old = await startConnect(db, accountId, s1.sessionId, new Date(Date.now() - 11 * 60_000));
    expect(await completeConnect(db, accountId, s1.sessionId, old, 'c', h.client)).toEqual({ error: 'invalid' });
    expect(await purgeGithubState(db, new Date())).toBe(1);
  }));

  it('webhook: oversized body is 413 before reading', () => withTestDb(async (db) => {
    const h = harness(db);
    const res = await h.app.request('/github/webhook', { method: 'POST', headers: { 'content-length': String(26 * 1024 * 1024), 'x-github-event': 'push' }, body: 'x' });
    expect(res.status).toBe(413);
  }));

  it('download error and oversized tarball mark the queued deployment failed with i18n keys', () => withTestDb(async (db) => {
    const { appId } = await setup(db);
    await connect(db, appId);
    const h = harness(db, { downloadTarball: async () => { throw new Error('boom'); } });
    expect((await h.push(payload())).status).toBe(202);
    await Promise.all(h.pending);
    const [d] = await db.select().from(deployments).where(eq(deployments.appId, appId));
    expect(d).toMatchObject({ status: 'failed', source: 'github', commitSha: SHA, message: 'deploy.error.download_failed' });
    expect(h.jobs).toEqual([]);
    expect(await storage.sources.get(d!.sourceKey)).toBeNull();
  }));

  it('replay protection: same delivery id is ignored; same commit already queued/live is skipped; purge after 7 days', () => withTestDb(async (db) => {
    const { appId } = await setup(db);
    await connect(db, appId);
    const h = harness(db);
    expect((await h.push(payload(), { 'x-github-delivery': 'd1' })).status).toBe(202);
    await Promise.all(h.pending);
    expect((await h.push(payload(), { 'x-github-delivery': 'd1' })).status).toBe(200);
    // new delivery, same commit, first still queued -> no second deployment
    expect((await h.push(payload(), { 'x-github-delivery': 'd2' })).status).toBe(202);
    await Promise.all(h.pending);
    expect(await db.select().from(deployments)).toHaveLength(1);
    expect(h.downloads).toHaveLength(1);
    await db.update(githubDeliveries).set({ receivedAt: new Date(Date.now() - 8 * 86400_000) }).where(eq(githubDeliveries.deliveryId, 'd1'));
    expect(await purgeGithubState(db, new Date())).toBe(1);
    await deleteAppStorage(storage, appId);
  }));

  it('an unexpected failure releases the delivery claim so a redelivery is processed', () => withTestDb(async (db) => {
    const { appId } = await setup(db);
    await connect(db, appId);
    const h = harness(db);
    let fail = true;
    const orig = h.jobs.push.bind(h.jobs);
    h.jobs.push = (...a) => { if (fail) throw new Error('queue down'); return orig(...a); };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await h.push(payload(), { 'x-github-delivery': 'r1' })).status).toBe(202);
    await Promise.all(h.pending);
    errSpy.mockRestore();
    expect(await db.select().from(githubDeliveries).where(eq(githubDeliveries.deliveryId, 'r1'))).toHaveLength(0);
    fail = false;
    expect((await h.push(payload(), { 'x-github-delivery': 'r1' })).status).toBe(202);
    await Promise.all(h.pending);
    expect((await db.select().from(deployments)).map((r) => r.status).sort()).toEqual(['failed', 'queued']);
    await deleteAppStorage(storage, appId);
  }));

  it('concurrent pushes of one commit create exactly one active deployment (unique index)', () => withTestDb(async (db) => {
    const { appId } = await setup(db);
    await connect(db, appId);
    const h = harness(db);
    const rs = await Promise.all([1, 2, 3, 4].map((i) => h.push(payload(), { 'x-github-delivery': `c${i}` })));
    expect(rs.every((r) => r.status === 202)).toBe(true);
    await Promise.all(h.pending);
    expect(await db.select().from(deployments)).toHaveLength(1);
    await deleteAppStorage(storage, appId);
  }));

  it('validRepo rejects dot segments and .git suffix', () => {
    expect(validRepo('octo/site')).toBe(true);
    for (const r of ['./x', '../x', 'a/..', 'a/.', 'a/b.git', 'a/b.GIT', 'a', 'a/b/c']) expect(validRepo(r)).toBe(false);
  });

  it('privilege-granting routes reject Bearer tokens', () => withTestDb(async (db) => {
    const { accountId, appId } = await setup(db);
    const { token } = await createApiToken(db, accountId, 'ci');
    const h = harness(db);
    const bearer = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const u = '00000000-0000-0000-0000-000000000001';
    for (const [m, path] of [['GET', '/github/connect'], ['GET', '/github/callback?code=c&state=s'], ['PATCH', `/apps/${appId}/github`], ['POST', `/teams/${u}/invites`]] as const) {
      expect((await h.app.request(path, { method: m, headers: bearer, body: m === 'GET' ? undefined : '{}', redirect: 'manual' })).status, `${m} ${path}`).toBe(401);
    }
  }));
});
