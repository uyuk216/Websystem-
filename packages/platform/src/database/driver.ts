import type { Readable } from 'node:stream';
import { assertUuid } from '../runtime/driver.js';

/** One PostgreSQL database for one dynamic app. The role is not a superuser and owns only this database. */
export interface DatabaseSpec {
  appId: string;
  ownerId: string;
  /** Database name and login role (lower-case identifiers, see databaseNames). */
  database: string;
  user: string;
  password: string;
  limits: { connections: number; memoryMb: number };
}

/** Where an app connects. `network` is set by drivers that isolate each database on its own network (Docker). */
export interface DatabaseEndpoint {
  host: string;
  port: number;
  network?: string;
}

export type DatabaseStatus = 'running' | 'starting' | 'stopped' | 'missing';

/** Write protection when the database is full: read-only at 100%, connections refused beyond the hard limit. */
export type DatabaseWriteMode = 'normal' | 'read_only' | 'blocked';

export interface DatabaseDriver {
  /** Creates (or keeps) the database server, the role and the database. Idempotent. */
  create(spec: DatabaseSpec): Promise<void>;
  /** Removes the server and its data. Idempotent. */
  remove(appId: string): Promise<void>;
  status(appId: string): Promise<DatabaseStatus>;
  endpoint(appId: string): DatabaseEndpoint;
  sizeBytes(appId: string, database: string): Promise<number>;
  setWriteMode(appId: string, database: string, user: string, mode: DatabaseWriteMode): Promise<void>;
  /** A logical backup (pg_dump custom format) as a stream. */
  backup(appId: string, database: string): Promise<Readable>;
  /**
   * Replaces the database with the contents of `dump`. The dump is restored into a new database first; only when
   * that succeeds is it swapped in, so a failed restore leaves the current data untouched.
   */
  restore(appId: string, database: string, user: string, dump: Readable): Promise<void>;
}

/** Names derived from the app id: the same for every driver, never from user input. */
export function databaseNames(appId: string): { database: string; user: string } {
  assertUuid(appId, 'appId');
  const short = appId.replace(/-/g, '').slice(0, 16).toLowerCase();
  return { database: `app_${short}`, user: `app_${short}` };
}

/** `postgres://user:password@host:port/database` with every part percent-encoded. */
export function databaseUrl(e: DatabaseEndpoint, database: string, user: string, password: string): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${e.host}:${e.port}/${encodeURIComponent(database)}`;
}
