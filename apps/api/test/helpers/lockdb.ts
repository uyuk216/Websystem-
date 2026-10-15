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
  return { lock: <T>(appId: string, fn: () => Promise<T>) => withWakeLock(lockDb as never, appId, fn) };
}
const closers: Array<() => Promise<void>> = [];
export async function closeLockers(): Promise<void> {
  await Promise.all(closers.splice(0).map((c) => c()));
}
