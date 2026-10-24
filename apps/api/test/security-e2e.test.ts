import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, apps, operators, securityBlocks } from '../src/db/schema.js';
import { encryptEmail, hashEmail } from '../src/crypto/email.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { buildSignal } from '../src/security/signals.js';
import { handleSecuritySignal } from '../src/security/incidents.js';
import { notificationHandlers } from '../src/security/notifications.js';
import { drainSecurityOutbox, stopAppHandlers } from '../src/security/actions.js';
import { isAppBlocked } from '../src/security/gate.js';
import { createApp } from '../src/http/app.js';
import { createAdminApp } from '../src/admin/server.js';
import { createSession } from '../src/auth/sessions.js';
import { createAdminSession } from '../src/admin/admin-session.js';
import { transitionUsageState } from '../src/usage/state.js';

// Phase 6 end-to-end (offline): no real network, Falco, S3, mail or DNS. Any outbound request fails the test at once.
const key = Buffer.alloc(32, 7), origin = 'https://admin.example.ts.net', t0 = new Date('2026-10-24T12:00:00Z');
beforeAll(() => { vi.stubGlobal('fetch', () => { throw new Error('external HTTP is forbidden in security tests'); }); });
afterAll(() => { vi.unstubAllGlobals(); });

async function account(db: TestDb, locale: 'ja' | 'en') {
  const email = `${randomUUID()}@example.test`;
  const [a] = await db.insert(accounts).values({ emailHash: hashEmail(email, key), emailEnc: encryptEmail(email, key), displayName: 'T', locale, adultFrom: '2030-01' }).returning();
  return { ...a!, email, ownerId: await ensureAccountOwner(db, a!.id) };
}
const mkApp = async (db: TestDb, ownerId: string, kind: 'static' | 'dynamic') => (await db.insert(apps).values({ ownerId, kind, name: `a-${randomUUID().slice(0, 10)}` }).returning())[0]!.id;
const sig = (appId: string, severity: 'low' | 'medium' | 'high') => buildSignal({ source: 'falco', sourceEventId: randomUUID(), ruleVersion: '1', occurredAt: t0, severity, target: { kind: 'app', appId }, reasonCode: 'shell.internal_rule', evidence: { rule: 'private_detector' } });

describe.each(['ja', 'en'] as const)('detect -> block -> notify -> appeal -> release -> recover (%s)', (locale) => {
  it('static and dynamic apps are blocked, only incident-owned reasons are removed on release', () => withTestDb(async (db) => {
    const owner = await account(db, locale), op = await account(db, locale);
    await db.insert(operators).values({ accountId: op.id, tailscaleLogin: op.email, role: 'owner' });
    const dyn = await mkApp(db, owner.ownerId, 'dynamic'), sta = await mkApp(db, owner.ownerId, 'static');
    const inc = await handleSecuritySignal(db, sig(dyn, 'high'), { now: t0 });
    await handleSecuritySignal(db, sig(sta, 'medium'), { now: t0 });
    expect(await isAppBlocked(db, dyn)).toBe(true);
    expect(await isAppBlocked(db, sta)).toBe(true);

    const stopped: string[] = [], sent: { to: string; body: string }[] = [];
    const later = new Date(t0.getTime() + 60_000);
    await drainSecurityOutbox(db, { ...stopAppHandlers({ stop: async (id) => { stopped.push(id); } }), ...notificationHandlers(db, { emailKey: key, appOrigin: 'https://public.example', adminOrigin: origin, mailer: { sendMail: async (to, _s, body) => { sent.push({ to, body }); } } }) }, { now: later });
    await drainSecurityOutbox(db, notificationHandlers(db, { emailKey: key, appOrigin: 'https://public.example', adminOrigin: origin, mailer: { sendMail: async (to, _s, body) => { sent.push({ to, body }); } } }), { now: new Date(later.getTime() + 60_000) });
    expect(stopped).toEqual([dyn]); // high stops the container; medium on the static app stops nothing
    expect(sent.find((m) => m.to === owner.email)!.body).toContain(`/${locale}/security`);
    expect(sent.some((m) => m.to === op.email)).toBe(true);

    // The owner appeals through the public API (session only), never able to lift it herself.
    const s = await createSession(db, owner.id, 'T');
    const api = createApp({ db, mailer: createFakeMailer(), security: { hashKey: key }, config: { emailEncKey: key, emailHashKey: key, appOrigin: 'https://public.example', rpId: 'public.example', adminEmail: 'a@example.test' } });
    const appeal = await api.request(`/security/incidents/${inc.incidentId}/appeals`, { method: 'POST', headers: { cookie: `sid=${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'please review' }) }, { incoming: { socket: { remoteAddress: '203.0.113.9' } } });
    expect(appeal.status).toBe(200);
    expect(await isAppBlocked(db, dyn)).toBe(true);

    // An operator releases it over the Tailscale-gated admin API; another stop reason survives.
    await transitionUsageState(db, owner.ownerId, 'manual_suspend');
    const admin = await createAdminSession(db, op.id);
    const adminApi = createAdminApp({ db, mailer: createFakeMailer(), emailEncKey: key, passkey: { rpId: 'example.ts.net', appOrigin: origin, emailEncKey: key }, tailscale: { required: true, devLoopback: false } });
    const rel = await adminApi.request(`/admin/security/${inc.incidentId}/release`, { method: 'POST', headers: { 'tailscale-user-login': op.email, cookie: `asid=${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'reviewed' }) }, { incoming: { socket: { remoteAddress: '100.100.1.2' } } });
    expect(rel.status).toBe(200);
    expect(await isAppBlocked(db, dyn)).toBe(false);
    expect(await isAppBlocked(db, sta)).toBe(true); // the separate medium incident is still active
    expect((await db.select().from(securityBlocks).where(eq(securityBlocks.appId, dyn)))[0]?.releasedAt ?? null).not.toBeNull();
  }));
});

describe('severity matrix', () => {
  it('low only notifies; no block and no stop', () => withTestDb(async (db) => {
    const o = await account(db, 'ja'), id = await mkApp(db, o.ownerId, 'dynamic');
    await handleSecuritySignal(db, sig(id, 'low'), { now: t0 });
    expect(await isAppBlocked(db, id)).toBe(false);
    const stopped: string[] = [];
    await drainSecurityOutbox(db, stopAppHandlers({ stop: async (x) => { stopped.push(x); } }), { now: new Date(t0.getTime() + 60_000) });
    expect(stopped).toEqual([]);
  }));
  it('external HTTP is refused in this suite', () => {
    expect(() => fetch('https://example.com')).toThrow(/forbidden/);
  });
});
