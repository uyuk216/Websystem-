import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(url: string, options: postgres.Options<Record<string, never>> = {}) {
  const sql = postgres(url, options);
  return { db: drizzle(sql, { schema }), sql };
}
