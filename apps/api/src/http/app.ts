import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { requestRecovery, type RecoveryRequestConfig } from '../auth/recovery.js';
import { startEmailChallenge, verifyEmailCode } from '../auth/email-login.js';
import { openEmailLink, getRequesterScreen, getConfirmChoices, confirmNumber, completeCrossDeviceLogin } from '../auth/cross-device.js';
import { registerAccount } from '../auth/accounts.js';
import { createSession } from '../auth/sessions.js';
import { randomBytes } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { Locale } from 'i18n';
import { rateLimit, setSessionCookie } from './middleware.js';

export const DEVICE_COOKIE = 'did';
const asLocale = (v: unknown): Locale => (v === 'en' ? 'en' : 'ja');
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
/** Coarse "OS / Browser" label from the User-Agent. */
export function coarseDeviceLabel(ua: string | undefined): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  return os && br ? `${os} / ${br}` : os ?? br ?? 'Unknown device';
}
const deviceLabel = (c: Context): string => coarseDeviceLabel(c.req.header('user-agent'));

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
    const startLimit = rateLimit(clientIp, 20, 600);
    const attemptLimit = rateLimit(clientIp, 60, 600);
    app.post('/auth/email/start', startLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.email, 320) || (b.purpose !== 'login' && b.purpose !== 'signup')) return c.json({ error: 'invalid' }, 400);
      const r = await startEmailChallenge(deps.db, deps.mailer, {
        email: b.email, purpose: b.purpose, locale: asLocale(b.locale), requesterDeviceId: c.get('deviceId'), requesterDeviceLabel: coarseDeviceLabel(c.req.header('user-agent')),
      }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, 429);
      return c.json({ challengeId: r.challengeId });
    });
    app.post('/auth/email/verify', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || !str(b.code, 16)) return c.json({ error: 'invalid' }, 400);
      const r = await verifyEmailCode(deps.db, b.challengeId, b.code, c.get('deviceId'));
      if ('error' in r) return c.json({ error: r.error }, r.error === 'locked' ? 429 : 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      return c.json({ ok: true });
    });
    // POST (not GET): opening the link changes state, and mail scanners prefetch GET links.
    app.post('/auth/email/link', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      const cid = b?.c;
      const tok = b?.t;
      if (!str(cid, 64) || !str(tok, 200)) return c.json({ error: 'invalid' }, 400);
      const r = await openEmailLink(deps.db, cid, tok, c.get('deviceId'));
      if ('error' in r) return c.json({ error: r.error }, 400);
      if (r.result === 'logged_in') {
        const s = await createSession(deps.db, r.accountId, deviceLabel(c));
        setSessionCookie(c, s.token);
        return c.json({ result: 'logged_in' });
      }
      return c.json({ result: 'cross_device_pending' });
    });
    app.get('/auth/email/screen', attemptLimit, async (c) => {
      const cid = c.req.query('c');
      if (!str(cid, 64)) return c.json({ state: 'none' });
      return c.json(await getRequesterScreen(deps.db, cid, c.get('deviceId'), deps.config.appOrigin));
    });
    app.get('/auth/email/confirm', attemptLimit, async (c) => {
      const cid = c.req.query('c');
      const s = c.req.query('s');
      if (!str(cid, 64) || !str(s, 200)) return c.json({ error: 'invalid' }, 400);
      const r = await getConfirmChoices(deps.db, cid, s);
      return 'error' in r ? c.json(r, 400) : c.json(r);
    });
    app.post('/auth/email/confirm', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || !str(b.scanToken, 200) || typeof b.chosen !== 'number') return c.json({ error: 'invalid' }, 400);
      const r = await confirmNumber(deps.db, b.challengeId, b.scanToken, b.chosen);
      return 'error' in r ? c.json(r, 400) : c.json(r);
    });
    app.post('/auth/email/complete', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64)) return c.json({ error: 'invalid' }, 400);
      const r = await completeCrossDeviceLogin(deps.db, b.challengeId, c.get('deviceId'));
      if ('error' in r) return c.json({ error: r.error }, 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      return c.json({ ok: true });
    });
    app.post('/auth/signup', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || !str(b.code, 16) || !str(b.email, 320) || !str(b.displayName, 100) || !str(b.birthDate, 10)) {
        return c.json({ error: 'invalid' }, 400);
      }
      const r = await registerAccount(deps.db, {
        challengeId: b.challengeId, code: b.code, email: b.email, requesterDeviceId: c.get('deviceId'), displayName: b.displayName.trim(), birthDate: b.birthDate, locale: asLocale(b.locale),
      }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, r.error === 'exists' ? 409 : 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      return c.json({ ok: true, recoveryCode: r.recoveryCode });
    });
  }
  return app;
}
