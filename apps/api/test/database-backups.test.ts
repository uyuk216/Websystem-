import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorage, DockerDatabaseDriver, loadStorageConfig, type Storage } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { addDatabase, getRunInputs } from '../src/apps/databases.js';
import { backupNow, listBackups, restoreBackup, runScheduledBackups, takeBackup } from '../src/apps/database-backups.js';

const available = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const envKey = randomBytes(32);
const databases = new DockerDatabaseDriver();
const rt = { envKey, databases };
const env = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
};
let storage: Storage;
const cleanup: string[] = [];
beforeAll(async () => { storage = createStorage(loadStorageConfig(env)); await storage.ensureBuckets(); });
afterAll(async () => {
  for (const id of cleanup) { await databases.remove(id).catch(() => undefined); await storage.sources.deletePrefix(`${id}/`).catch(() => 0); }
  storage.close();
}, 120_000);

/** psql as the app would run it: a client container on the database's network with the app's DATABASE_URL. */
function sqlAsApp(network: string, url: string, sql: string): string {
  const r = spawnSync('docker', ['run', '--rm', '--network', network, 'postgres:16-alpine', 'psql', url, '-v', 'ON_ERROR_STOP=1', '-qtAc', sql], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

async function setup(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  const { appId } = await createApp(db, a!.id, { name: `b-${randomUUID().slice(0, 8)}`, ownerId, kind: 'dynamic' }) as { appId: string };
  cleanup.push(appId);
  expect(await addDatabase(db, rt, a!.id, appId)).toEqual({ ok: true });
  const run = await getRunInputs(db, rt, appId);
  const sql = (q: string) => sqlAsApp(run.networks[0]!, run.env.DATABASE_URL!, q);
  return { accountId: a!.id, appId, sql };
}

describe.skipIf(!available)('database backups', { timeout: 240_000 }, () => {
  it('backs up, lists newest first, restores (after a safety backup) and keeps writing', () => withTestDb(async (db) => {
    const s = await setup(db);
    s.sql("CREATE TABLE notes(body text); INSERT INTO notes VALUES ('v1');");
    const b1 = await backupNow(db, storage, rt, s.accountId, s.appId);
    if (!('backup' in b1)) throw new Error(JSON.stringify(b1));
    expect(b1.backup.sizeBytes).toBeGreaterThan(0);
    s.sql("UPDATE notes SET body = 'v2';");

    const r = await restoreBackup(db, storage, rt, s.accountId, s.appId, b1.backup.id);
    if (!('ok' in r)) throw new Error(JSON.stringify(r));
    expect(s.sql('SELECT body FROM notes')).toBe('v1');
    s.sql("INSERT INTO notes VALUES ('after restore');");
    const list = await listBackups(db, storage, s.accountId, s.appId);
    if (!('backups' in list)) throw new Error('list');
    expect(list.backups.map((b) => b.id)).toEqual([r.safetyBackup, b1.backup.id]);
    // The safety backup undoes the restore.
    await restoreBackup(db, storage, rt, s.accountId, s.appId, r.safetyBackup);
    expect(s.sql('SELECT body FROM notes')).toBe('v2');
  }));

  it('rejects strangers and unknown or malformed backup ids', () => withTestDb(async (db) => {
    const s = await setup(db);
    const [o] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: 'e', displayName: 'O', locale: 'ja', adultFrom: '2030-01' }).returning();
    expect(await listBackups(db, storage, o!.id, s.appId)).toEqual({ error: 'not_found' });
    expect(await restoreBackup(db, storage, rt, s.accountId, s.appId, '2026-01-01T00:00:00.000Z')).toEqual({ error: 'not_found' });
    expect(await restoreBackup(db, storage, rt, s.accountId, s.appId, '../../other/x')).toEqual({ error: 'not_found' });
  }));

  it('scheduled backups: one per interval, pruned after the retention period', () => withTestDb(async (db) => {
    const s = await setup(db);
    const t0 = new Date('2026-10-01T00:00:00.000Z');
    await takeBackup(storage, rt, s.appId, t0);
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect((await runScheduledBackups(db, storage, rt, at(30))).taken).not.toContain(s.appId); // not due yet
    expect((await runScheduledBackups(db, storage, rt, at(61))).taken).toContain(s.appId);
    const r = await runScheduledBackups(db, storage, rt, at(8 * 24 * 60));
    expect(r.taken).toContain(s.appId);
    expect(r.pruned).toBeGreaterThanOrEqual(2); // the t0 and t0+61min backups are older than 7 days
    const list = await listBackups(db, storage, s.accountId, s.appId);
    if (!('backups' in list)) throw new Error('list');
    expect(list.backups.map((b) => b.at.toISOString())).toEqual([at(8 * 24 * 60).toISOString()]);
  }));
});
