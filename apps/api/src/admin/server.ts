import { isLimitSettingKey, validLimitValue } from 'shared';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sql } from 'drizzle-orm';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { finishPasskeyLogin, startPasskeyLogin, type PasskeyConfig } from '../auth/passkeys.js';
import { UUID } from '../auth/cross-device.js';
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MS, createAdminSession, resolveAdminSession, revokeAdminSession } from './admin-session.js';
import { listAudit, verifyAuditChain, withAdmin } from './audit-log.js';
import { cancelDangerous, listDangerous, scheduleDangerous, type DangerousHandlers } from './dangerous.js';
import { findOperatorByLogin, getOperator, type Operator } from './operators.js';
import { sourceAllowed, type TailscalePolicy } from './tailscale.js';
import { platformSettings } from '../db/schema.js';

export interface AdminDeps {
  db: Db;
  mailer: Mailer;
  emailEncKey: Buffer;
  /** WebAuthn: rpId plus the admin UI origin (not the public app origin). */
  passkey: PasskeyConfig;
  tailscale: TailscalePolicy;
  /** Cookie `Secure` flag; false only for plain-http local development. */
  secureCookie?: boolean;
  handlers?: DangerousHandlers;
}

declare module 'hono' {
  interface ContextVariableMap {
    operator: Operator;
  }
}

/** Example registry for the 24-hour booking framework. Real freeze/unfreeze lands with the usage state machine (task 7). */
export const defaultDangerousHandlers: DangerousHandlers = {
  unfreeze_account: async (tx, target) => {
    await tx.insert(platformSettings).values({ key: `account.unfrozen.${target}`, value: { at: new Date().toISOString() }, updatedBy: sql`app_operator_id()` as never })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: { at: new Date().toISOString() }, updatedBy: sql`app_operator_id()` as never, updatedAt: new Date() } });
  },
};

const NOT_FOUND = (c: Context) => c.json({ error: 'not_found' }, 404);
const jsonBody = async (c: Context): Promise<Record<string, unknown> | null> => {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const b = await c.req.json().catch(() => null) as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
};

/**
 * The admin API: a separate Hono app on a separate port. It is never mounted on the public app.
 * Gate order (each failure is a bare 404 so the port reveals nothing): Tailscale source address -> Tailscale-User-Login
 * header -> active operator. Everything except /admin/session/* then also needs a live elevated session (401).
 */
export function createAdminApp(deps: AdminDeps): Hono {
  const { db } = deps;
  const handlers = deps.handlers ?? defaultDangerousHandlers;
  const secure = deps.secureCookie ?? true;
  const app = new Hono();

  const gate: MiddlewareHandler = async (c, next) => {
    let addr: string | undefined;
    try {
      addr = getConnInfo(c).remote.address;
    } catch {
      addr = undefined; // no socket: never a tailnet peer
    }
    if (!sourceAllowed(addr, deps.tailscale)) return NOT_FOUND(c);
    const operator = await findOperatorByLogin(db, c.req.header('tailscale-user-login'));
    if (!operator) return NOT_FOUND(c);
    c.set('operator', operator);
    c.header('Cache-Control', 'no-store');
    return next();
  };
  app.use('*', gate);

  // A session must belong to the same operator the Tailscale header names now.
  const elevated: MiddlewareHandler = async (c, next) => {
    const s = await resolveAdminSession(db, getCookie(c, ADMIN_SESSION_COOKIE));
    const operator = c.get('operator');
    if (!s || s.operatorId !== operator.accountId) return c.json({ error: 'unauthorized' }, 401);
    // The role/active flag is re-read each request, so deactivating an operator ends their access at once.
    const fresh = await getOperator(db, operator.accountId);
    if (!fresh) return c.json({ error: 'unauthorized' }, 401);
    c.set('operator', fresh);
    return next();
  };
  const ownerOnly: MiddlewareHandler = async (c, next) => (c.get('operator').role === 'owner' ? next() : c.json({ error: 'forbidden' }, 403));

  // ---- elevated login (passkey, userVerification required; the account must be this operator's own) ----
  app.post('/admin/session/start', async (c) => {
    const r = await startPasskeyLogin(db, deps.passkey);
    return c.json({ challengeId: r.challengeId, options: r.options });
  });
  app.post('/admin/session/finish', async (c) => {
    const b = await jsonBody(c);
    if (typeof b?.challengeId !== 'string' || !b.response || typeof b.response !== 'object') return c.json({ error: 'invalid' }, 400);
    const r = await finishPasskeyLogin(db, { challengeId: b.challengeId, response: b.response as AuthenticationResponseJSON }, deps.passkey);
    if ('error' in r || r.accountId !== c.get('operator').accountId) return c.json({ error: 'unauthorized' }, 401);
    const s = await createAdminSession(db, r.accountId);
    setCookie(c, ADMIN_SESSION_COOKIE, s.token, { httpOnly: true, secure, sameSite: 'Strict', path: '/', maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000) });
    await withAdmin(db, c.get('operator'), { action: 'session.login', target: r.accountId }, async () => undefined);
    return c.json({ ok: true, expiresAt: s.expiresAt.toISOString() });
  });
  app.post('/admin/session/logout', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE);
    const s = await resolveAdminSession(db, token);
    if (s && s.operatorId === c.get('operator').accountId) {
      await withAdmin(db, c.get('operator'), { action: 'session.logout', target: s.operatorId }, async () => undefined);
    }
    await revokeAdminSession(db, token);
    deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/', secure });
    return c.json({ ok: true });
  });

  // ---- everything below needs the elevated session ----
  app.use('/admin/*', async (c, next) => (c.req.path.startsWith('/admin/session/') ? next() : elevated(c, next)));

  app.get('/admin/me', (c) => c.json({ accountId: c.get('operator').accountId, role: c.get('operator').role }));

  app.get('/admin/audit', async (c) => {
    const limit = Number(c.req.query('limit') ?? 100);
    const rows = await withAdmin(db, c.get('operator'), { action: 'audit.view', target: 'admin_audit_log' }, (tx) => listAudit(tx, Number.isFinite(limit) ? limit : 100));
    return c.json({ entries: rows });
  });
  app.get('/admin/audit/verify', async (c) => {
    await withAdmin(db, c.get('operator'), { action: 'audit.verify', target: 'admin_audit_log' }, async () => undefined);
    const bad = await verifyAuditChain(db);
    return c.json({ ok: bad === null, firstBadSeq: bad });
  });

  app.get('/admin/settings', async (c) => {
    const rows = await withAdmin(db, c.get('operator'), { action: 'settings.list', target: '*' }, (tx) => tx.select().from(platformSettings));
    return c.json({ settings: rows });
  });
  app.put('/admin/settings/:key', ownerOnly, async (c) => {
    const key = c.req.param('key');
    const b = await jsonBody(c);
    if (!/^[a-z0-9_.-]{1,100}$/i.test(key) || !b || !('value' in b)) return c.json({ error: 'invalid' }, 400);
    // Plan limits (`limits.*`) must be known keys with a non-negative number, otherwise they would silently do nothing.
    if (key.startsWith('limits.') && (!isLimitSettingKey(key) || !validLimitValue(b.value))) return c.json({ error: 'invalid' }, 400);
    const op = c.get('operator');
    // Before/after values are part of the record.
    await withAdmin(db, op, { action: 'settings.update', target: key }, async (tx, ctx) => {
      const [before] = await tx.select().from(platformSettings).where(sql`${platformSettings.key} = ${key}`);
      await tx.insert(platformSettings).values({ key, value: b.value as never, updatedBy: op.accountId })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value: b.value as never, updatedBy: op.accountId, updatedAt: new Date() } });
      await ctx.audit('settings.changed', key, { before: before?.value ?? null, after: b.value as never });
    });
    return c.json({ ok: true });
  });

  // ---- dangerous operations: booked 24 h ahead, owners only ----
  app.get('/admin/dangerous', async (c) => c.json({ actions: await listDangerous(db, c.get('operator')) }));
  app.post('/admin/dangerous', ownerOnly, async (c) => {
    const b = await jsonBody(c);
    if (typeof b?.action !== 'string' || typeof b.target !== 'string') return c.json({ error: 'invalid' }, 400);
    const r = await scheduleDangerous(db, deps.mailer, deps.emailEncKey, handlers, c.get('operator'), { action: b.action, target: b.target });
    if ('error' in r) return c.json({ error: r.error }, 400);
    return c.json({ id: r.id, executeAfter: r.executeAfter.toISOString() });
  });
  app.post('/admin/dangerous/:id/cancel', ownerOnly, async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'invalid' }, 400);
    return (await cancelDangerous(db, deps.mailer, deps.emailEncKey, c.get('operator'), id)) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });

  app.notFound((c) => NOT_FOUND(c));
  return app;
}
