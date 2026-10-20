import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DockerDatabaseDriver, DockerDriver } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, appDatabases } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { createApp } from '../src/apps/apps.js';
import { setEnvVar } from '../src/apps/env-vars.js';
import { addDatabase, getDatabase, getRunInputs, removeDatabase } from '../src/apps/databases.js';

const available = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
/** A stand-in app: the postgres client tools, idling (the stock image would try to start its own server). */
const CLIENT_IMAGE = 'ys-test-psql-client:1';
if (available) spawnSync('docker', ['build', '-q', '-t', CLIENT_IMAGE, '-'], { input: 'FROM postgres:16-alpine\nENTRYPOINT ["sleep", "3600"]\n', stdio: ['pipe', 'ignore', 'inherit'] });
const envKey = randomBytes(32);
const databases = new DockerDatabaseDriver();
const rt = { envKey, databases };
const cleanup: string[] = [];
let n = 0;

async function setup(db: TestDb, kind: 'static' | 'dynamic' = 'dynamic') {
  const [a] = await db.insert(accounts).values({ emailHash: `dbt${n++}-${randomUUID()}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  await giveStudent(db, a!.id);
  const r = await createApp(db, a!.id, { name: `db-${randomUUID().slice(0, 8)}`, ownerId, kind }) as { appId: string };
  cleanup.push(r.appId);
  return { accountId: a!.id, appId: r.appId, ownerId };
}

afterAll(async () => { await Promise.all(cleanup.map((id) => databases.remove(id).catch(() => undefined))); }, 120_000);

describe.skipIf(!available)('user databases', { timeout: 180_000 }, () => {
  it('adds a database once, never returns the password, and passes DATABASE_URL + network to the app', () => withTestDb(async (db) => {
    const s = await setup(db);
    await setEnvVar(db, envKey, s.accountId, s.appId, 'DATABASE_URL', 'postgres://user-set'); // overridden below
    const [r1, r2] = await Promise.all([addDatabase(db, rt, s.accountId, s.appId), addDatabase(db, rt, s.accountId, s.appId)]);
    expect([r1, r2].filter((r) => 'ok' in r)).toHaveLength(1);
    expect([r1, r2].filter((r) => 'error' in r)).toEqual([{ error: 'exists' }]);

    const view = await getDatabase(db, s.accountId, s.appId);
    expect(view).toMatchObject({ database: { status: 'ready', limitBytes: 256 * 1024 ** 2, writeMode: 'normal' } });
    const [row] = await db.select().from(appDatabases).where(eq(appDatabases.appId, s.appId));
    const run = await getRunInputs(db, rt, s.appId);
    const password = decodeURIComponent(new URL(run.env.DATABASE_URL!).password);
    expect(JSON.stringify(view)).not.toContain(password);
    expect(row!.passwordEnc).not.toContain(password);
    expect(run.env.DATABASE_URL).not.toBe('postgres://user-set');
    expect(run.secrets).toContain(password);
    expect(run.networks).toEqual([(await databases.endpoint(s.appId)).network]);

    // A real app container started the way rollouts start apps reaches the database through DATABASE_URL.
    const driver = new DockerDriver({ warn: () => {} });
    const deploymentId = randomUUID();
    await driver.start({
      appId: s.appId, deploymentId, ownerId: s.ownerId, image: CLIENT_IMAGE, port: 8080,
      env: { ...run.env, PORT: '8080' }, networks: run.networks, limits: { memoryMb: 128, cpu: 0.5, pids: 64 },
    });
    try {
      const out = execFileSync('docker', ['exec', `ys-app-${s.appId}-${deploymentId.slice(0, 8)}`, 'sh', '-c', 'psql "$DATABASE_URL" -qtAc "select current_user"'], { encoding: 'utf8' });
      expect(out.trim()).toMatch(/^app_[0-9a-f]{16}$/);
    } finally {
      await driver.stop(s.appId);
    }
  }));

  it('rejects strangers and static apps; remove deletes the server', () => withTestDb(async (db) => {
    const s = await setup(db);
    const other = await setup(db);
    const st = await setup(db, 'static');
    expect(await addDatabase(db, rt, other.accountId, s.appId)).toEqual({ error: 'not_found' });
    expect(await addDatabase(db, rt, st.accountId, st.appId)).toEqual({ error: 'not_dynamic' });
    expect(await addDatabase(db, undefined, s.accountId, s.appId)).toEqual({ error: 'unavailable' });
    expect(await addDatabase(db, rt, s.accountId, s.appId)).toEqual({ ok: true });
    expect(await removeDatabase(db, rt, other.accountId, s.appId)).toEqual({ error: 'not_found' });
    expect(await removeDatabase(db, rt, s.accountId, s.appId)).toEqual({ ok: true });
    expect(await databases.status(s.appId)).toBe('missing');
    expect(await getDatabase(db, s.accountId, s.appId)).toEqual({ database: null });
    expect((await getRunInputs(db, rt, s.appId)).env.DATABASE_URL).toBeUndefined();
  }));

  it('a failed create can be retried', () => withTestDb(async (db) => {
    const s = await setup(db);
    const broken = { envKey, databases: new DockerDatabaseDriver({ image: 'ys-no-such-image:never' }) };
    expect(await addDatabase(db, broken, s.accountId, s.appId)).toEqual({ error: 'failed' });
    expect(await getDatabase(db, s.accountId, s.appId)).toMatchObject({ database: { status: 'failed' } });
    expect(await addDatabase(db, rt, s.accountId, s.appId)).toEqual({ ok: true });
  }));
});
