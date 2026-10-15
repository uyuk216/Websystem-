import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(url: string, options: postgres.Options<Record<string, never>> = {}) {
  const sql = postgres(url, options);
  return { db: drizzle(sql, { schema }), sql };
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction as the RLS-restricted `platform_api` role with `app.account_id` set.
 * Every authenticated operation goes through this.
 */
export async function withAccount<T>(db: Db | Tx, accountId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(accountId)) throw new Error('withAccount: invalid account id');
  return (db as Db).transaction(async (tx) => {
    await tx.execute(sql`set local role platform_api`);
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` in a transaction as the owner role (RLS does not apply: owner is superuser/BYPASSRLS).
 * Only for pre-authentication flows and admin scripts where no account is known yet.
 */
export async function withSystem<T>(db: Db | Tx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (db as Db).transaction(fn);
}

/** Refuses to run unless the connecting (owner) role bypasses RLS, which withSystem relies on. */
export async function assertOwnerBypassesRls(db: Db): Promise<void> {
  const rows = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
  const r = rows[0];
  if (!r || !(r.rolsuper || r.rolbypassrls)) {
    throw new Error(`Database role "${r?.rolname ?? 'unknown'}" must be SUPERUSER or BYPASSRLS: withSystem (pre-auth flows) relies on it to bypass FORCE ROW LEVEL SECURITY.`);
  }
}
