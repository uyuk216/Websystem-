import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createQueue, createStorage, JOBS, loadStorageConfig, startQueue, type Storage } from 'platform';
import { makeZip } from '../../../packages/platform/test/ingest/helpers.js';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, deployments, teamMembers } from '../src/db/schema.js';
import { createTeam, ensureAccountOwner } from '../src/teams/teams.js';
import { createApp, deleteApp, updateApp } from '../src/apps/apps.js';
import { createDeployment, listDeployments, rollback } from '../src/apps/deployments.js';
import { deleteAppStorage, processDeployment, sweepStaleDeployments } from '../src/ingest/publish.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createSession } from '../src/auth/sessions.js';

const env = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
};
let storage: Storage;
beforeAll(async () => { storage = createStorage(loadStorageConfig(env)); await storage.ensureBuckets(); });
afterAll(() => storage.close());

let n = 0;
async function acct(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `d${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
const queued: { name: string; data: { deploymentId: string } }[] = [];
const queue = { send: async (name: string, data: object) => { queued.push({ name, data: data as { deploymentId: string } }); return 'job'; } };
const zip = (files: Record<string, string>) => Readable.from([makeZip(Object.entries(files).map(([name, d]) => ({ name, data: Buffer.from(d) })))]);
const setup = async (db: TestDb, publishDir?: string) => {
  const a = await acct(db);
  const { appId } = await createApp(db, a.id, { name: `s-${randomUUID().slice(0, 8)}`, ownerId: a.ownerId, publishDir }) as { appId: string };
  return { a, appId };
};
const deploy = async (db: TestDb, a: { id: string }, appId: string, files: Record<string, string>) => {
  const r = await createDeployment(db, storage, queue, a.id, appId, { source: 'upload', archive: zip(files), format: 'zip' });
  if ('error' in r) throw new Error(r.error);
  return r.deploymentId;
};
const row = async (db: TestDb, id: string) => (await db.select().from(deployments).where(eq(deployments.id, id)))[0]!;
const active = async (db: TestDb, appId: string) => (await db.select().from(apps).where(eq(apps.id, appId)))[0]!.activeDeploymentId;
const cleanup = (appId: string) => deleteAppStorage(storage, appId);

describe('deployments', () => {
  it('queues, processes and goes live with index.html under siteKey', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const id = await deploy(db, a, appId, { 'index.html': '<h1>hi</h1>', 'css/a.css': 'a{}' });
    expect(queued.at(-1)).toEqual({ name: JOBS.processDeployment, data: { deploymentId: id } });
    expect((await row(db, id)).status).toBe('queued');
    expect((await row(db, id)).sourceKey).toBe(`${appId}/${id}.zip`);
    await processDeployment(db, storage, id);
    const d = await row(db, id);
    expect(d).toMatchObject({ status: 'live', fileCount: 2, siteKey: `${appId}/${id}/` });
    expect(await text((await storage.sites.get(`${d.siteKey}index.html`))!.body)).toBe('<h1>hi</h1>');
    expect(await active(db, appId)).toBe(id);
    expect((await listDeployments(db, a.id, appId)).map((x) => x.id)).toEqual([id]);
    await cleanup(appId);
  }));

  it('publishDir: only the folder contents are published; exclusions apply after resolving', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db, 'dist');
    const id = await deploy(db, a, appId, { 'index.html': 'root', 'dist/index.html': 'in', 'dist/.env': 'X=1', 'dist/node_modules/x.js': 'x', 'dist/sub/p.html': 'p' });
    await processDeployment(db, storage, id);
    const keys = (await storage.sites.list(`${appId}/${id}/`)).map((o) => o.key.slice(`${appId}/${id}/`.length)).sort();
    expect(keys).toEqual(['index.html', 'sub/p.html']);
    expect(await text((await storage.sites.get(`${appId}/${id}/index.html`))!.body)).toBe('in');
    await cleanup(appId);
  }));

  it('publishDir pointing at an excluded folder yields nothing (failed, not live)', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    await updateApp(db, a.id, appId, { publishDir: '.git' });
    const id = await deploy(db, a, appId, { '.git/config': 'x', 'index.html': 'i' });
    await processDeployment(db, storage, id);
    expect(await row(db, id)).toMatchObject({ status: 'failed', message: 'deploy.error.empty' });
    expect(await storage.sites.list(`${appId}/`)).toEqual([]);
    expect(await active(db, appId)).toBeNull();
    await cleanup(appId);
  }));

  it('secrets: blocked_secret, nothing published, live site unchanged, findings hold no values', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const first = await deploy(db, a, appId, { 'index.html': 'v1' });
    await processDeployment(db, storage, first);
    const bad = await deploy(db, a, appId, { 'index.html': 'v2', 'app.js': 'const k = "AKIAABCDEFGHIJKLMNOP";' });
    await processDeployment(db, storage, bad);
    const d = await row(db, bad);
    expect(d.status).toBe('blocked_secret');
    expect(d.message).toBe('deploy.blockedSecret');
    expect(d.findings).toEqual([{ path: 'app.js', line: 1, rule: expect.any(String) }]);
    expect(JSON.stringify(d.findings)).not.toContain('AKIA');
    expect(await storage.sites.list(`${appId}/${bad}/`)).toEqual([]);
    expect(await active(db, appId)).toBe(first);
    expect((await row(db, first)).status).toBe('live');
    await cleanup(appId);
  }));

  it('executables: held_for_review, not published', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const id = await deploy(db, a, appId, { 'index.html': 'i', 'setup.exe': 'MZ' });
    await processDeployment(db, storage, id);
    expect(await row(db, id)).toMatchObject({ status: 'held_for_review', message: 'deploy.heldForReview' });
    expect(await active(db, appId)).toBeNull();
    expect(await storage.sites.list(`${appId}/`)).toEqual([]);
    await cleanup(appId);
  }));

  it('corrupt archive fails with a message key', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const r = await createDeployment(db, storage, queue, a.id, appId, { source: 'upload', archive: Readable.from([Buffer.from('not a zip')]), format: 'zip' });
    const id = (r as { deploymentId: string }).deploymentId;
    await processDeployment(db, storage, id);
    expect(await row(db, id)).toMatchObject({ status: 'failed', message: 'deploy.error.corrupt' });
    await cleanup(appId);
  }));

  it('Review Focus 3: a newer deployment that finished first is not overwritten by an older one finishing late', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const older = await deploy(db, a, appId, { 'index.html': 'old' });
    const newer = await deploy(db, a, appId, { 'index.html': 'new' });
    await db.update(deployments).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(deployments.id, older));
    await processDeployment(db, storage, newer);
    await processDeployment(db, storage, older);
    expect(await active(db, appId)).toBe(newer);
    expect((await row(db, newer)).status).toBe('live');
    expect((await row(db, older)).status).toBe('superseded');
    // site files of the older one stay stored (rollback target)
    expect((await row(db, older)).siteKey).toBe(`${appId}/${older}/`);
    await cleanup(appId);
  }));

  it('concurrent processing of two deployments leaves exactly one live: the newest', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const older = await deploy(db, a, appId, { 'index.html': 'old' });
    const newer = await deploy(db, a, appId, { 'index.html': 'new' });
    await db.update(deployments).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(deployments.id, older));
    await Promise.all([processDeployment(db, storage, older), processDeployment(db, storage, newer)]);
    expect(await active(db, appId)).toBe(newer);
    const live = await db.select().from(deployments).where(and(eq(deployments.appId, appId), eq(deployments.status, 'live')));
    expect(live.map((x) => x.id)).toEqual([newer]);
    await cleanup(appId);
  }));

  it('rollback: only to past live/superseded, switches active, needs deploy permission', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const d1 = await deploy(db, a, appId, { 'index.html': '1' });
    await processDeployment(db, storage, d1);
    const d2 = await deploy(db, a, appId, { 'index.html': '2' });
    await processDeployment(db, storage, d2);
    const bad = await deploy(db, a, appId, { 'index.html': '3', 'x.sh': '#!' });
    await processDeployment(db, storage, bad);
    expect((await row(db, d1)).status).toBe('superseded');
    expect(await rollback(db, a.id, appId, bad)).toEqual({ error: 'invalid_state' });
    expect(await rollback(db, a.id, appId, randomUUID())).toEqual({ error: 'not_found' });
    const b = await acct(db);
    expect(await rollback(db, b.id, appId, d1)).toEqual({ error: 'not_found' });
    expect(await rollback(db, a.id, appId, d1)).toEqual({ ok: true });
    expect(await active(db, appId)).toBe(d1);
    expect((await row(db, d1)).status).toBe('live');
    expect((await row(db, d2)).status).toBe('superseded');
    await cleanup(appId);
  }));

  it('rollback to a commit whose newer deployment is queued/processing supersedes that one', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const sha = 'c'.repeat(40);
    const d1 = await deploy(db, a, appId, { 'index.html': '1' });
    await db.update(deployments).set({ commitSha: sha }).where(eq(deployments.id, d1));
    await processDeployment(db, storage, d1);
    const d2 = await deploy(db, a, appId, { 'index.html': '2' });
    await processDeployment(db, storage, d2);
    const d3 = await deploy(db, a, appId, { 'index.html': '3' });
    await db.update(deployments).set({ commitSha: sha }).where(eq(deployments.id, d3));
    expect(await rollback(db, a.id, appId, d1)).toEqual({ ok: true });
    expect(await active(db, appId)).toBe(d1);
    expect((await row(db, d1)).status).toBe('live');
    expect((await row(db, d3)).status).toBe('superseded');
    await processDeployment(db, storage, d3); // its job now no-ops
    expect((await row(db, d3)).status).toBe('superseded');
    expect(await active(db, appId)).toBe(d1);
    await cleanup(appId);
  }));

  it('sweep fails stale queued deployments without a pending job', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const o = (db.$client as unknown as { options: { host: string[]; port: number[]; user: string; pass: string; database: string } }).options;
    const boss = await startQueue(createQueue(`postgres://${o.user}:${o.pass}@${o.host[0]}:${o.port[0]}/${o.database}`));
    try {
      const old = await deploy(db, a, appId, { 'index.html': '1' });
      const withJob = await deploy(db, a, appId, { 'index.html': '2' });
      const fresh = await deploy(db, a, appId, { 'index.html': '3' });
      const ago = new Date(Date.now() - 20 * 60_000);
      await db.update(deployments).set({ createdAt: ago }).where(eq(deployments.id, old));
      await db.update(deployments).set({ createdAt: ago }).where(eq(deployments.id, withJob));
      await boss.send(JOBS.processDeployment, { deploymentId: withJob });
      expect(await sweepStaleDeployments(db)).toBe(1);
      expect(await row(db, old)).toMatchObject({ status: 'failed', message: 'deploy.error.stale' });
      expect((await row(db, withJob)).status).toBe('queued');
      expect((await row(db, fresh)).status).toBe('queued');
      expect(await sweepStaleDeployments(db)).toBe(0);
    } finally {
      await boss.stop({ graceful: false });
    }
    await cleanup(appId);
  }), 30000);

  it('cannot deploy to someone else\'s app; team members can, outsiders cannot', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const b = await acct(db);
    const r = await createDeployment(db, storage, queue, b.id, appId, { source: 'upload', archive: zip({ 'index.html': 'x' }), format: 'zip' });
    expect(r).toEqual({ error: 'not_found' });
    expect(await storage.sources.list(`${appId}/`)).toEqual([]);
    // Team: every member holds `deploy` (member role included); non-members cannot see the app.
    const owner = await acct(db);
    const member = await acct(db);
    const outsider = await acct(db);
    const { teamId, ownerId } = await createTeam(db, owner.id, 't');
    await db.insert(teamMembers).values({ teamId, accountId: member.id, role: 'member' });
    const { appId: tApp } = await createApp(db, owner.id, { name: `t-${randomUUID().slice(0, 8)}`, ownerId }) as { appId: string };
    expect(await createDeployment(db, storage, queue, outsider.id, tApp, { source: 'upload', archive: zip({ 'index.html': 'x' }), format: 'zip' })).toEqual({ error: 'not_found' });
    const d = await deploy(db, member, tApp, { 'index.html': 'x' });
    await processDeployment(db, storage, d);
    expect(await rollback(db, outsider.id, tApp, d)).toEqual({ error: 'not_found' });
    expect(await rollback(db, member.id, tApp, d)).toEqual({ ok: true });
    expect(await listDeployments(db, outsider.id, tApp)).toEqual([]);
    expect(await listDeployments(db, member.id, tApp)).toHaveLength(1);
    await cleanup(tApp); await cleanup(appId); void a;
  }));

  it('oversized archive is rejected with too_large and nothing is stored', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    // A 1 MB cap instead of the real one keeps this fast; the cap logic is the same.
    const big = Readable.from((async function* () { for (let i = 0; i < 4; i++) yield Buffer.alloc(512 * 1024); })());
    const r = await createDeployment(db, storage, queue, a.id, appId, { source: 'upload', archive: big, format: 'zip', maxBytes: 1024 * 1024 });
    expect(r).toEqual({ error: 'too_large' });
    expect(await storage.sources.list(`${appId}/`)).toEqual([]);
    expect(await db.select().from(deployments)).toEqual([]);
  }));

  it('deleteApp cleanup removes sources and sites', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const id = await deploy(db, a, appId, { 'index.html': 'x' });
    await processDeployment(db, storage, id);
    expect(await storage.sources.list(`${appId}/`)).not.toEqual([]);
    await deleteApp(db, a.id, appId, { enqueueStorageCleanup: (x) => deleteAppStorage(storage, x) });
    expect(await storage.sources.list(`${appId}/`)).toEqual([]);
    expect(await storage.sites.list(`${appId}/`)).toEqual([]);
  }));

  it('HTTP: multipart upload, list, rollback; .zip only; 413 for oversize; DELETE enqueues cleanup', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const b = await acct(db);
    const jobs: { name: string; data: unknown }[] = [];
    const q = { send: async (name: string, data: object) => { jobs.push({ name, data }); return 'j'; } };
    const app = createHttpApp({ db, mailer: createFakeMailer(), storage, queue: q, config: { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'x@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' } });
    const ck = `sid=${(await createSession(db, a.id, 'x')).token}`;
    const bk = `sid=${(await createSession(db, b.id, 'x')).token}`;
    const form = (name: string, data: Buffer, field = 'file') => { const f = new FormData(); f.append(field, new Blob([new Uint8Array(data)]), name); return f; };
    const z = makeZip([{ name: 'index.html', data: Buffer.from('hi') }]);
    expect((await app.request(`/apps/${appId}/deployments`, { method: 'POST', body: form('s.zip', z) })).status).toBe(401);
    expect((await app.request(`/apps/${appId}/deployments`, { method: 'POST', headers: { cookie: bk }, body: form('s.zip', z) })).status).toBe(404);
    expect((await app.request(`/apps/${appId}/deployments`, { method: 'POST', headers: { cookie: ck }, body: form('s.tar.gz', z) })).status).toBe(400);
    expect((await app.request(`/apps/${appId}/deployments`, { method: 'POST', headers: { cookie: ck }, body: form('s.zip', z, 'other') })).status).toBe(400);
    const res = await app.request(`/apps/${appId}/deployments`, { method: 'POST', headers: { cookie: ck }, body: form('s.zip', z) });
    expect(res.status).toBe(201);
    const { deploymentId } = await res.json() as { deploymentId: string };
    expect(jobs.at(-1)).toEqual({ name: JOBS.processDeployment, data: { deploymentId } });
    await processDeployment(db, storage, deploymentId);
    const list = await (await app.request(`/apps/${appId}/deployments`, { headers: { cookie: ck } })).json() as { deployments: { id: string; status: string }[] };
    expect(list.deployments[0]).toMatchObject({ id: deploymentId, status: 'live' });
    expect((await app.request(`/apps/${appId}/deployments`, { headers: { cookie: bk } })).status).toBe(404);
    expect((await app.request(`/apps/${appId}/deployments/${deploymentId}/rollback`, { method: 'POST', headers: { cookie: ck } })).status).toBe(200);
    expect((await app.request(`/apps/${appId}/deployments/${deploymentId}/rollback`, { method: 'POST', headers: { cookie: bk } })).status).toBe(404);
    const huge = await app.request(`/apps/${appId}/deployments`, { method: 'POST', headers: { cookie: ck, 'content-length': String(300 * 1024 * 1024), 'content-type': 'multipart/form-data; boundary=x' }, body: 'x' });
    expect(huge.status).toBe(413);
    expect((await app.request(`/apps/${appId}`, { method: 'DELETE', headers: { cookie: ck } })).status).toBe(200);
    expect(jobs.at(-1)).toEqual({ name: JOBS.deleteAppStorage, data: { appId } });
    await cleanup(appId);
  }));

  it('infrastructure error: throws for retry (row stays processing), then a retry goes live; last attempt records failure', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const id = await deploy(db, a, appId, { 'index.html': 'x' });
    let fail = 1;
    const flaky = { ...storage, sites: { ...storage.sites, put: async (...args: Parameters<Storage['sites']['put']>) => {
      if (fail-- > 0) throw new Error('boom');
      return storage.sites.put(...args);
    } } } as Storage;
    await expect(processDeployment(db, flaky, id)).rejects.toThrow('boom');
    expect((await row(db, id)).status).toBe('processing');
    await processDeployment(db, flaky, id);
    expect((await row(db, id)).status).toBe('live');
    const id2 = await deploy(db, a, appId, { 'index.html': 'y' });
    fail = 5;
    await processDeployment(db, flaky, id2, { lastAttempt: true });
    expect(await row(db, id2)).toMatchObject({ status: 'failed', message: 'deploy.error.internal' });
    await cleanup(appId);
  }));

  it('app deleted mid-publish: published files are removed', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const id = await deploy(db, a, appId, { 'index.html': 'x' });
    const hooked = { ...storage, sites: { ...storage.sites, put: async (...args: Parameters<Storage['sites']['put']>) => {
      await storage.sites.put(...args);
      await db.delete(apps).where(eq(apps.id, appId));
    } } } as Storage;
    await processDeployment(db, hooked, id);
    expect(await storage.sites.list(`${appId}/`)).toEqual([]);
    await cleanup(appId);
  }));

  it('rollback pins: an older queued deployment finishing afterwards cannot override the rolled-back version', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    const d1 = await deploy(db, a, appId, { 'index.html': '1' });
    await processDeployment(db, storage, d1);
    const d2 = await deploy(db, a, appId, { 'index.html': '2' });
    const slow = await deploy(db, a, appId, { 'index.html': '3' });
    await db.update(deployments).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(deployments.id, d1));
    await db.update(deployments).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(deployments.id, d2));
    await processDeployment(db, storage, d2);
    expect(await rollback(db, a.id, appId, d1)).toEqual({ ok: true });
    await processDeployment(db, storage, slow); // created before the rollback
    expect(await active(db, appId)).toBe(d1);
    expect((await row(db, slow)).status).toBe('superseded');
    const later = await deploy(db, a, appId, { 'index.html': '4' });
    await processDeployment(db, storage, later); // created after: goes live
    expect(await active(db, appId)).toBe(later);
    await cleanup(appId);
  }));

  it('deleteApp still succeeds when enqueueing cleanup fails', () => withTestDb(async (db) => {
    const { a, appId } = await setup(db);
    expect(await deleteApp(db, a.id, appId, { enqueueStorageCleanup: async () => { throw new Error('queue down'); } })).toEqual({ ok: true });
  }));
});
