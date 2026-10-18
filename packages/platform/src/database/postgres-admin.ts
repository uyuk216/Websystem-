import type { Readable } from 'node:stream';
import type { DatabaseSpec, DatabaseWriteMode } from './driver.js';

export interface ExecResult { code: number | null; out: string; err: string }

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
export const ident = (s: string): string => { if (!IDENT.test(s)) throw new Error(`invalid identifier: ${s}`); return s; };
export const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Database administration shared by the drivers: everything runs as the superuser over the server's local socket
 * through `exec` (docker exec, or the Kubernetes pod exec API), so no admin credentials or ports are exposed.
 */
export abstract class PostgresAdmin {
  /** Runs a command next to the server (stdin optional) and collects its output. */
  protected abstract exec(appId: string, cmd: string[], stdin?: string | Readable): Promise<ExecResult>;
  /** Runs a command and returns its stdout as a stream that errors if the command fails. */
  protected abstract execStream(appId: string, cmd: string[]): Promise<Readable>;

  protected async sql(appId: string, script: string, db = 'postgres'): Promise<string> {
    const r = await this.exec(appId, ['psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qtA'], script);
    if (r.code !== 0) throw new Error(`psql failed: ${r.err.trim() || r.out.trim()}`);
    return r.out;
  }

  /** The app's login role (not a superuser, connection-limited) owning its database. Idempotent. */
  protected async ensureRoleAndDatabase(spec: DatabaseSpec): Promise<void> {
    const db = ident(spec.database);
    const user = ident(spec.user);
    const limit = Math.trunc(spec.limits.connections);
    await this.sql(spec.appId, [
      `DO $$BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(user)}) THEN
          CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(spec.password)} CONNECTION LIMIT ${limit};
        ELSE
          ALTER ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(spec.password)} CONNECTION LIMIT ${limit};
        END IF;
      END$$;`,
      `SELECT 'CREATE DATABASE ${db} OWNER ${user}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${literal(db)})\\gexec`,
      `ALTER DATABASE ${db} OWNER TO ${user};`,
      `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
      `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${user};`,
      '',
    ].join('\n'));
  }

  async sizeBytes(appId: string, database: string): Promise<number> {
    const out = await this.sql(appId, `SELECT pg_database_size(${literal(ident(database))});`);
    const n = Number(out.trim());
    if (!Number.isFinite(n)) throw new Error('unexpected size');
    return n;
  }

  async setWriteMode(appId: string, database: string, user: string, mode: DatabaseWriteMode): Promise<void> {
    const db = ident(database);
    const u = ident(user);
    await this.sql(appId, [
      `ALTER DATABASE ${db} ALLOW_CONNECTIONS ${mode === 'blocked' ? 'false' : 'true'};`,
      `ALTER DATABASE ${db} SET default_transaction_read_only = ${mode === 'normal' ? 'off' : 'on'};`,
      // Settings apply to new sessions: close the app's open ones so the mode takes effect now.
      mode === 'normal' ? '' : `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ${literal(db)} AND usename = ${literal(u)};`,
      '',
    ].join('\n'));
  }

  async backup(appId: string, database: string): Promise<Readable> {
    return this.execStream(appId, ['pg_dump', '-U', 'postgres', '-Fc', '--no-owner', ident(database)]);
  }

  async restore(appId: string, database: string, user: string, dump: Readable): Promise<void> {
    const db = ident(database);
    const u = ident(user);
    const tmp = ident(`${db}_restore`);
    const old = ident(`${db}_old`);
    await this.sql(appId, `DROP DATABASE IF EXISTS ${tmp};\nCREATE DATABASE ${tmp} OWNER ${u};\n`);
    const r = await this.exec(appId, ['pg_restore', '-U', 'postgres', '--no-owner', `--role=${u}`, '--exit-on-error', '-d', tmp], dump);
    if (r.code !== 0) {
      await this.sql(appId, `DROP DATABASE IF EXISTS ${tmp};\n`).catch(() => undefined);
      throw new Error(`restore failed: ${r.err.trim()}`);
    }
    // Swap: the restored copy takes the name; the previous data is dropped only after the swap succeeded.
    await this.sql(appId, [
      `DROP DATABASE IF EXISTS ${old};`,
      // No new sessions while the old copy is renamed away (the app would otherwise reconnect in between).
      `ALTER DATABASE ${db} ALLOW_CONNECTIONS false;`,
      `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ${literal(db)};`,
      `ALTER DATABASE ${db} RENAME TO ${old};`,
      `ALTER DATABASE ${tmp} RENAME TO ${db};`,
      `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
      `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${u};`,
      `DROP DATABASE ${old} WITH (FORCE);`,
      '',
    ].join('\n'));
  }
}
