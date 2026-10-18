import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer, type Server, type Socket } from 'node:net';

export const TUNNEL_PROTOCOL = 'ys-db-tunnel';

export interface TunnelLogin { user: string; password: string; database: string; expiresAt: string }

/** Asks the API for a temporary login (shown once, valid for an hour). */
export async function startTunnelLogin(o: { api: string; token: string; appId: string; fetch?: typeof fetch }): Promise<TunnelLogin> {
  const res = await (o.fetch ?? fetch)(`${o.api.replace(/\/+$/, '')}/apps/${o.appId}/database/tunnel`, { method: 'POST', headers: { authorization: `Bearer ${o.token}` } });
  const body = await res.json().catch(() => ({})) as Partial<TunnelLogin> & { error?: string };
  if (res.status === 409) throw new Error('This app has no database. Add one on the app page first.');
  if (!res.ok || !body.user || !body.password || !body.database || !body.expiresAt) throw new Error(`Could not open a tunnel: ${body.error ?? res.status}`);
  return body as TunnelLogin;
}

/** Opens one upgraded connection to the API and returns its socket (raw PostgreSQL traffic after the 101). */
export function openTunnelSocket(api: string, token: string, appId: string): Promise<Socket> {
  const u = new URL(`${api.replace(/\/+$/, '')}/apps/${appId}/database/tunnel`);
  const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
    method: 'GET', headers: { authorization: `Bearer ${token}`, connection: 'Upgrade', upgrade: TUNNEL_PROTOCOL },
  });
  return new Promise((resolve, reject) => {
    req.on('upgrade', (_res, socket, head) => { if (head.length) socket.unshift(head); resolve(socket as Socket); });
    req.on('response', (res) => { res.resume(); reject(new Error(`Tunnel refused (${res.statusCode})`)); });
    req.on('error', reject);
    req.end();
  });
}

/** Listens on 127.0.0.1:`port` (0 = any free port); every local connection gets its own tunnelled connection. */
export function listenTunnel(o: { api: string; token: string; appId: string; port: number; onError?: (e: Error) => void }): Promise<Server> {
  const server = createServer((local) => {
    local.pause();
    openTunnelSocket(o.api, o.token, o.appId).then((remote) => {
      local.pipe(remote);
      remote.pipe(local);
      local.resume();
      const end = () => { local.destroy(); remote.destroy(); };
      local.on('close', end); local.on('error', end);
      remote.on('close', end); remote.on('error', end);
    }, (e: Error) => { o.onError?.(e); local.destroy(); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => resolve(server));
  });
}
