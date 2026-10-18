import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { eq } from 'drizzle-orm';
import { databaseNames, type DatabaseDriver } from 'platform';
import { withAccount, type Db } from '../db/client.js';
import { appDatabases, apps } from '../db/schema.js';
import { mayManage } from './apps.js';
import { resolveApiToken } from './api-tokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long a tunnel login works and how long one tunnelled connection may stay open. */
export const TUNNEL_LOGIN_MINUTES = 60;
const MAX_CONNECTION_MS = 60 * 60_000;
const IDLE_MS = 30 * 60_000;
/** Concurrent tunnelled connections per app (the database allows 10 connections in total). */
const MAX_PER_APP = 3;
export const TUNNEL_PROTOCOL = 'ys-db-tunnel';

type Drivers = { databases?: DatabaseDriver };
type TunnelError = 'not_found' | 'forbidden' | 'no_database' | 'unavailable';

async function check(db: Db, accountId: string, appId: string): Promise<{ ok: true } | { error: TunnelError }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    const [d] = await tx.select({ status: appDatabases.status }).from(appDatabases).where(eq(appDatabases.appId, appId));
    return d?.status === 'ready' ? { ok: true as const } : { error: 'no_database' as const };
  });
}

/**
 * Issues a temporary login for the owner's tunnel (shown once; the app's own password is never revealed).
 * Expired logins are dropped by the database watch.
 */
export async function startTunnel(db: Db, rt: Drivers | undefined, accountId: string, appId: string, now = new Date()): Promise<
  { user: string; password: string; database: string; expiresAt: Date } | { error: TunnelError }
> {
  const c = await check(db, accountId, appId);
  if ('error' in c) return c;
  if (!rt?.databases) return { error: 'unavailable' };
  const { database, user } = databaseNames(appId);
  const expiresAt = new Date(now.getTime() + TUNNEL_LOGIN_MINUTES * 60_000);
  await rt.databases.dropExpiredLogins(appId).catch(() => 0);
  const login = await rt.databases.createTemporaryLogin(appId, database, user, expiresAt);
  return { ...login, database, expiresAt };
}

const open = new Map<string, number>();

/**
 * `GET /apps/:id/database/tunnel` with `Upgrade: ys-db-tunnel` and an API token: after the 101 response the socket
 * carries raw PostgreSQL traffic to the app's database (the client still has to log in with a tunnel login).
 * Returns false when the path is not a tunnel request, so other upgrade handlers can run.
 */
export function handleTunnelUpgrade(db: Db, rt: Drivers | undefined, req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const m = /^\/apps\/([^/]+)\/database\/tunnel$/.exec((req.url ?? '').split('?')[0]!);
  if (!m) return false;
  const reply = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  void (async () => {
    if (String(req.headers.upgrade ?? '').toLowerCase() !== TUNNEL_PROTOCOL) return reply('400 Bad Request');
    const auth = req.headers.authorization ?? '';
    const t = /^Bearer /i.test(auth) ? await resolveApiToken(db, auth.slice(7).trim()) : null;
    if (!t) return reply('401 Unauthorized');
    const appId = m[1]!;
    const c = await check(db, t.accountId, appId);
    if ('error' in c) return reply(c.error === 'forbidden' ? '403 Forbidden' : c.error === 'no_database' ? '409 Conflict' : '404 Not Found');
    if (!rt?.databases) return reply('503 Service Unavailable');
    if ((open.get(appId) ?? 0) >= MAX_PER_APP) return reply('429 Too Many Requests');
    open.set(appId, (open.get(appId) ?? 0) + 1);
    let released = false;
    const release = () => { if (!released) { released = true; open.set(appId, (open.get(appId) ?? 1) - 1); } };
    let upstream: Duplex;
    try { upstream = await rt.databases.connect(appId); } catch (e) { release(); console.error('tunnel connect failed', appId, e); return reply('502 Bad Gateway'); }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${TUNNEL_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`);
    if (head.length) upstream.write(head);
    const end = () => { release(); clearTimeout(cap); socket.destroy(); upstream.destroy(); };
    const cap = setTimeout(end, MAX_CONNECTION_MS);
    (socket as Duplex & { setTimeout?: (ms: number, cb: () => void) => void }).setTimeout?.(IDLE_MS, end);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on('close', end);
    socket.on('error', end);
    upstream.on('close', end);
    upstream.on('error', end);
  })().catch((e: unknown) => { console.error('tunnel failed', e); socket.destroy(); });
  return true;
}
