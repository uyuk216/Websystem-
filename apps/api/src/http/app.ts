import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { requestRecovery, type RecoveryRequestConfig } from '../auth/recovery.js';
import { startEmailChallenge, verifyEmailCode } from '../auth/email-login.js';
import { openEmailLink, getRequesterScreen, getConfirmChoices, confirmNumber, completeCrossDeviceLogin } from '../auth/cross-device.js';
import { registerAccount } from '../auth/accounts.js';
import { recordLogin, listLoginEvents } from '../auth/login-history.js';
import { startPasskeyRegistration, finishPasskeyRegistration, startPasskeyLogin, finishPasskeyLogin } from '../auth/passkeys.js';
import { acceptInvite, changeRole, createTeam, deleteTeam, getTeam, inviteMember, leaveTeam, listTeams, removeMember, transferOwnership } from '../teams/teams.js';
import { UUID } from '../auth/cross-device.js';
import Busboy from 'busboy';
import { Readable } from 'node:stream';
import { bodyLimit } from 'hono/body-limit';
import { JOBS, type Storage } from 'platform';
import type { DynamicRuntime } from '../ingest/dynamic.js';
import { STATIC_LIMITS } from 'shared';
import { createDeployment, listDeployments, restart, rollback, type JobQueue } from '../apps/deployments.js';
import { createApp as createAppRecord, deleteApp, getApp, listApps, listOwners, updateApp } from '../apps/apps.js';
import { deleteEnvVar, listEnvVars, setEnvVar, type EnvError } from '../apps/env-vars.js';
import { addDatabase, getDatabase, removeDatabase, type DatabaseError } from '../apps/databases.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../apps/api-tokens.js';
import { claimDelivery, deployPush, findPushTargets, parsePush, releaseDelivery, verifyWebhook } from '../github/webhook.js';
import { completeConnect, setGithub, startConnect } from '../github/link.js';
import type { GithubClient } from '../github/client.js';
import { getUsage } from '../usage/transfer.js';
import { getAppLogs, listAccessLogs } from '../apps/logs.js';
import { getRuntimeUsage } from '../usage/runtime-hours.js';
import { createSession, listSessions, revokeSession } from '../auth/sessions.js';
import { randomBytes } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { Locale } from 'i18n';
import { clearSessionCookie, rateLimit, requireSession, setSessionCookie } from './middleware.js';

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
  config: RecoveryRequestConfig & { emailEncKey: Buffer; appEnvKey?: Buffer; appOrigin: string; rpId: string };
  trustedProxyHops?: number;
  /** Object storage and job queue; deployment routes and storage cleanup are enabled when both are given. */
  storage?: Storage;
  queue?: JobQueue;
  /** Overrides the 200MB archive size limit (dev/e2e only; set through UPLOAD_MAX_BYTES). */
  uploadMaxBytes?: number;
  /** Dynamic-app runtime (container driver + env key); rollback of dynamic apps needs it. */
  runtime?: DynamicRuntime;
  /** GitHub App integration; the webhook and PATCH /apps/:id/github are registered only when this is given. */
  github?: {
    webhookSecret: string;
    client: GithubClient;
    /** Runs the post-response work of a webhook (default: fire and forget, errors logged). Tests collect the promises. */
    background?: (work: Promise<unknown>) => void;
  };
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
    // History is best-effort: a failure must not fail an already-established login.
    const logLogin = (c: Context, accountId: string, method: 'passkey' | 'email', notify = true) =>
      recordLogin(deps.db, deps.mailer, { accountId, method, deviceLabel: deviceLabel(c), ip: clientIp(c), deviceId: c.get('deviceId'), notify }, deps.config)
        .catch((err: unknown) => console.error('recordLogin failed', err));
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
      await logLogin(c, r.accountId, 'email');
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
        await logLogin(c, r.accountId, 'email');
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
      const r = await getConfirmChoices(deps.db, cid, s, c.get('deviceId'));
      return 'error' in r ? c.json(r, 400) : c.json(r);
    });
    app.post('/auth/email/confirm', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || !str(b.scanToken, 200) || typeof b.chosen !== 'number') return c.json({ error: 'invalid' }, 400);
      const r = await confirmNumber(deps.db, b.challengeId, b.scanToken, c.get('deviceId'), b.chosen);
      return 'error' in r ? c.json(r, 400) : c.json(r);
    });
    app.post('/auth/email/complete', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64)) return c.json({ error: 'invalid' }, 400);
      const r = await completeCrossDeviceLogin(deps.db, b.challengeId, c.get('deviceId'));
      if ('error' in r) return c.json({ error: r.error }, 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      await logLogin(c, r.accountId, 'email');
      return c.json({ ok: true });
    });
    app.post('/auth/signup', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      // Either the 6-digit code or the mailed link token proves the email.
      const byLink = str(b?.linkToken, 200);
      if (!str(b?.challengeId, 64) || !(byLink || str(b.code, 16)) || !str(b.email, 320) || !str(b.displayName, 100) || !str(b.birthDate, 10)) {
        return c.json({ error: 'invalid' }, 400);
      }
      const r = await registerAccount(deps.db, {
        challengeId: b.challengeId, code: byLink ? b.linkToken as string : b.code as string, by: byLink ? 'link' : 'code', email: b.email, requesterDeviceId: c.get('deviceId'), displayName: b.displayName.trim(), birthDate: b.birthDate, locale: asLocale(b.locale),
      }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, r.error === 'exists' ? 409 : 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      await logLogin(c, r.accountId, 'email', false);
      return c.json({ ok: true, recoveryCode: r.recoveryCode });
    });
    const session = requireSession(deps.db, { clientIp });
    // Credential management and account-security routes: session cookie only, never an API token.
    const cookieSession = requireSession(deps.db, { bearer: false });
    app.post('/auth/passkey/register/start', cookieSession, async (c) => c.json(await startPasskeyRegistration(deps.db, c.get('accountId'), deps.config)));
    app.post('/auth/passkey/register/finish', cookieSession, attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || typeof b.response !== 'object' || b.response === null) return c.json({ error: 'invalid' }, 400);
      const r = await finishPasskeyRegistration(deps.db, c.get('accountId'), { challengeId: b.challengeId, response: b.response as never }, deps.config);
      return 'error' in r ? c.json(r, 400) : c.json(r);
    });
    app.post('/auth/passkey/login/start', startLimit, async (c) => c.json(await startPasskeyLogin(deps.db, deps.config)));
    app.post('/auth/passkey/login/finish', attemptLimit, async (c) => {
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!str(b?.challengeId, 64) || typeof b.response !== 'object' || b.response === null) return c.json({ error: 'invalid' }, 400);
      const r = await finishPasskeyLogin(deps.db, { challengeId: b.challengeId, response: b.response as never }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, 400);
      const s = await createSession(deps.db, r.accountId, deviceLabel(c));
      setSessionCookie(c, s.token);
      await logLogin(c, r.accountId, 'passkey');
      return c.json({ ok: true });
    });
    const teamStatus = { forbidden: 403, full: 409, last_owner: 409, not_member: 404, invalid: 400, expired: 400 } as const;
    const teamErr = (c: Context, e: keyof typeof teamStatus) => c.json({ error: e }, teamStatus[e]);
    const inviteLimit = rateLimit(clientIp, 30, 3600);
    const jsonBody = async (c: Context) => await c.req.json().catch(() => null) as Record<string, unknown> | null;
    app.get('/teams', session, async (c) => c.json({ teams: await listTeams(deps.db, c.get('accountId')) }));
    app.post('/teams', session, async (c) => {
      const b = await jsonBody(c);
      if (!str(b?.name, 100) || !b.name.trim()) return c.json({ error: 'invalid' }, 400);
      return c.json(await createTeam(deps.db, c.get('accountId'), b.name.trim()));
    });
    app.post('/teams/invites/accept', session, attemptLimit, async (c) => {
      const b = await jsonBody(c);
      if (!str(b?.inviteId, 64) || !str(b.token, 200)) return c.json({ error: 'invalid' }, 400);
      const r = await acceptInvite(deps.db, b.inviteId, b.token, c.get('accountId'));
      return 'error' in r ? teamErr(c, r.error) : c.json(r);
    });
    app.get('/teams/:id', session, async (c) => {
      const team = await getTeam(deps.db, c.req.param('id'), c.get('accountId'));
      return team ? c.json(team) : teamErr(c, 'not_member');
    });
    app.delete('/teams/:id', cookieSession, async (c) => {
      const r = await deleteTeam(deps.db, c.req.param('id'), c.get('accountId'));
      return 'error' in r ? teamErr(c, r.error) : c.json(r);
    });
    app.post('/teams/:id/invites', cookieSession, inviteLimit, async (c) => {
      const b = await jsonBody(c);
      if (!str(b?.email, 320)) return c.json({ error: 'invalid' }, 400);
      const r = await inviteMember(deps.db, deps.mailer, c.req.param('id'), c.get('accountId'), b.email, deps.config);
      return 'error' in r ? teamErr(c, r.error) : c.json(r);
    });
    app.patch('/teams/:id/members/:accountId', cookieSession, async (c) => {
      const b = await jsonBody(c);
      if (b?.role !== 'admin' && b?.role !== 'member') return c.json({ error: 'invalid' }, 400);
      const r = await changeRole(deps.db, c.req.param('id'), c.get('accountId'), c.req.param('accountId'), b.role);
      return 'error' in r ? teamErr(c, r.error) : c.json(r);
    });
    app.delete('/teams/:id/members/:accountId', cookieSession, async (c) => {
      const r = await removeMember(deps.db, c.req.param('id'), c.get('accountId'), c.req.param('accountId'));
      return 'error' in r ? teamErr(c, r.error) : c.json(r);
    });
    app.post('/teams/:id/leave', session, async (c) => {
      const r = await leaveTeam(deps.db, c.req.param('id'), c.get('accountId'));
      return 'error' in r ? teamErr(c, r.error) : c.json(r);
    });
    app.post('/teams/:id/transfer', cookieSession, async (c) => {
      const b = await jsonBody(c);
      if (!str(b?.toAccountId, 64)) return c.json({ error: 'invalid' }, 400);
      const r = await transferOwnership(deps.db, c.req.param('id'), c.get('accountId'), b.toAccountId);
      return 'error' in r ? teamErr(c, r.error) : c.json(r);
    });
    const appStatus = { format: 400, reserved: 400, taken: 409, forbidden: 403, limit: 409, not_found: 404, invalid: 400 } as const;
    app.get('/me/owners', session, async (c) => c.json({ owners: await listOwners(deps.db, c.get('accountId')) }));
    app.get('/apps', session, async (c) => c.json({ apps: await listApps(deps.db, c.get('accountId')) }));
    app.post('/apps', session, async (c) => {
      const b = await jsonBody(c);
      if (!str(b?.name, 100) || !str(b.ownerId, 64) || (b.publishDir !== undefined && !str(b.publishDir, 200)) || (b.kind !== undefined && b.kind !== 'static' && b.kind !== 'dynamic')) return c.json({ error: 'invalid' }, 400);
      const r = await createAppRecord(deps.db, c.get('accountId'), { name: b.name, ownerId: b.ownerId, publishDir: b.publishDir as string | undefined, kind: b.kind as 'static' | 'dynamic' | undefined });
      return 'error' in r ? c.json({ error: r.error }, appStatus[r.error]) : c.json(r, 201);
    });
    app.get('/apps/:id', session, async (c) => {
      const a = await getApp(deps.db, c.get('accountId'), c.req.param('id'));
      return a ? c.json(a) : c.json({ error: 'not_found' }, 404);
    });
    app.get('/apps/:id/usage', session, async (c) => {
      const u = await getUsage(deps.db, c.get('accountId'), c.req.param('id'));
      if (!u) return c.json({ error: 'not_found' }, 404);
      const runtime = await getRuntimeUsage(deps.db, c.get('accountId'), c.req.param('id'));
      return c.json({ ...u, runtime });
    });
    app.patch('/apps/:id', session, async (c) => {
      const b = await jsonBody(c);
      if (!str(b?.publishDir, 200)) return c.json({ error: 'invalid' }, 400);
      const r = await updateApp(deps.db, c.get('accountId'), c.req.param('id'), { publishDir: b.publishDir });
      return 'error' in r ? c.json({ error: r.error }, appStatus[r.error]) : c.json(r);
    });
    app.delete('/apps/:id', cookieSession, async (c) => {
      const q = deps.queue;
      const r = await deleteApp(deps.db, c.get('accountId'), c.req.param('id'), {
        enqueueStorageCleanup: q ? async (id) => { await q.send(JOBS.deleteAppStorage, { appId: id }); } : undefined,
      });
      return 'error' in r ? c.json({ error: r.error }, appStatus[r.error]) : c.json(r);
    });
    if (deps.storage && deps.queue) {
      const storage = deps.storage;
      const queue = deps.queue;
      const depStatus = { not_found: 404, forbidden: 403, too_large: 413, invalid: 400, invalid_state: 409, start_failed: 502, runtime_limit: 409 } as const;
      // Multipart overhead on top of the archive limit; the exact archive size is enforced while streaming.
      const uploadLimit = bodyLimit({
        maxSize: (deps.uploadMaxBytes ?? STATIC_LIMITS.storageBytes) + 1024 * 1024,
        onError: (c) => c.json({ error: 'too_large' }, 413),
      });
      app.post('/apps/:id/deployments', session, uploadLimit, async (c) => {
        const ct = c.req.header('content-type') ?? '';
        if (!/^multipart\/form-data/i.test(ct) || !c.req.raw.body) return c.json({ error: 'invalid' }, 400);
        // Take the first part named "file" as a stream; it is piped to storage without buffering.
        const upload = await new Promise<{ filename: string; file: Readable } | null>((resolve) => {
          let bb: Busboy.Busboy;
          try { bb = Busboy({ headers: { 'content-type': ct }, limits: { files: 1, parts: 20 } }); } catch { resolve(null); return; }
          bb.on('file', (name, file, info) => {
            if (name !== 'file') { file.resume(); return; }
            resolve({ filename: info.filename ?? '', file });
          });
          bb.on('error', () => resolve(null));
          bb.on('close', () => resolve(null));
          Readable.fromWeb(c.req.raw.body as never).on('error', () => bb.destroy()).pipe(bb);
        });
        if (!upload) return c.json({ error: 'invalid' }, 400);
        if (!/\.zip$/i.test(upload.filename)) { upload.file.destroy(); return c.json({ error: 'invalid_type' }, 400); }
        const r = await createDeployment(deps.db, storage, queue, c.get('accountId'), c.req.param('id'), { source: 'upload', archive: upload.file, format: 'zip', maxBytes: deps.uploadMaxBytes });
        if ('error' in r) { upload.file.destroy(); return c.json({ error: r.error }, depStatus[r.error]); }
        return c.json(r, 201);
      });
      app.get('/apps/:id/deployments', session, async (c) => {
        const a = await getApp(deps.db, c.get('accountId'), c.req.param('id'));
        if (!a) return c.json({ error: 'not_found' }, 404);
        return c.json({ deployments: await listDeployments(deps.db, c.get('accountId'), a.id) });
      });
      app.post('/apps/:id/deployments/:did/rollback', session, async (c) => {
        const r = await rollback(deps.db, c.get('accountId'), c.req.param('id'), c.req.param('did'), deps.runtime);
        return 'error' in r ? c.json(r, depStatus[r.error]) : c.json(r);
      });
    }
    app.post('/apps/:id/restart', session, async (c) => {
      const r = await restart(deps.db, c.get('accountId'), c.req.param('id'), deps.runtime);
      return 'error' in r ? c.json(r, ({ not_found: 404, forbidden: 403, invalid_state: 409, start_failed: 502, runtime_limit: 409 } as const)[r.error]) : c.json(r);
    });
    app.get('/apps/:id/access-logs', session, async (c) => {
      const r = await listAccessLogs(deps.db, c.get('accountId'), c.req.param('id'), Number(c.req.query('limit') ?? 100));
      return 'error' in r ? c.json(r, r.error === 'forbidden' ? 403 : 404) : c.json(r);
    });
    app.get('/apps/:id/logs', session, async (c) => {
      if (!deps.runtime) return c.json({ error: 'runtime_disabled' }, 503);
      const r = await getAppLogs(deps.db, deps.runtime, c.get('accountId'), c.req.param('id'), Number(c.req.query('tail') ?? 1000));
      return 'error' in r ? c.json(r, r.error === 'forbidden' ? 403 : 404) : c.json(r);
    });
    const appEnvKey = deps.config.appEnvKey;
    if (appEnvKey) {
      const envStatus: Record<EnvError, 400 | 403 | 404 | 413> = { not_found: 404, forbidden: 403, invalid_name: 400, reserved: 400, invalid_value: 400, too_large: 413, limit: 400 };
      const dbStatus: Record<DatabaseError, 400 | 403 | 404 | 409 | 502 | 503> = { not_found: 404, forbidden: 403, not_dynamic: 400, exists: 409, unavailable: 503, failed: 502 };
      app.get('/apps/:id/database', session, async (c) => {
        const r = await getDatabase(deps.db, c.get('accountId'), c.req.param('id'));
        return 'error' in r ? c.json(r, 404) : c.json(r);
      });
      app.post('/apps/:id/database', session, async (c) => {
        const r = await addDatabase(deps.db, deps.runtime, c.get('accountId'), c.req.param('id'));
        return 'error' in r ? c.json(r, dbStatus[r.error]) : c.json(r, 201);
      });
      app.delete('/apps/:id/database', session, async (c) => {
        const r = await removeDatabase(deps.db, deps.runtime, c.get('accountId'), c.req.param('id'));
        return 'error' in r ? c.json(r, dbStatus[r.error]) : c.json(r);
      });
      app.get('/apps/:id/env', session, async (c) => {
        const r = await listEnvVars(deps.db, c.get('accountId'), c.req.param('id'));
        return Array.isArray(r) ? c.json({ vars: r }) : c.json(r, 404);
      });
      app.put('/apps/:id/env/:name', session, bodyLimit({ maxSize: 40 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
        const b = await jsonBody(c);
        if (typeof b?.value !== 'string') return c.json({ error: 'invalid_value' }, 400);
        const r = await setEnvVar(deps.db, appEnvKey, c.get('accountId'), c.req.param('id'), c.req.param('name'), b.value);
        return 'error' in r ? c.json({ error: r.error }, envStatus[r.error]) : c.json({ ok: true });
      });
      app.delete('/apps/:id/env/:name', session, async (c) => {
        const r = await deleteEnvVar(deps.db, c.get('accountId'), c.req.param('id'), c.req.param('name'));
        return 'error' in r ? c.json({ error: r.error }, envStatus[r.error]) : c.json({ ok: true });
      });
    }
    app.get('/me/tokens', cookieSession, async (c) => c.json({ tokens: await listApiTokens(deps.db, c.get('accountId')) }));
    app.post('/me/tokens', cookieSession, async (c) => {
      const b = await jsonBody(c);
      if (!str(b?.name, 100) || !b.name.trim()) return c.json({ error: 'invalid' }, 400);
      return c.json(await createApiToken(deps.db, c.get('accountId'), b.name.trim()), 201);
    });
    app.delete('/me/tokens/:id', cookieSession, async (c) => {
      if (!UUID.test(c.req.param('id'))) return c.json({ error: 'invalid' }, 400);
      return (await revokeApiToken(deps.db, c.get('accountId'), c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
    });
    if (deps.github && deps.storage && deps.queue) {
      const { storage, queue } = deps;
      const { client, webhookSecret } = deps.github;
      const background = deps.github.background ?? ((p: Promise<unknown>) => { p.catch((err: unknown) => console.error('github webhook work failed', err)); });
      app.post('/github/webhook', bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: 'too_large' }, 413) }), async (c) => {
        // The signature covers the exact raw body, so read it as text before any parsing.
        const raw = await c.req.text();
        if (!(await verifyWebhook(webhookSecret, raw, c.req.header('x-hub-signature-256')))) return c.json({ error: 'invalid_signature' }, 401);
        if (c.req.header('x-github-event') !== 'push') return c.json({ ok: true, ignored: true });
        const delivery = c.req.header('x-github-delivery');
        if (delivery && (delivery.length > 100 || !(await claimDelivery(deps.db, delivery)))) return c.json({ ok: true, ignored: true });
        // If anything fails before deployments exist, forget the claim so GitHub's redelivery is processed.
        const release = (): Promise<void> => (delivery ? releaseDelivery(deps.db, delivery).catch((err: unknown) => console.error('github release failed', err)) : Promise.resolve());
        let json: unknown;
        try { json = JSON.parse(raw); } catch { await release(); return c.json({ error: 'invalid' }, 400); }
        const e = parsePush(json);
        if (!e) { await release(); return c.json({ error: 'invalid' }, 400); }
        let targets: string[];
        try { targets = await findPushTargets(deps.db, e); } catch (err) { await release(); throw err; }
        if (targets.length === 0) return c.json({ ok: true, ignored: true });
        // Downloading the tarball can take a while; answer GitHub now and finish in the background.
        background(deployPush(deps.db, storage, queue, client, e, targets).then((retry) => (retry ? release() : undefined), (err: unknown) => release().then(() => { throw err; })));
        return c.json({ ok: true, apps: targets.length }, 202);
      });
      // User authorization: proves which installations the signed-in account controls.
      app.get('/github/connect', cookieSession, async (c) => {
        const state = await startConnect(deps.db, c.get('accountId'), c.get('sessionId'));
        return c.redirect(client.authorizeUrl(state));
      });
      app.get('/github/callback', cookieSession, attemptLimit, async (c) => {
        const code = c.req.query('code');
        const state = c.req.query('state');
        const back = (ok: boolean) => c.redirect(`${deps.config.appOrigin}/apps?github=${ok ? 'connected' : 'error'}`);
        if (!str(code, 200) || !str(state, 200)) return back(false);
        const r = await completeConnect(deps.db, c.get('accountId'), c.get('sessionId'), state, code, client).catch((err: unknown) => {
          console.error('github connect failed', err);
          return { error: 'failed' as const };
        });
        return back(!('error' in r));
      });
      app.patch('/apps/:id/github', cookieSession, async (c) => {
        const b = await jsonBody(c);
        const installationId = typeof b?.installationId === 'number' ? String(b.installationId) : b?.installationId;
        if (!str(b?.repo, 201) || !str(b.branch, 255) || !str(installationId, 16)) return c.json({ error: 'invalid' }, 400);
        const r = await setGithub(deps.db, c.get('accountId'), c.req.param('id'), { repo: b.repo, branch: b.branch, installationId }, (i, repo) => client.verifyInstallation(i, repo));
        return 'error' in r ? c.json({ error: r.error }, appStatus[r.error]) : c.json(r);
      });
    }
    app.post('/auth/logout', cookieSession, async (c) => {
      await revokeSession(deps.db, c.get('accountId'), c.get('sessionId'));
      clearSessionCookie(c);
      return c.json({ ok: true });
    });
    app.get('/me/sessions', cookieSession, async (c) => {
      const current = c.get('sessionId');
      const rows = await listSessions(deps.db, c.get('accountId'));
      return c.json({ sessions: rows.map((r) => ({ ...r, current: r.id === current })) });
    });
    app.delete('/me/sessions/:id', cookieSession, async (c) => {
      if (!UUID.test(c.req.param('id'))) return c.json({ error: 'invalid' }, 400);
      await revokeSession(deps.db, c.get('accountId'), c.req.param('id'));
      return c.json({ ok: true });
    });
    app.get('/me/logins', cookieSession, async (c) => c.json({ events: await listLoginEvents(deps.db, c.get('accountId')) }));
  }
  return app;
}
