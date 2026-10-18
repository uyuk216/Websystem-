import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { assertUuid } from '../runtime/driver.js';
import type { DatabaseDriver, DatabaseEndpoint, DatabaseSpec, DatabaseStatus, DatabaseWriteMode } from './driver.js';

export const DB_IMAGE = 'postgres:16-alpine';

export interface DockerDatabaseOptions {
  docker?: string;
  image?: string;
  /** How long create() waits for the server to accept connections. */
  readyTimeoutMs?: number;
}

const containerFor = (appId: string): string => { assertUuid(appId, 'appId'); return `ys-db-${appId}`; };
/** Internal network shared only by this app's containers and its database (no route out, no other apps). */
export const databaseNetwork = (appId: string): string => { assertUuid(appId, 'appId'); return `ys-dbnet-${appId.replace(/-/g, '').slice(0, 12)}`; };
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const ident = (s: string): string => { if (!IDENT.test(s)) throw new Error(`invalid identifier: ${s}`); return s; };
const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;

interface RunResult { code: number | null; out: string; err: string }

/**
 * Development driver: one postgres container per app on an internal per-app network. Administration goes through
 * `docker exec` over the container's local socket; the superuser has a random password nobody keeps, and no port is
 * published on the host.
 */
export class DockerDatabaseDriver implements DatabaseDriver {
  private readonly bin: string;
  private readonly image: string;
  private readonly readyTimeoutMs: number;

  constructor(o: DockerDatabaseOptions = {}) {
    this.bin = o.docker ?? 'docker';
    this.image = o.image ?? (process.env.DB_IMAGE || DB_IMAGE);
    this.readyTimeoutMs = o.readyTimeoutMs ?? 60_000;
  }

  private run(args: string[], stdin?: string | Readable): Promise<RunResult> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, args, { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout!.on('data', (c: Buffer) => { if (out.length < 1 << 20) out += c.toString(); });
      p.stderr!.on('data', (c: Buffer) => { if (err.length < 1 << 16) err += c.toString(); });
      p.on('error', (e) => { err += String(e); });
      p.on('close', (code) => resolve({ code, out, err }));
      if (typeof stdin === 'string') p.stdin!.end(stdin);
      else if (stdin) stdin.on('error', () => p.stdin!.destroy()).pipe(p.stdin!);
    });
  }

  private async must(args: string[], what: string, stdin?: string | Readable): Promise<string> {
    const r = await this.run(args, stdin);
    if (r.code !== 0) throw new Error(`${what} failed: ${r.err.trim() || r.out.trim()}`);
    return r.out;
  }

  /** Runs SQL as the superuser over the local socket. `db` defaults to postgres. */
  private sql(appId: string, sql: string, db = 'postgres'): Promise<string> {
    return this.must(['exec', '-i', containerFor(appId), 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qtA'], 'psql', sql);
  }

  async create(spec: DatabaseSpec): Promise<void> {
    const name = containerFor(spec.appId);
    assertUuid(spec.ownerId, 'ownerId');
    const db = ident(spec.database);
    const user = ident(spec.user);
    const net = databaseNetwork(spec.appId);
    const labels = ['--label', `ys.db=${spec.appId}`, '--label', `ys.owner=${spec.ownerId}`];
    if ((await this.run(['network', 'inspect', net])).code !== 0) {
      const r = await this.run(['network', 'create', '--internal', ...labels, net]);
      if (r.code !== 0 && !/already exists/.test(r.err)) throw new Error(`network create failed: ${r.err.trim()}`);
    }
    const state = await this.status(spec.appId);
    if (state === 'missing') {
      await this.must(['volume', 'create', ...labels, name], 'volume create');
      const r = await this.run([
        'run', '-d', '--name', name, ...labels, '--network', net,
        '--memory', `${spec.limits.memoryMb}m`, '--memory-swap', `${spec.limits.memoryMb}m`, '--pids-limit', '256',
        '--security-opt', 'no-new-privileges', '--restart', 'no',
        '-e', `POSTGRES_PASSWORD=${randomBytes(24).toString('base64url')}`,
        '-v', `${name}:/var/lib/postgresql/data`, this.image,
      ]);
      if (r.code !== 0 && !/already in use/.test(r.err)) throw new Error(`database start failed: ${r.err.trim()}`);
    } else if (state === 'stopped') {
      await this.must(['start', name], 'database start');
    }
    await this.waitReady(spec.appId);
    await this.sql(spec.appId, [
      `DO $$BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(user)}) THEN
          CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(spec.password)} CONNECTION LIMIT ${Math.trunc(spec.limits.connections)};
        ELSE
          ALTER ROLE ${user} PASSWORD ${literal(spec.password)} CONNECTION LIMIT ${Math.trunc(spec.limits.connections)};
        END IF;
      END$$;`,
      `SELECT 'CREATE DATABASE ${db} OWNER ${user}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${literal(db)})\\gexec`,
      `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
      `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${user};`,
      '',
    ].join('\n'));
  }

  private async waitReady(appId: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    // The image's init runs a socket-only temporary server; TCP readiness means the real server is up.
    for (;;) {
      const r = await this.run(['exec', containerFor(appId), 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-q']);
      if (r.code === 0) return;
      if (Date.now() > deadline) throw new Error('database did not become ready in time');
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  async remove(appId: string): Promise<void> {
    const name = containerFor(appId);
    const net = databaseNetwork(appId);
    await this.run(['rm', '-f', '-v', name]);
    await this.run(['volume', 'rm', '-f', name]);
    // App containers still attached (a running app) are disconnected so the network can go.
    const attached = (await this.run(['network', 'inspect', '-f', '{{range $k, $v := .Containers}}{{$k}} {{end}}', net])).out.trim();
    for (const id of attached.split(/\s+/).filter(Boolean)) await this.run(['network', 'disconnect', '-f', net, id]);
    await this.run(['network', 'rm', net]);
  }

  async status(appId: string): Promise<DatabaseStatus> {
    const r = await this.run(['inspect', '-f', '{{.State.Status}}', containerFor(appId)]);
    if (r.code !== 0) return 'missing';
    const s = r.out.trim();
    if (s === 'running') {
      const ready = await this.run(['exec', containerFor(appId), 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-q']);
      return ready.code === 0 ? 'running' : 'starting';
    }
    return s === 'created' || s === 'restarting' ? 'starting' : 'stopped';
  }

  endpoint(appId: string): DatabaseEndpoint {
    return { host: containerFor(appId), port: 5432, network: databaseNetwork(appId) };
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
    const db = ident(database);
    const out = new PassThrough();
    const p = spawn(this.bin, ['exec', containerFor(appId), 'pg_dump', '-U', 'postgres', '-Fc', '--no-owner', db], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => { if (err.length < 4096) err += c.toString(); });
    p.stdout.pipe(out, { end: false });
    p.on('error', (e) => out.destroy(e));
    p.on('close', (code) => { if (code === 0) out.end(); else out.destroy(new Error(`pg_dump failed: ${err.trim()}`)); });
    return out;
  }

  async restore(appId: string, database: string, user: string, dump: Readable): Promise<void> {
    const db = ident(database);
    const u = ident(user);
    const tmp = ident(`${db}_restore`);
    const old = ident(`${db}_old`);
    await this.sql(appId, `DROP DATABASE IF EXISTS ${tmp};\nCREATE DATABASE ${tmp} OWNER ${u};\n`);
    const r = await this.run(['exec', '-i', containerFor(appId), 'pg_restore', '-U', 'postgres', '--no-owner', `--role=${u}`, '--exit-on-error', '-d', tmp], dump);
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
