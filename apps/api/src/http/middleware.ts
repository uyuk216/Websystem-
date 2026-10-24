import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db/client.js';
import { resolveSession } from '../auth/sessions.js';
import { resolveApiToken } from '../apps/api-tokens.js';

declare module 'hono' {
  interface ContextVariableMap {
    accountId: string;
    sessionId: string;
  }
}

export const SESSION_COOKIE = 'sid';
const cookieOpts = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...cookieOpts, maxAge: 30 * 86400 });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

const MAX_BUCKETS = 10_000;

/**
 * Resolves the account from the session cookie or, unless `bearer: false`, from `Authorization: Bearer ysk_...`.
 * Bearer requests get sessionId '' (they have no session). Routes that manage credentials must pass `bearer: false`.
 */
export function requireSession(db: Db, opts: { bearer?: boolean; clientIp?: (c: Context) => string; maxFailures?: number; accountBlocked?: (accountId: string) => Promise<boolean> } = {}): MiddlewareHandler {
  /** セキュリティ上のアカウント遮断中は、変更（GET / HEAD 以外）だけ止める。状態の閲覧は続けられる。判定できなければ 503。 */
  const gateAccount = async (c: Context, accountId: string): Promise<Response | null> => {
    if (!opts.accountBlocked || c.req.method === 'GET' || c.req.method === 'HEAD') return null;
    try {
      return (await opts.accountBlocked(accountId)) ? c.json({ error: 'security_blocked' }, 403) : null;
    } catch (e) {
      console.error('account security gate failed', e);
      return c.json({ error: 'unavailable' }, 503);
    }
  };
  const bearer = opts.bearer ?? true;
  // Failed Bearer attempts per client IP (default 30 per 10 minutes) before answering 429.
  const failed = new Map<string, { count: number; resetAt: number }>();
  const max = opts.maxFailures ?? 30;
  return async (c, next) => {
    const auth = c.req.header('authorization');
    if (bearer && auth && /^Bearer /i.test(auth)) {
      const ip = opts.clientIp?.(c) ?? 'unknown';
      const now = Date.now();
      let f = failed.get(ip);
      if (f && f.resetAt <= now) { failed.delete(ip); f = undefined; }
      if (f && f.count >= max) {
        c.header('Retry-After', String(Math.ceil((f.resetAt - now) / 1000)));
        return c.json({ error: 'rate_limited' }, 429);
      }
      const t = await resolveApiToken(db, auth.slice(7).trim());
      if (!t) {
        if (!f) {
          if (failed.size >= MAX_BUCKETS) for (const [k, v] of failed) if (v.resetAt <= now) failed.delete(k);
          if (failed.size < MAX_BUCKETS) { f = { count: 0, resetAt: now + 600_000 }; failed.set(ip, f); }
        }
        if (f) f.count++;
        return c.json({ error: 'unauthorized' }, 401);
      }
      const denied = await gateAccount(c, t.accountId);
      if (denied) return denied;
      c.set('accountId', t.accountId);
      c.set('sessionId', '');
      return next();
    }
    const token = getCookie(c, SESSION_COOKIE);
    const s = token ? await resolveSession(db, token) : null;
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    const denied = await gateAccount(c, s.accountId);
    if (denied) return denied;
    c.set('accountId', s.accountId);
    c.set('sessionId', s.sessionId);
    await next();
  };
}


/** In-memory fixed-window limiter (phase 1). `key` derives the bucket from the request. */
export function rateLimit(key: (c: Context) => string, max: number, windowSec: number, maxBuckets = MAX_BUCKETS, onSweep?: () => void): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;
  const sweep = (now: number): void => {
    onSweep?.();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    nextSweep = now + windowSec * 1000;
  };
  return async (c, next) => {
    const now = Date.now();
    if (now >= nextSweep) sweep(now);
    const k = key(c);
    let e = hits.get(k);
    if (e && e.resetAt <= now) {
      hits.delete(k);
      e = undefined;
    }
    if (!e) {
      if (hits.size >= maxBuckets && now >= nextSweep) sweep(now);
      if (hits.size >= maxBuckets) {
        c.header('Retry-After', String(windowSec));
        return c.json({ error: 'rate_limited' }, 429);
      }
      e = { count: 0, resetAt: now + windowSec * 1000 };
      hits.set(k, e);
    }
    e.count++;
    if (e.count > max) {
      c.header('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  };
}
