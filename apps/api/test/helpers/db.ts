/**
 * Test DB helper. Requires the compose Postgres to be running (`pnpm dev:up --no-k8s`).
 * Each call creates a uniquely named database, runs migrations into it, then drops it.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';

const URL_ = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform';

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

// A fresh database per test (generated migrations hardcode the "public" schema in FKs,
// so a per-test schema would not isolate them).
export async function withTestDb<T>(fn: (db: TestDb) => Promise<T>): Promise<T> {
  const name = `test_${randomUUID().replace(/-/g, '')}`;
  const admin = postgres(URL_, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);
  const u = new URL(URL_);
  u.pathname = `/${name}`;
  const sql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
    return await fn(db);
  } finally {
    await sql.end();
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.end();
  }
}
