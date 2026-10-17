import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { Transform } from 'node:stream';
import type { Socket } from 'node:net';

export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 5_000;
export const IDLE_TIMEOUT_MS = 60_000;

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade']);
/** Identifying headers the edge sets itself: whatever the client sent is dropped. */
const EDGE_OWNED = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded', 'x-real-ip']);

export interface ProxyTarget { host: string; port: number }
/**
 * The visitor's address. With `hops` trusted proxies in front of the edge (e.g. the cluster ingress), it is the
 * hops-th entry from the right of X-Forwarded-For; with 0 (nothing in front) only the socket address is trusted.
 */
export function clientAddress(xff: string | string[] | undefined, socketAddr: string | undefined, hops: number): string {
  const header = Array.isArray(xff) ? xff.join(',') : xff;
  if (hops > 0 && header) {
    const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
    const hit = parts[parts.length - hops];
    if (hit) return hit;
  }
  return socketAddr ?? '';
}

export interface ProxyOptions {
  /** Protocol the public edge speaks to clients (sent as X-Forwarded-Proto). */
  proto: 'http' | 'https';
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxBodyBytes?: number;
  /** Aborted when the client goes away: the upstream request is dropped. */
  signal?: AbortSignal;
  /** Called with every byte of the response (or upgraded stream) that is sent to the client. */
  onBytes: (n: number) => void;
  /** Visitor address sent to the app as X-Forwarded-For (default: the socket address). */
  clientIp?: string;
}

export type ProxyFailure = 'too_large' | 'connect' | 'timeout' | 'upstream';
export interface ProxyResult {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function connectionTokens(h: IncomingHttpHeaders): Set<string> {
  const v = h.connection;
  const s = new Set<string>();
  for (const part of (Array.isArray(v) ? v.join(',') : v ?? '').split(',')) {
    const t = part.trim().toLowerCase();
    if (t) s.add(t);
  }
  return s;
}

/** Request headers for the app: hop-by-hop and client-supplied forwarding headers removed, Host kept. */
export function forwardHeaders(req: IncomingHttpHeaders, remoteAddress: string | undefined, proto: 'http' | 'https', upgrade: boolean): OutgoingHttpHeaders {
  const drop = connectionTokens(req);
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req)) {
    if (v === undefined || HOP_BY_HOP.has(k) || EDGE_OWNED.has(k) || drop.has(k)) continue;
    out[k] = v;
  }
  const host = req.host ?? '';
  out['x-forwarded-for'] = remoteAddress ?? '';
  out['x-forwarded-proto'] = proto;
  out['x-forwarded-host'] = host;
  if (upgrade) {
    // Only WebSocket is tunnelled (callers check); anything else is never forwarded as an upgrade.
    out.connection = 'Upgrade';
    out.upgrade = 'websocket';
  } else {
    out.connection = 'close';
  }
  return out;
}

function stripResponseHeaders(h: IncomingHttpHeaders): Headers {
  const drop = connectionTokens(h);
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP_BY_HOP.has(k) || drop.has(k)) continue;
    if (Array.isArray(v)) for (const x of v) out.append(k, x);
    else out.set(k, v);
  }
  return out;
}

/** Connect timeout: the socket must connect within `ms`; afterwards only the idle timeout applies. */
function guardConnect(req: ReturnType<typeof httpRequest>, ms: number, fail: (e: ProxyFailure) => void): void {
  req.once('socket', (socket) => {
    if (!socket.connecting) return;
    const t = setTimeout(() => fail('connect'), ms);
    socket.once('connect', () => clearTimeout(t));
    socket.once('close', () => clearTimeout(t));
  });
}

/**
 * Streams the request to `target` (never anything else: the caller passes the driver's endpoint) and resolves
 * with the response head and a streaming body. The request body is capped; the response body is counted.
 */
export function proxyRequest(
  incoming: Pick<IncomingMessage, 'method' | 'url' | 'headers' | 'socket'> & NodeJS.ReadableStream,
  target: ProxyTarget,
  opts: ProxyOptions,
): Promise<ProxyResult> {
  const max = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const declared = Number(incoming.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) return Promise.reject<ProxyResult>('too_large' satisfies ProxyFailure);
  return new Promise<ProxyResult>((resolve, reject) => {
    let done = false;
    const upstream = httpRequest({
      host: target.host, port: target.port, method: incoming.method, path: incoming.url,
      headers: forwardHeaders(incoming.headers, opts.clientIp ?? incoming.socket.remoteAddress, opts.proto, false),
      agent: false,
    });
    const fail = (why: ProxyFailure) => {
      if (done) return;
      done = true;
      upstream.destroy();
      (incoming as unknown as { unpipe?: () => void }).unpipe?.();
      reject(why);
    };
    guardConnect(upstream, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, fail);
    upstream.setTimeout(opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => fail('timeout'));
    upstream.on('error', () => fail('upstream'));
    if (opts.signal?.aborted) return fail('upstream');
    opts.signal?.addEventListener('abort', () => fail('upstream'), { once: true });
    upstream.on('response', (res) => {
      if (done) return res.destroy();
      done = true;
      res.setTimeout(opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => res.destroy(new Error('idle timeout')));
      const it = res[Symbol.asyncIterator]();
      const body = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const r = await it.next();
            if (r.done) return ctrl.close();
            const chunk = r.value as Uint8Array;
            opts.onBytes(chunk.byteLength);
            ctrl.enqueue(chunk);
          } catch (e) {
            ctrl.error(e);
          }
        },
        cancel() {
          res.destroy();
          upstream.destroy();
        },
      });
      const noBody = incoming.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
      if (noBody) res.resume();
      resolve({ status: res.statusCode ?? 502, headers: stripResponseHeaders(res.headers), body: noBody ? null : body });
    });
    let seen = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > max) {
          fail('too_large');
          upstream.destroy();
          return cb();
        }
        cb(null, chunk);
      },
    });
    incoming.pipe(counter).pipe(upstream);
    incoming.on('error', () => fail('upstream'));
  });
}

/**
 * WebSocket (any HTTP Upgrade) tunnel to `target`. Resolves true when the upgrade was accepted and bytes are
 * flowing, false when the app refused (the refusal status line is relayed). Rejects on connect failure.
 */
export function proxyUpgrade(
  incoming: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
  opts: ProxyOptions,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const upstream = httpRequest({
      host: target.host, port: target.port, method: incoming.method, path: incoming.url,
      headers: forwardHeaders(incoming.headers, opts.clientIp ?? incoming.socket.remoteAddress, opts.proto, true),
      agent: false,
    });
    const fail = (why: ProxyFailure) => {
      if (settled) return;
      settled = true;
      upstream.destroy();
      reject(why);
    };
    guardConnect(upstream, opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, fail);
    upstream.setTimeout(opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => fail('timeout'));
    upstream.on('error', () => fail('upstream'));
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('response', (res) => {
      // The app answered without upgrading: relay the refusal and close.
      if (settled) return res.destroy();
      settled = true;
      let text = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n`;
      const h = stripResponseHeaders(res.headers);
      h.forEach((v, k) => { text += `${k}: ${v}\r\n`; });
      socket.write(`${text}Connection: close\r\n\r\n`);
      res.on('data', (c: Buffer) => { opts.onBytes(c.length); socket.write(c); });
      res.on('end', () => socket.end());
      resolve(false);
    });
    upstream.on('upgrade', (res, upSocket, upHead) => {
      if (settled) return upSocket.destroy();
      settled = true;
      upSocket.setTimeout(0);
      (socket as Socket).setTimeout?.(0);
      upSocket.on('error', () => socket.destroy());
      upSocket.on('close', () => socket.destroy());
      // Upgrade/Connection must reach the client for the handshake to complete.
      let text = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? 'Switching Protocols'}\r\n`;
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        for (const x of Array.isArray(v) ? v : [v]) text += `${k}: ${x}\r\n`;
      }
      const headBytes = Buffer.from(`${text}\r\n`);
      opts.onBytes(headBytes.length + upHead.length);
      socket.write(headBytes);
      if (upHead.length) socket.write(upHead);
      upSocket.on('data', (c: Buffer) => opts.onBytes(c.length));
      if (head.length) socket.unshift(head); // client bytes that arrived with the handshake
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      resolve(true);
    });
    upstream.end();
  });
}
