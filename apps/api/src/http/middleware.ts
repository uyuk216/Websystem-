import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from '../db/client.js';
import { resolveSession } from '../auth/sessions.js';

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

export function requireSession(db: Db): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const s = token ? await resolveSession(db, token) : null;
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    c.set('accountId', s.accountId);
    c.set('sessionId', s.sessionId);
    await next();
  };
}

/** In-memory fixed-window limiter (phase 1). `key` derives the bucket from the request. */
export function rateLimit(key: (c: Context) => string, max: number, windowSec: number): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const k = key(c);
    const e = hits.get(k) ?? { count: 0, resetAt: now + windowSec * 1000 };
    e.count++;
    hits.set(k, e);
    if (e.count > max) {
      c.header('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  };
}
