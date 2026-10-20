/**
 * Test helper for the PII database. Requires ys-pii-db (`pnpm dev:up --no-k8s`).
 * Each call creates a uniquely named database, applies the PII migrations as the owner, then drops it.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { applyPiiMigrations } from '../../src/pii/pool.js';

const OWNER_URL = process.env.PII_TEST_OWNER_URL ?? 'postgres://pii_owner:pii_owner@127.0.0.1:54321/postgres';
const ADMIN_CRED = process.env.PII_TEST_ADMIN_CRED ?? 'pii_admin:pii_admin';
const INGEST_CRED = process.env.PII_TEST_INGEST_CRED ?? 'pii_ingest:pii_ingest';

export interface PiiTestDb {
  owner: postgres.Sql;
  admin: postgres.Sql;
  ingest: postgres.Sql;
}

const urlFor = (base: string, db: string, cred?: string): string => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (cred) {
    const [user, pass] = cred.split(':');
    u.username = user!;
    u.password = pass!;
  }
  return u.toString();
};

export async function withPiiTestDb<T>(fn: (db: PiiTestDb) => Promise<T>): Promise<T> {
  const name = `test_${randomUUID().replace(/-/g, '')}`;
  const root = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  await root.unsafe(`create database "${name}"`);
  const open = (cred?: string) => postgres(urlFor(OWNER_URL, name, cred), { max: 1, onnotice: () => {} });
  const owner = open();
  const admin = open(ADMIN_CRED);
  const ingest = open(INGEST_CRED);
  try {
    await applyPiiMigrations(owner);
    return await fn({ owner, admin, ingest });
  } finally {
    await Promise.all([owner.end(), admin.end(), ingest.end()]);
    await root.unsafe(`drop database "${name}" with (force)`);
    await root.end();
  }
}
