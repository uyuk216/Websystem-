import { eq } from 'drizzle-orm';
import { t } from 'i18n';
import { databaseNames, type DatabaseDriver, type DatabaseWriteMode } from 'platform';
import { DATABASE_LIMITS } from 'shared';
import { withSystem, type Db } from '../db/client.js';
import { appDatabases, apps } from '../db/schema.js';
import { resolveEntitlements } from '../grants/entitlements.js';
import type { Mailer } from '../mail/mailer.js';
import { ownerContact } from '../usage/owner-contact.js';

export interface DatabaseWatchOptions {
  db: Db;
  databases: Pick<DatabaseDriver, 'sizeBytes' | 'setWriteMode'> & Partial<Pick<DatabaseDriver, 'dropExpiredLogins'>>;
  mailer?: Mailer;
  emailKey?: Buffer;
  now?: Date;
  limitBytes?: number;
}

/**
 * The write mode a database should be in. Read-only starts at 100% and lasts until usage is back under the warning
 * level (so it does not flap around 100%); connections are refused beyond the hard limit, which only a session that
 * overrode read-only can reach.
 */
export function targetWriteMode(ratio: number, current: DatabaseWriteMode): DatabaseWriteMode {
  if (ratio >= DATABASE_LIMITS.hardRatio) return 'blocked';
  if (ratio >= 1) return current === 'blocked' ? 'blocked' : 'read_only';
  if (ratio >= DATABASE_LIMITS.warnRatio) return current === 'normal' ? 'normal' : 'read_only';
  return 'normal';
}

const MB = 1024 * 1024;
const month = (d: Date) => d.toISOString().slice(0, 7);

/** Measures every ready database once; applies the write mode and mails the owner at 80% and 100% (once per month each). */
export async function checkDatabaseSizes(o: DatabaseWatchOptions): Promise<Array<{ appId: string; sizeBytes: number; writeMode: DatabaseWriteMode }>> {
  const now = o.now ?? new Date();
  const rows = await withSystem(o.db, (tx) => tx.select({
    appId: appDatabases.appId, writeMode: appDatabases.writeMode, notifiedLevel: appDatabases.notifiedLevel, notifiedMonth: appDatabases.notifiedMonth,
    ownerId: apps.ownerId, name: apps.name,
  }).from(appDatabases).innerJoin(apps, eq(apps.id, appDatabases.appId)).where(eq(appDatabases.status, 'ready')));
  const out: Array<{ appId: string; sizeBytes: number; writeMode: DatabaseWriteMode }> = [];
  for (const r of rows) {
    const { database, user } = databaseNames(r.appId);
    // Tunnel logins past their validity are dropped on every round.
    await o.databases.dropExpiredLogins?.(r.appId).catch((e: unknown) => console.error('drop tunnel logins failed', r.appId, e));
    let size: number;
    try { size = await o.databases.sizeBytes(r.appId, database); } catch (e) { console.error('database size check failed', r.appId, e); continue; }
    // Plan limit of the owner. Without a grant (lapsed) the Student size still applies: the database is kept, not blocked (suspension is Task 7).
    const limit = o.limitBytes ?? ((await resolveEntitlements(o.db, r.ownerId, now)).database.sizeBytes || DATABASE_LIMITS.sizeBytes);
    const ratio = size / limit;
    const current = r.writeMode as DatabaseWriteMode;
    const mode = targetWriteMode(ratio, current);
    if (mode !== current) {
      try { await o.databases.setWriteMode(r.appId, database, user, mode); } catch (e) { console.error('database write mode change failed', r.appId, e); continue; }
    }
    const level = ratio >= 1 ? 100 : ratio >= DATABASE_LIMITS.warnRatio ? 80 : 0;
    const sameMonth = r.notifiedMonth === month(now);
    const already = sameMonth ? r.notifiedLevel : 0;
    const mail = level > already;
    await withSystem(o.db, (tx) => tx.update(appDatabases).set({
      sizeBytes: size, writeMode: mode, checkedAt: now,
      ...(mail ? { notifiedLevel: level, notifiedMonth: month(now) } : {}),
    }).where(eq(appDatabases.appId, r.appId)));
    if (mail && o.mailer && o.emailKey) {
      const mailer = o.mailer;
      const key = level === 100 ? 'database.full' : 'database.warn';
      try {
        const to = await ownerContact(o.db, r.ownerId, o.emailKey);
        if (to) {
          const p = { app: r.name, used: (size / MB).toFixed(1), limit: (limit / MB).toFixed(0) };
          await mailer.sendMail(to.email, t(to.locale, `${key}Subject` as const, p), t(to.locale, `${key}Body` as const, p));
        }
      } catch (e) { console.error('database usage mail failed', r.appId, e); }
    }
    out.push({ appId: r.appId, sizeBytes: size, writeMode: mode });
  }
  return out;
}

/** Runs checkDatabaseSizes every `intervalMs` without overlapping a slow round. */
export function startDatabaseWatch(o: DatabaseWatchOptions, intervalMs = 5 * 60_000): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void checkDatabaseSizes(o).catch((e) => console.error('database watch failed', e)).finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
