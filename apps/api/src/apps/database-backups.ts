import { eq } from 'drizzle-orm';
import { databaseNames, type DatabaseDriver, type Storage } from 'platform';
import { DATABASE_LIMITS } from 'shared';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { appDatabases, apps } from '../db/schema.js';
import { mayManage } from './apps.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Backup ids are their UTC timestamps (milliseconds), so listing needs no table. */
const ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Drivers = { databases?: DatabaseDriver };

const prefix = (appId: string) => `${appId}/db-backups/`;
const keyOf = (appId: string, id: string) => `${prefix(appId)}${id}.dump`;

export interface BackupView { id: string; at: Date; sizeBytes: number }

async function listKeys(storage: Storage, appId: string): Promise<BackupView[]> {
  const items = await storage.sources.list(prefix(appId));
  return items.flatMap((o) => {
    const id = o.key.slice(prefix(appId).length).replace(/\.dump$/, '');
    return ID.test(id) ? [{ id, at: new Date(id), sizeBytes: o.size }] : [];
  }).sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Writes one backup of the app's database to storage. A failed dump leaves no partial object. */
export async function takeBackup(storage: Storage, rt: Drivers, appId: string, now: Date = new Date()): Promise<BackupView> {
  if (!rt.databases) throw new Error('databases unavailable');
  const id = now.toISOString();
  const key = keyOf(appId, id);
  const { database } = databaseNames(appId);
  try {
    await storage.sources.put(key, await rt.databases.backup(appId, database), 'application/octet-stream');
  } catch (e) {
    await storage.sources.delete(key).catch(() => undefined);
    throw e;
  }
  const head = await storage.sources.head(key);
  return { id, at: now, sizeBytes: head?.size ?? 0 };
}

async function managedDatabase(db: Db, accountId: string, appId: string): Promise<{ ownerId: string; ready: boolean } | { error: 'not_found' | 'forbidden' }> {
  if (!UUID.test(appId)) return { error: 'not_found' as const };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    const [d] = await tx.select({ status: appDatabases.status }).from(appDatabases).where(eq(appDatabases.appId, appId));
    return { ownerId: a.ownerId, ready: d?.status === 'ready' };
  });
}

export async function listBackups(db: Db, storage: Storage, accountId: string, appId: string): Promise<{ backups: BackupView[] } | { error: 'not_found' | 'forbidden' }> {
  const m = await managedDatabase(db, accountId, appId);
  if ('error' in m) return m;
  return { backups: await listKeys(storage, appId) };
}

export async function backupNow(db: Db, storage: Storage, rt: Drivers | undefined, accountId: string, appId: string): Promise<{ backup: BackupView } | { error: 'not_found' | 'forbidden' | 'no_database' | 'unavailable' | 'failed' }> {
  const m = await managedDatabase(db, accountId, appId);
  if ('error' in m) return m;
  if (!m.ready) return { error: 'no_database' };
  if (!rt?.databases) return { error: 'unavailable' };
  try { return { backup: await takeBackup(storage, rt, appId) }; } catch (e) { console.error('backup failed', appId, e); return { error: 'failed' }; }
}

/**
 * Replaces the database with a backup. A backup of the current data is taken first (so the restore itself can be
 * undone); the driver restores into a new database and swaps only on success, so a failure keeps the current data.
 */
export async function restoreBackup(
  db: Db, storage: Storage, rt: Drivers | undefined, accountId: string, appId: string, backupId: string,
): Promise<{ ok: true; safetyBackup: string } | { error: 'not_found' | 'forbidden' | 'no_database' | 'unavailable' | 'failed' }> {
  const m = await managedDatabase(db, accountId, appId);
  if ('error' in m) return m;
  if (!ID.test(backupId)) return { error: 'not_found' };
  if (!m.ready) return { error: 'no_database' };
  if (!rt?.databases) return { error: 'unavailable' };
  const obj = await storage.sources.get(keyOf(appId, backupId));
  if (!obj) return { error: 'not_found' };
  const { database, user } = databaseNames(appId);
  try {
    obj.body.destroy(); // reopened after the safety backup, which may take a while
    const safety = await takeBackup(storage, rt, appId);
    const again = await storage.sources.get(keyOf(appId, backupId));
    if (!again) return { error: 'not_found' };
    await rt.databases.restore(appId, database, user, again.body);
    // The restored database starts writable; the size watch re-applies limits on its next round.
    await withSystem(db, (tx) => tx.update(appDatabases).set({ writeMode: 'normal' }).where(eq(appDatabases.appId, appId)));
    return { ok: true, safetyBackup: safety.id };
  } catch (e) {
    console.error('restore failed', appId, e);
    return { error: 'failed' };
  }
}

/**
 * Takes due backups of ready databases and deletes backups past retention for every dynamic app (including apps
 * whose database was removed: their backups are kept for the retention period so a removal can be undone).
 */
export async function runScheduledBackups(db: Db, storage: Storage, rt: Drivers, now: Date = new Date()): Promise<{ taken: string[]; pruned: number }> {
  const rows = await withSystem(db, (tx) => tx.select({ appId: apps.id, status: appDatabases.status })
    .from(apps).leftJoin(appDatabases, eq(appDatabases.appId, apps.id)).where(eq(apps.kind, 'dynamic')));
  const taken: string[] = [];
  let pruned = 0;
  const due = now.getTime() - DATABASE_LIMITS.backupIntervalMinutes * 60_000;
  const keepFrom = now.getTime() - DATABASE_LIMITS.backupRetentionDays * 86_400_000;
  for (const { appId, status } of rows) {
    try {
      const list = await listKeys(storage, appId);
      if (status === 'ready' && (!list[0] || list[0].at.getTime() <= due)) {
        await takeBackup(storage, rt, appId, now);
        taken.push(appId);
      }
      for (const b of list) {
        if (b.at.getTime() < keepFrom) { await storage.sources.delete(keyOf(appId, b.id)); pruned++; }
      }
    } catch (e) { console.error('scheduled backup failed', appId, e); }
  }
  return { taken, pruned };
}

export function startScheduledBackups(db: Db, storage: Storage, rt: Drivers, intervalMs = 10 * 60_000): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runScheduledBackups(db, storage, rt).catch((e) => console.error('scheduled backups failed', e)).finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
