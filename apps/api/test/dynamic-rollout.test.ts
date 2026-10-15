import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DockerDriver, createStorage, loadStorageConfig, type Storage } from 'platform';
import { makeZip } from '../../../packages/platform/test/ingest/helpers.js';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, deployments, owners, teamMembers, teams } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { createDeployment, listDeployments, rollback } from '../src/apps/deployments.js';
import { setEnvVar } from '../src/apps/env-vars.js';
import { deleteAppStorage, processDeployment } from '../src/ingest/publish.js';
import { createDynamicRuntime, type DynamicRuntime } from '../src/ingest/dynamic.js';

const env = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
};
let storage: Storage;
const driver = new DockerDriver({ warn: () => undefined });
const envKey = randomBytes(32);
const rt: DynamicRuntime = { driver, envKey, health: { timeoutMs: 20_000, intervalMs: 200 } };
const rtFast: DynamicRuntime = { driver, envKey, health: { timeoutMs: 3_000, intervalMs: 200 } };
beforeAll(async () => { storage = createStorage(loadStorageConfig(env)); await storage.ensureBuckets(); });
afterAll(() => storage.close());

let n = 0;
const queue = { send: async () => 'job' };
const zip = (files: Record<string, string>) => Readable.from([makeZip(Object.entries(files).map(([name, d]) => ({ name, data: Buffer.from(d) })))]);
const cleanup: string[] = [];
afterAll(async () => { await Promise.all(cleanup.map((id) => deleteAppStorage(storage, id, rt).catch(() => undefined))); }, 120_000);

/** An alpine app serving `<label> $GREETING` on $PORT after `delay` seconds. */
const app = (label: string, o: { delay?: number; port?: string; cmd?: string } = {}) => ({
  Dockerfile: `FROM busybox\nCMD ["sh","-c",${JSON.stringify(o.cmd ?? `sleep ${o.delay ?? 0}; mkdir -p /tmp/w; echo "${label} $GREETING" > /tmp/w/index.html; exec httpd -f -p ${o.port ?? '$PORT'} -h /tmp/w`)}]\n`,
});
const body = async (appId: string, depId: string) => {
  const ep = await driver.endpoint(appId, depId);
  if (!ep) return null;
  try { return (await (await fetch(`http://${ep.host}:${ep.port}/`)).text()).trim(); } catch { return null; }
};

async function setup(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `ro${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  const { appId } = await createApp(db, a!.id, { name: `r-${randomUUID().slice(0, 8)}`, ownerId }) as { appId: string };
  await db.update(apps).set({ kind: 'dynamic' }).where(eq(apps.id, appId));
  cleanup.push(appId);
  return { accountId: a!.id, appId };
}
async function upload(db: TestDb, s: { accountId: string; appId: string }, files: Record<string, string>) {
  const r = await createDeployment(db, storage, queue, s.accountId, s.appId, { source: 'upload', archive: zip(files), format: 'zip' });
  if ('error' in r) throw new Error(r.error);
  return r.deploymentId;
}
async function deploy(db: TestDb, s: { accountId: string; appId: string }, files: Record<string, string>, runtime = rt) {
  const id = await upload(db, s, files);
  await processDeployment(db, storage, id, { runtime });
  return (await db.select().from(deployments).where(eq(deployments.id, id)))[0]!;
}
const active = async (db: TestDb, appId: string) => (await db.select().from(apps).where(eq(apps.id, appId)))[0]!.activeDeploymentId;
const imageExists = (tag: string) => { try { execFileSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }); return true; } catch { return false; } };

describe('dynamic rollout', () => {
  it('starts, health-checks and switches; the old version keeps answering until then and is stopped after', () => withTestDb(async (db) => {
    const s = await setup(db);
    expect(await setEnvVar(db, envKey, s.accountId, s.appId, 'GREETING', 'hello')).toEqual({ ok: true });
    const v1 = await deploy(db, s, app('v1'));
    expect(v1.status).toBe('live');
    expect(await active(db, s.appId)).toBe(v1.id);
    expect(await body(s.appId, v1.id)).toBe('v1 hello');

    // v2 takes ~4s to start; v1 must answer every request meanwhile.
    const id2 = await upload(db, s, app('v2', { delay: 4 }));
    const rollout = processDeployment(db, storage, id2, { runtime: rt });
    const seen: Array<string | null> = [];
    const until = Date.now() + 3000;
    while (Date.now() < until) { seen.push(await body(s.appId, v1.id)); await new Promise((r) => setTimeout(r, 200)); }
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((b) => b === 'v1 hello')).toBe(true);
    expect(await active(db, s.appId)).toBe(v1.id); // not switched yet
    await rollout;

    const [d1, d2] = await Promise.all([id2, v1.id].map(async (id) => (await db.select().from(deployments).where(eq(deployments.id, id)))[0]!));
    expect(d2).toMatchObject({ status: 'superseded' });
    expect(d1).toMatchObject({ status: 'live', message: null });
    expect(await active(db, s.appId)).toBe(id2);
    expect(await body(s.appId, id2)).toBe('v2 hello');
    expect(await driver.status(s.appId, v1.id)).toBe('stopped');
  }), 240_000);

  it('a deployment that ignores PORT fails, keeps the old version running and records the log tail', () => withTestDb(async (db) => {
    const s = await setup(db);
    const v1 = await deploy(db, s, app('v1'));
    const bad = await deploy(db, s, app('bad', { port: '9999', cmd: 'echo listening-on-9999; exec httpd -f -p 9999 -h /tmp' }), rtFast);
    expect(bad).toMatchObject({ status: 'failed', message: 'deploy.error.health_check_failed', imageRef: null });
    expect((bad.findings as { logs: string[] }).logs.join('\n')).toContain('listening-on-9999');
    expect(await active(db, s.appId)).toBe(v1.id);
    expect(await body(s.appId, v1.id)).toBe('v1');
    expect(await driver.status(s.appId, bad.id)).toBe('stopped');
    expect(imageExists(`ys/${s.appId}:${bad.id}`)).toBe(false);
  }), 240_000);

  it('a crashing deployment fails with app_exited; env values are redacted from the stored log', () => withTestDb(async (db) => {
    const s = await setup(db);
    await setEnvVar(db, envKey, s.accountId, s.appId, 'API_SECRET', 'topsecretvalue');
    const v1 = await deploy(db, s, app('v1'));
    const bad = await deploy(db, s, app('x', { cmd: 'echo boom-marker $API_SECRET; exit 1' }));
    expect(bad).toMatchObject({ status: 'failed', message: 'deploy.error.app_exited' });
    const logs = (bad.findings as { logs: string[] }).logs.join('\n');
    expect(logs).toContain('boom-marker');
    expect(logs).not.toContain('topsecretvalue');
    expect(await active(db, s.appId)).toBe(v1.id);
  }), 240_000);

  it('rolls back by restarting the old image; a deployment created before the rollback cannot override it', () => withTestDb(async (db) => {
    const s = await setup(db);
    const v1 = await deploy(db, s, app('v1'));
    const v2 = await deploy(db, s, app('v2'));
    const pending = await upload(db, s, app('v3')); // created before the rollback
    expect(await driver.status(s.appId, v1.id)).toBe('stopped');

    expect(await rollback(db, s.accountId, s.appId, v1.id, rt)).toEqual({ ok: true });
    expect(await active(db, s.appId)).toBe(v1.id);
    expect(await body(s.appId, v1.id)).toBe('v1');
    expect(await driver.status(s.appId, v2.id)).toBe('stopped');
    expect((await db.select().from(deployments).where(eq(deployments.id, v2.id)))[0]!.status).toBe('superseded');

    await processDeployment(db, storage, pending, { runtime: rt });
    expect((await db.select().from(deployments).where(eq(deployments.id, pending)))[0]!.status).toBe('superseded');
    expect(await active(db, s.appId)).toBe(v1.id);
    expect(await driver.status(s.appId, pending)).toBe('stopped');
    expect(await body(s.appId, v1.id)).toBe('v1');
  }), 300_000);

  it('deleting an app stops its containers and removes its images', () => withTestDb(async (db) => {
    const s = await setup(db);
    const v1 = await deploy(db, s, app('v1'));
    expect(await driver.status(s.appId, v1.id)).toBe('running');
    await deleteAppStorage(storage, s.appId, rt);
    expect(await driver.status(s.appId, v1.id)).toBe('stopped');
    expect(imageExists(`ys/${s.appId}:${v1.id}`)).toBe(false);
  }), 240_000);
});

describe('runtime configuration', () => {
  it('refuses to enable the dynamic runtime without APP_ENV_KEY', () => {
    expect(() => createDynamicRuntime({})).toThrow(/APP_ENV_KEY is required/);
    expect(() => createDynamicRuntime({ APP_ENV_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(createDynamicRuntime({ DYNAMIC_RUNTIME: 'off' })).toBeUndefined();
    expect(createDynamicRuntime({ APP_ENV_KEY: randomBytes(32).toString('base64') })?.envKey).toHaveLength(32);
  });

  it('setEnvVar does not fail when an existing row cannot be decrypted', () => withTestDb(async (db) => {
    const s = await setup(db);
    expect(await setEnvVar(db, envKey, s.accountId, s.appId, 'A', 'one')).toEqual({ ok: true });
    expect(await setEnvVar(db, randomBytes(32), s.accountId, s.appId, 'B', 'two')).toEqual({ ok: true }); // other key
    expect(await setEnvVar(db, envKey, s.accountId, s.appId, 'C', 'three')).toEqual({ ok: true });
  }));
});

describe('runtime log exposure', () => {
  it('returns runtime logs only to users who may deploy', () => withTestDb(async (db) => {
    const s = await setup(db);
    const [t] = await db.insert(teams).values({ name: `t${n++}` }).returning();
    const [o] = await db.insert(owners).values({ kind: 'team', teamId: t!.id }).returning();
    const [viewer] = await db.insert(accounts).values({ emailHash: `vw${n++}`, emailEnc: 'e', displayName: 'V', locale: 'ja', adultFrom: '2030-01' }).returning();
    await db.insert(teamMembers).values([{ teamId: t!.id, accountId: s.accountId, role: 'owner' }, { teamId: t!.id, accountId: viewer!.id, role: 'viewer' }]);
    await db.update(apps).set({ ownerId: o!.id }).where(eq(apps.id, s.appId));
    const bad = await deploy(db, s, app('x', { cmd: 'echo visible-log; exit 1' }));
    const mine = (await listDeployments(db, s.accountId, s.appId)).find((d) => d.id === bad.id)!;
    expect((mine.findings as { logs: string[] }).logs.join()).toContain('visible-log');
    const theirs = (await listDeployments(db, viewer!.id, s.appId)).find((d) => d.id === bad.id);
    expect(theirs).toMatchObject({ status: 'failed', findings: null });
  }), 240_000);
});

describe('rollback start_failed body', () => {
  it('carries reason and redacted logs for managers; non-managers get neither', () => withTestDb(async (db) => {
    const s = await setup(db);
    await setEnvVar(db, envKey, s.accountId, s.appId, 'TOKEN', 'sekrit-token-value');
    const v1 = await deploy(db, s, app('v1'));
    await deploy(db, s, app('v2'));
    const failing = Object.create(driver) as DockerDriver;
    failing.status = async () => 'crashed';
    failing.logs = async () => ['died with sekrit-token-value'];
    const r = await rollback(db, s.accountId, s.appId, v1.id, { ...rt, driver: failing });
    expect(r).toEqual({ error: 'start_failed', reason: 'deploy.error.app_exited', logs: ['died with ***'] });
    const [stranger] = await db.insert(accounts).values({ emailHash: `st${n++}`, emailEnc: 'e', displayName: 'S', locale: 'ja', adultFrom: '2030-01' }).returning();
    const r2 = await rollback(db, stranger!.id, s.appId, v1.id, { ...rt, driver: failing });
    expect(r2).not.toHaveProperty('logs');
    expect(r2).not.toHaveProperty('reason');
  }), 240_000);
});
