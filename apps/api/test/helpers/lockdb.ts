import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../src/db/schema.js';
import { withWakeLock } from '../../src/apps/wake.js';
import type { TestDb } from './db.js';

const URL_ = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform';

/** A dedicated connection pool to the same test database for wake locks (the test db itself has one connection). */
export async function openLocker(db: TestDb, max = 4) {
  const rows = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const u = new URL(URL_);
  u.pathname = `/${rows[0]!.name}`;
  const client = postgres(u.toString(), { max, onnotice: () => {} });
  const lockDb = drizzle(client, { schema });
  closers.push(() => client.end());
  return { lock: <T>(appId: string, fn: () => Promise<T>, opts?: { timeoutMs?: number }) => withWakeLock(lockDb as never, appId, fn, opts) };
}
const closers: Array<() => Promise<void>> = [];
export async function closeLockers(): Promise<void> {
  await Promise.all(closers.splice(0).map((c) => c()));
}

/** Holds the app's wake lock on its own connection (as another process would) until `release()`. */
export async function holdWakeLock(db: TestDb, appId: string): Promise<() => Promise<void>> {
  const rows = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const u = new URL(URL_);
  u.pathname = `/${rows[0]!.name}`;
  const client = postgres(u.toString(), { max: 1, onnotice: () => {} });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let acquired!: () => void;
  const got = new Promise<void>((r) => { acquired = r; });
  const tx = client.begin(async (t) => {
    await t`SELECT pg_advisory_xact_lock(hashtextextended(${`wake:${appId}`}, 0))`;
    acquired();
    await held;
  });
  await got;
  return async () => { release(); await tx; await client.end(); };
}
