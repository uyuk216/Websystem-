import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { assertUuid } from '../runtime/driver.js';
import type { DatabaseDriver, DatabaseEndpoint, DatabaseSpec, DatabaseStatus } from './driver.js';
import { PostgresAdmin, type ExecResult } from './postgres-admin.js';

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

/**
 * Development driver: one postgres container per app on an internal per-app network. Administration goes through
 * `docker exec` over the container's local socket; the superuser has a random password nobody keeps, and no port is
 * published on the host.
 */
export class DockerDatabaseDriver extends PostgresAdmin implements DatabaseDriver {
  private readonly bin: string;
  private readonly image: string;
  private readonly readyTimeoutMs: number;

  constructor(o: DockerDatabaseOptions = {}) {
    super();
    this.bin = o.docker ?? 'docker';
    this.image = o.image ?? (process.env.DB_IMAGE || DB_IMAGE);
    this.readyTimeoutMs = o.readyTimeoutMs ?? 60_000;
  }

  private run(args: string[], stdin?: string | Readable): Promise<ExecResult> {
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

  protected exec(appId: string, cmd: string[], stdin?: string | Readable): Promise<ExecResult> {
    return this.run(['exec', ...(stdin === undefined ? [] : ['-i']), containerFor(appId), ...cmd], stdin);
  }

  protected async execStream(appId: string, cmd: string[]): Promise<Readable> {
    const out = new PassThrough();
    const p = spawn(this.bin, ['exec', containerFor(appId), ...cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => { if (err.length < 4096) err += c.toString(); });
    p.stdout.pipe(out, { end: false });
    p.on('error', (e) => out.destroy(e));
    p.on('close', (code) => { if (code === 0) out.end(); else out.destroy(new Error(`${cmd[0]} failed: ${err.trim()}`)); });
    return out;
  }

  async create(spec: DatabaseSpec): Promise<void> {
    const name = containerFor(spec.appId);
    assertUuid(spec.ownerId, 'ownerId');
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
    await this.ensureRoleAndDatabase(spec);
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

  async endpoint(appId: string): Promise<DatabaseEndpoint> {
    return { host: containerFor(appId), port: 5432, network: databaseNetwork(appId) };
  }
}
