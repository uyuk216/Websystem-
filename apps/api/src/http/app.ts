import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { requestRecovery, type RecoveryRequestConfig } from '../auth/recovery.js';
import { startEmailChallenge, verifyEmailCode } from '../auth/email-login.js';
import { registerAccount } from '../auth/accounts.js';
import { createSession } from '../auth/sessions.js';
import { randomBytes } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { Locale } from 'i18n';
import { rateLimit, setSessionCookie } from './middleware.js';

export const DEVICE_COOKIE = 'did';
const asLocale = (v: unknown): Locale => (v === 'en' ? 'en' : 'ja');
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const deviceLabel = (c: Context): string => (c.req.header('user-agent') ?? 'unknown').slice(0, 100);

export interface AppDeps {
  db: Db;
  mailer: Mailer;
  config: RecoveryRequestConfig & { emailEncKey: Buffer; appOrigin: string };
  trustedProxyHops?: number;
}

/** Client IP: the socket address, or with N trusted proxy hops the Nth X-Forwarded-For entry from the right. */
export function resolveClientIp(xff: string | undefined, socketAddr: string | undefined, hops: number): string {
  if (hops > 0 && xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    const hit = parts[parts.length - hops];
    if (hit) return hit;
  }
  return socketAddr || 'unknown';
}

declare module 'hono' {
  interface ContextVariableMap {
    deviceId: string;
  }
}

export function createApp(deps?: AppDeps): Hono {
  const hops = deps?.trustedProxyHops ?? 0;
  const clientIp = (c: Context): string => {
    let addr: string | undefined;
    try {
      addr = getConnInfo(c).remote.address;
    } catch {
      addr = undefined; // no socket (e.g. app.request in tests)
    }
    return resolveClientIp(c.req.header('x-forwarded-for'), addr, hops);
  };
  const app = new Hono();
  // Per-browser device id; requesterDeviceId for email challenges comes from it.
  app.use('*', async (c, next) => {
    let id = getCookie(c, DEVICE_COOKIE);
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
      id = randomBytes(32).toString('base64url');
      setCookie(c, DEVICE_COOKIE, id, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 365 * 86400 });
    }
    c.set('deviceId', id);
    await next();
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  if (deps) {
    app.post('/auth/recovery/request', rateLimit(clientIp, 10, 3600), async (c) => {
      const body = await c.req.json().catch(() => null) as { email?: unknown; recoveryCode?: unknown } | null;
      if (typeof body?.email !== 'string' || typeof body.recoveryCode !== 'string' || body.email.length > 320 || body.recoveryCode.length > 200) {
        return c.json({ error: 'invalid' }, 400);
      }
      const r = await requestRecovery(deps.db, deps.mailer, { email: body.email, recoveryCode: body.recoveryCode }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, r.error === 'rate_limited' ? 429 : 400);
      // The request ID is intentionally not returned: the user only learns that the request was received.
      return c.json({ ok: true });
    });
    const ipLimit = rateLimit(clientIp, 20, 600);
    app.post('/auth/email/start', ipLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.email, 320) || (b.purpose !== 'login' && b.purpose !== 'signup')) return c.json({ error: 'invalid' }, 400);
      const r = await startEmailChallenge(deps.db, deps.mailer, {
        email: b.email, purpose: b.purpose, locale: asLocale(b.locale), requesterDeviceId: c.get('deviceId'),
      }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, 429);
      return c.json({ challengeId: r.challengeId });
    });
    app.post('/auth/email/verify', ipLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || !str(b.code, 16)) return c.json({ error: 'invalid' }, 400);
      const r = await verifyEmailCode(deps.db, b.challengeId, b.code, c.get('deviceId'));
      if ('error' in r) return c.json({ error: r.error }, r.error === 'locked' ? 429 : 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      return c.json({ ok: true });
    });
    app.post('/auth/signup', ipLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || !str(b.code, 16) || !str(b.email, 320) || !str(b.displayName, 100) || !str(b.birthDate, 10)) {
        return c.json({ error: 'invalid' }, 400);
      }
      const r = await registerAccount(deps.db, {
        challengeId: b.challengeId, code: b.code, email: b.email, displayName: b.displayName.trim(), birthDate: b.birthDate, locale: asLocale(b.locale),
      }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, r.error === 'exists' ? 409 : 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      return c.json({ ok: true, recoveryCode: r.recoveryCode });
    });
  }
  return app;
}
