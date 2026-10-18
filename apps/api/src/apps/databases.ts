import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { databaseNames, databaseUrl, type DatabaseDriver } from 'platform';
import { DATABASE_LIMITS } from 'shared';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { appDatabases, apps } from '../db/schema.js';
import { mayManage } from './apps.js';
import { decryptEnvValue, encryptEnvValue, getAppEnvForRun } from './env-vars.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The password is encrypted with the env-var scheme under a name no env var can have. */
const SECRET_NAME = '#database';

/** What the database features need from the runtime (a subset of DynamicRuntime). */
export interface DatabaseRuntime {
  envKey: Buffer;
  databases?: DatabaseDriver;
}

export type DatabaseError = 'not_found' | 'forbidden' | 'not_dynamic' | 'exists' | 'unavailable' | 'failed';

export interface DatabaseView {
  status: 'creating' | 'ready' | 'failed';
  sizeBytes: number;
  limitBytes: number;
  writeMode: 'normal' | 'read_only' | 'blocked';
  checkedAt: Date | null;
  createdAt: Date;
}

async function managedApp(db: Db, accountId: string, appId: string) {
  if (!UUID.test(appId)) return { error: 'not_found' as const };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId, kind: apps.kind }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    return a;
  });
}

export async function getDatabase(db: Db, accountId: string, appId: string): Promise<{ database: DatabaseView | null } | { error: 'not_found' }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    const [d] = await tx.select().from(appDatabases).where(eq(appDatabases.appId, appId));
    if (!d) return { database: null };
    return {
      database: {
        status: d.status as DatabaseView['status'], sizeBytes: d.sizeBytes, limitBytes: DATABASE_LIMITS.sizeBytes,
        writeMode: d.writeMode as DatabaseView['writeMode'], checkedAt: d.checkedAt, createdAt: d.createdAt,
      },
    };
  });
}

/**
 * Creates the app's database. The row is inserted first (one per app: a second concurrent call gets 'exists'),
 * then the server is created; a failure leaves status 'failed' so the user can retry or remove it.
 */
export async function addDatabase(db: Db, rt: DatabaseRuntime | undefined, accountId: string, appId: string): Promise<{ ok: true } | { error: DatabaseError }> {
  const a = await managedApp(db, accountId, appId);
  if ('error' in a) return a;
  if (a.kind !== 'dynamic') return { error: 'not_dynamic' };
  if (!rt?.databases) return { error: 'unavailable' };
  const password = randomBytes(24).toString('base64url');
  const passwordEnc = encryptEnvValue(password, rt.envKey, appId, SECRET_NAME);
  const claimed = await withAccount(db, accountId, async (tx) => {
    const [cur] = await tx.select({ status: appDatabases.status }).from(appDatabases).where(eq(appDatabases.appId, appId));
    if (cur && cur.status !== 'failed') return false;
    if (cur) await tx.update(appDatabases).set({ status: 'creating', passwordEnc }).where(eq(appDatabases.appId, appId));
    else {
      const ins = await tx.insert(appDatabases).values({ appId, passwordEnc }).onConflictDoNothing().returning({ appId: appDatabases.appId });
      if (ins.length === 0) return false;
    }
    return true;
  });
  if (!claimed) return { error: 'exists' };
  const { database, user } = databaseNames(appId);
  try {
    await rt.databases.create({ appId, ownerId: a.ownerId, database, user, password, limits: { connections: DATABASE_LIMITS.connections, memoryMb: DATABASE_LIMITS.memoryMb } });
  } catch (e) {
    console.error('database create failed', appId, e);
    await withSystem(db, (tx) => tx.update(appDatabases).set({ status: 'failed' }).where(eq(appDatabases.appId, appId)));
    return { error: 'failed' };
  }
  await withSystem(db, (tx) => tx.update(appDatabases).set({ status: 'ready' }).where(eq(appDatabases.appId, appId)));
  return { ok: true };
}

/** Deletes the database server and its data. The app keeps running without DATABASE_URL after its next restart. */
export async function removeDatabase(db: Db, rt: DatabaseRuntime | undefined, accountId: string, appId: string): Promise<{ ok: true } | { error: DatabaseError }> {
  const a = await managedApp(db, accountId, appId);
  if ('error' in a) return a;
  if (!rt?.databases) return { error: 'unavailable' };
  const [row] = await withSystem(db, (tx) => tx.select({ appId: appDatabases.appId }).from(appDatabases).where(eq(appDatabases.appId, appId)));
  if (!row) return { error: 'not_found' };
  await rt.databases.remove(appId);
  await withSystem(db, (tx) => tx.delete(appDatabases).where(eq(appDatabases.appId, appId)));
  return { ok: true };
}

/** Removes the database server of a deleted app (the row is already gone with the app). */
export async function removeDatabaseOfDeletedApp(rt: DatabaseRuntime | undefined, appId: string): Promise<void> {
  if (rt?.databases) await rt.databases.remove(appId);
}

/**
 * Everything an app is started with: its env vars plus, when it has a ready database, DATABASE_URL (overriding a
 * user variable of the same name) and the database network to join. Used by every start path and by log redaction.
 */
export async function getRunInputs(db: Db, rt: DatabaseRuntime, appId: string): Promise<{ env: Record<string, string>; networks: string[]; secrets: string[] }> {
  const env = await getAppEnvForRun(db, rt.envKey, appId);
  if (!rt.databases) return { env, networks: [], secrets: Object.values(env) };
  const [d] = await withSystem(db, (tx) => tx.select({ status: appDatabases.status, passwordEnc: appDatabases.passwordEnc }).from(appDatabases).where(eq(appDatabases.appId, appId)));
  if (d?.status !== 'ready') return { env, networks: [], secrets: Object.values(env) };
  const password = decryptEnvValue(d.passwordEnc, rt.envKey, appId, SECRET_NAME);
  const { database, user } = databaseNames(appId);
  const ep = rt.databases.endpoint(appId);
  const full = { ...env, DATABASE_URL: databaseUrl(ep, database, user, password) };
  // Values to scrub from logs: every env value and the bare password (an app may print either).
  return { env: full, networks: ep.network ? [ep.network] : [], secrets: [...Object.values(full), password] };
}
