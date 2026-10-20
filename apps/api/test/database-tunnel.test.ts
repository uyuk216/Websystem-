import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { DockerDatabaseDriver, databaseNames } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { createApp } from '../src/apps/apps.js';
import { createApiToken } from '../src/apps/api-tokens.js';
import { addDatabase } from '../src/apps/databases.js';
import { handleTunnelUpgrade, startTunnel, TUNNEL_PROTOCOL } from '../src/apps/database-tunnel.js';

const available = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const envKey = randomBytes(32);
const databases = new DockerDatabaseDriver();
const rt = { envKey, databases };
const cleanup: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) s.close();
  await Promise.all(cleanup.map((id) => databases.remove(id).catch(() => undefined)));
}, 120_000);

async function setup(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  await giveStudent(db, a!.id);
  const { appId } = await createApp(db, a!.id, { name: `t-${randomUUID().slice(0, 8)}`, ownerId, kind: 'dynamic' }) as { appId: string };
  cleanup.push(appId);
  expect(await addDatabase(db, rt, a!.id, appId)).toEqual({ ok: true });
  const tok = await createApiToken(db, a!.id, 'cli') as { token: string };
  return { accountId: a!.id, appId, token: tok.token };
}

async function apiServer(db: TestDb): Promise<string> {
  const server = createServer((_q, r) => { r.statusCode = 404; r.end(); });
  server.on('upgrade', (req, socket, head) => { if (!handleTunnelUpgrade(db, rt, req, socket, head)) socket.destroy(); });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** What the CLI does per local connection: an upgraded request whose socket then speaks PostgreSQL. */
function tunnel(base: string, appId: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/apps/${appId}/database/tunnel`, { headers: { authorization: `Bearer ${token}`, connection: 'Upgrade', upgrade: TUNNEL_PROTOCOL } });
    req.on('upgrade', (_res, socket) => resolve(socket as Socket));
    req.on('response', (res) => { res.resume(); reject(new Error(String(res.statusCode))); });
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(!available)('database tunnel', { timeout: 180_000 }, () => {
  it('a temporary login works through the tunnel and acts as the app role', () => withTestDb(async (db) => {
    const s = await setup(db);
    const base = await apiServer(db);
    const login = await startTunnel(db, rt, s.accountId, s.appId);
    if ('error' in login) throw new Error(login.error);
    expect(login.user).toMatch(/^tun_[0-9a-f]{12}$/);
    expect(login.expiresAt.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const sql = postgres({ username: login.user, password: login.password, database: login.database, max: 1, socket: () => tunnel(base, s.appId, s.token) } as unknown as postgres.Options<Record<string, postgres.PostgresType>>);
    try {
      await sql`CREATE TABLE via_tunnel(x int)`;
      await sql`INSERT INTO via_tunnel VALUES (42)`;
      expect(await sql`SELECT x FROM via_tunnel`).toEqual([{ x: 42 }]);
      // Objects created through the tunnel belong to the app's role, so the app keeps full use of them.
      const [owner] = await sql`SELECT tableowner FROM pg_tables WHERE tablename = 'via_tunnel'`;
      expect(owner!.tableowner).toBe(databaseNames(s.appId).user);
    } finally {
      await sql.end();
    }
  }));

  it('refuses bad tokens, strangers and other upgrade protocols', () => withTestDb(async (db) => {
    const s = await setup(db);
    const other = await setup(db);
    const base = await apiServer(db);
    await expect(tunnel(base, s.appId, 'ysk_invalid')).rejects.toThrow('401');
    await expect(tunnel(base, s.appId, other.token)).rejects.toThrow('404');
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}/apps/${s.appId}/database/tunnel`, { headers: { authorization: `Bearer ${s.token}`, connection: 'Upgrade', upgrade: 'websocket' } });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.end();
    });
    expect(status).toBe(400);
  }));

  it('expired temporary logins are dropped and stop working', () => withTestDb(async (db) => {
    const s = await setup(db);
    const base = await apiServer(db);
    const { database, user } = databaseNames(s.appId);
    const old = await databases.createTemporaryLogin(s.appId, database, user, new Date(Date.now() - 1000));
    expect(await databases.dropExpiredLogins(s.appId)).toBe(1);
    const sql = postgres({ username: old.user, password: old.password, database, max: 1, connect_timeout: 10, socket: () => tunnel(base, s.appId, s.token) } as unknown as postgres.Options<Record<string, postgres.PostgresType>>);
    await expect(sql`SELECT 1`).rejects.toThrow();
    await sql.end();
  }));
});
