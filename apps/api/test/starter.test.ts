import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
import { eq, sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, apps, githubInstallationLinks, grants, smsHashes, starterApplications, starterNotices } from '../src/db/schema.js';
import { encryptEmail } from '../src/crypto/email.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { resolveEntitlements } from '../src/grants/entitlements.js';
import { applyStarter, approveStarter, getStarterStatus, rejectStarter, sendStarterNotices, STARTER_SETTING_KEYS } from '../src/grants/starter.js';
import { evaluateDueOwners, readUsageState } from '../src/usage/state.js';
import { confirmSmsCode, hashPhone, requestSmsCode, type SmsVerifier } from '../src/verification/sms.js';
import type { GithubAccountLookup } from '../src/verification/github-age.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createSession } from '../src/auth/sessions.js';
import { operators, platformSettings } from '../src/db/schema.js';

const KEY = Buffer.alloc(32, 9);
const DAY = 86_400_000;
const T0 = new Date('2027-01-15T03:00:00Z');
let n = 0;

async function acct(db: TestDb, opts: { link?: boolean } = {}) {
  const email = `s${n++}-${randomUUID().slice(0, 6)}@example.com`;
  const [a] = await db.insert(accounts).values({ emailHash: `st${n}-${randomUUID()}`, emailEnc: encryptEmail(email, KEY), displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  if (opts.link !== false) await db.insert(githubInstallationLinks).values({ accountId: a!.id, installationId: `inst-${randomUUID()}` });
  return { id: a!.id, email, ownerId: await ensureAccountOwner(db, a!.id) };
}
/** 作成日を固定した偽の GitHub。ネットワークには出ない。 */
const fakeGithub = (createdDaysAgo: number | null, calls: string[] = []): GithubAccountLookup => ({
  async createdAt(login) { calls.push(login); return createdDaysAgo === null ? null : new Date(T0.getTime() - createdDaysAgo * DAY); },
});
const form = { project: 'A tiny blog engine', githubLogin: 'octo-student', introduction: 'Second-year student.' };
const apply = (db: TestDb, accountId: string, gh = fakeGithub(400), raw: Record<string, unknown> = form) => applyStarter(db, accountId, raw, { githubAge: gh, now: T0 });
const rows = (db: TestDb, accountId: string) => db.select().from(starterApplications).where(eq(starterApplications.accountId, accountId));

describe('Starter Grant: applying', () => {
  it('accepts an application from a linked, old-enough GitHub account and shows it as pending', () => withTestDb(async (db) => {
    const a = await acct(db);
    const calls: string[] = [];
    const r = await apply(db, a.id, fakeGithub(400, calls));
    expect(r).toHaveProperty('ok.applicationId');
    expect(calls).toEqual(['octo-student']);
    expect((await getStarterStatus(db, a.id, T0)).application).toMatchObject({ status: 'pending' });
  }));

  it('rejects a GitHub account younger than the threshold (default 90 days; the setting changes it)', () => withTestDb(async (db) => {
    const a = await acct(db);
    expect(await apply(db, a.id, fakeGithub(89))).toEqual({ error: 'github_too_new' });
    expect(await apply(db, a.id, fakeGithub(90))).toHaveProperty('ok');
    const b = await acct(db);
    const [op] = await db.insert(accounts).values({ emailHash: `op-${randomUUID()}`, emailEnc: 'e', displayName: 'Op', locale: 'ja', adultFrom: '2030-01' }).returning();
    await db.insert(operators).values({ accountId: op!.id, role: 'owner', tailscaleLogin: 'op@example.com' } as never);
    await db.insert(platformSettings).values({ key: STARTER_SETTING_KEYS.minGithubAgeDays, value: 200, updatedBy: op!.id });
    expect(await apply(db, b.id, fakeGithub(150))).toEqual({ error: 'github_too_new' });
    expect(await apply(db, b.id, fakeGithub(200))).toHaveProperty('ok');
  }));

  it('requires GitHub to be linked, the account to exist and the form to be valid', () => withTestDb(async (db) => {
    const unlinked = await acct(db, { link: false });
    expect(await apply(db, unlinked.id)).toEqual({ error: 'github_not_linked' });
    const a = await acct(db);
    expect(await apply(db, a.id, fakeGithub(null))).toEqual({ error: 'github_not_found' });
    expect(await apply(db, a.id, fakeGithub(400), { ...form, githubLogin: 'bad login!' })).toEqual({ error: 'github_login' });
    expect(await apply(db, a.id, fakeGithub(400), { ...form, project: '' })).toEqual({ error: 'project' });
    expect(await apply(db, a.id, fakeGithub(400), { ...form, introduction: 'x'.repeat(2001) })).toEqual({ error: 'introduction' });
    expect(await rows(db, a.id)).toHaveLength(0);
  }));

  it('allows only one live application per person, even when sent at the same time', () => withTestDb(async (db) => {
    const a = await acct(db);
    const results = await Promise.all(Array.from({ length: 6 }, () => apply(db, a.id)));
    expect(results.filter((r) => 'ok' in r)).toHaveLength(1);
    expect(results.filter((r) => 'error' in r).every((r) => 'error' in r && r.error === 'already_applied')).toBe(true);
    expect(await rows(db, a.id)).toHaveLength(1);
  }));
});

describe('Starter Grant: review', () => {
  it('approves with an operator-chosen period: Starter limits, no grace, stops right after the end, data stays', () => withTestDb(async (db) => {
    const a = await acct(db);
    const mailer = createFakeMailer();
    const { ok } = await apply(db, a.id) as { ok: { applicationId: string } };
    const endsAt = new Date(T0.getTime() + 60 * DAY);
    const r = await approveStarter(db, ok.applicationId, endsAt, { approvedBy: 'system', now: T0, mailer, emailKey: KEY });
    expect(r).toHaveProperty('ok.grantId');
    expect(mailer.sentTo(a.email)).toBe(1);
    const e = await resolveEntitlements(db, a.ownerId, new Date(T0.getTime() + DAY));
    expect(e).toMatchObject({ plan: 'starter', endsAt });
    expect(e.dynamic.appsPerOwner).toBe(2);
    expect(e.suspendOn?.getTime()).toBe(endsAt.getTime() + 1);
    // (The app-count limit itself is covered by resolveEntitlements: appsPerOwner = 2.)
    for (let i = 0; i < 2; i++) await db.insert(apps).values({ ownerId: a.ownerId, name: `st-${randomUUID().slice(0, 8)}`, kind: 'dynamic' });
    const [app] = await db.select().from(apps).where(eq(apps.ownerId, a.ownerId));
    // After the end: stopped (no charge, no grace), apps and rows are still there.
    const stopped: string[] = [];
    const after = new Date(endsAt.getTime() + 60_000);
    const evaluated = await evaluateDueOwners(db, { now: after, driver: { stop: async (id: string) => { stopped.push(id); } } });
    expect(evaluated).toBeGreaterThan(0);
    expect(await readUsageState(db, a.ownerId)).toBe('suspended');
    expect(stopped).toContain(app!.id);
    expect((await resolveEntitlements(db, a.ownerId, after)).plan).toBe('none');
    expect(await db.select().from(apps).where(eq(apps.ownerId, a.ownerId))).toHaveLength(2);
    expect((await getStarterStatus(db, a.id, T0)).grant).toMatchObject({ daysLeft: 60 });
  }));

  it('is once per person: concurrent approvals give one grant; a second application after a grant is refused', () => withTestDb(async (db) => {
    const a = await acct(db);
    const { ok } = await apply(db, a.id) as { ok: { applicationId: string } };
    const endsAt = new Date(T0.getTime() + 30 * DAY);
    const results = await Promise.all(Array.from({ length: 5 }, () => approveStarter(db, ok.applicationId, endsAt, { approvedBy: 'system', now: T0 })));
    expect(results.filter((r) => 'ok' in r)).toHaveLength(1);
    expect(results.filter((r) => 'error' in r).every((r) => 'error' in r && r.error === 'not_pending')).toBe(true);
    expect(await db.select().from(grants).where(eq(grants.kind, 'starter'))).toHaveLength(1);
    expect(await apply(db, a.id)).toEqual({ error: 'already_used' });
    // Even revoking does not allow another (the unique index is on the person, not on the active grant).
    await db.update(grants).set({ revokedAt: new Date() }).where(eq(grants.kind, 'starter'));
    expect(await apply(db, a.id)).toEqual({ error: 'already_used' });
    await expect(db.insert(grants).values({ targetKind: 'account', targetId: a.id, kind: 'starter', startsAt: T0, endsAt: new Date(T0.getTime() + DAY), approvedBy: 'system' })).rejects.toThrow();
  }));

  it('a grant that already exists (race with the unique index) rolls the approval back', () => withTestDb(async (db) => {
    const a = await acct(db);
    const { ok } = await apply(db, a.id) as { ok: { applicationId: string } };
    await db.insert(grants).values({ targetKind: 'account', targetId: a.id, kind: 'starter', startsAt: T0, endsAt: new Date(T0.getTime() + DAY), approvedBy: 'system' });
    expect(await approveStarter(db, ok.applicationId, new Date(T0.getTime() + 5 * DAY), { approvedBy: 'system', now: T0 })).toEqual({ error: 'already_granted' });
    expect((await rows(db, a.id))[0]!.status).toBe('pending');
  }));

  it('validates the period and lets a rejected person apply again', () => withTestDb(async (db) => {
    const a = await acct(db);
    const mailer = createFakeMailer();
    const { ok } = await apply(db, a.id) as { ok: { applicationId: string } };
    expect(await approveStarter(db, ok.applicationId, new Date(T0.getTime() - 1), { approvedBy: 'system', now: T0 })).toEqual({ error: 'invalid_period' });
    expect(await approveStarter(db, ok.applicationId, new Date(T0.getTime() + 400 * DAY), { approvedBy: 'system', now: T0 })).toEqual({ error: 'invalid_period' });
    expect(await rejectStarter(db, ok.applicationId, '  ', { approvedBy: 'system' })).toEqual({ error: 'reason' });
    expect(await rejectStarter(db, ok.applicationId, 'Please describe the project', { approvedBy: 'system', mailer, emailKey: KEY })).toEqual({ ok: true });
    expect(mailer.lastBodyTo(a.email)).toContain('Please describe the project');
    expect((await getStarterStatus(db, a.id, T0)).application).toMatchObject({ status: 'rejected', rejectReason: 'Please describe the project' });
    expect(await apply(db, a.id)).toHaveProperty('ok');
    expect(await rejectStarter(db, ok.applicationId, 'again', { approvedBy: 'system' })).toEqual({ error: 'not_pending' });
  }));
});

describe('Starter Grant: SMS verification (no real SMS)', () => {
  const key = Buffer.alloc(32, 3);
  const fakeSms = () => {
    const sent: string[] = [];
    const verifier: SmsVerifier = { async send(p) { sent.push(p); }, async check(_p, code) { return code === '123456'; } };
    return { sent, verifier };
  };

  it('stores only an HMAC hash of the number, refuses a number used by someone else, and is required when the setting says so', () => withTestDb(async (db) => {
    const { verifier, sent } = fakeSms();
    const deps = { verifier, hashKey: key };
    const a = await acct(db);
    const b = await acct(db);
    expect(await requestSmsCode(db, a.id, '090-1234', deps)).toEqual({ error: 'invalid' });
    expect(await requestSmsCode(db, a.id, '+81 90 1234 5678', deps)).toEqual({ ok: true });
    expect(sent).toEqual(['+819012345678']);
    expect(await confirmSmsCode(db, a.id, '+819012345678', '000000', deps)).toEqual({ error: 'invalid' });
    expect(await confirmSmsCode(db, a.id, '+819012345678', '123456', deps)).toEqual({ ok: true });
    expect((await db.select().from(smsHashes))).toEqual([expect.objectContaining({ accountId: a.id, hash: hashPhone('+819012345678', key) })]);
    // The plain number is nowhere in the database.
    const dump = JSON.stringify(await db.execute(sql`SELECT row_to_json(t) FROM sms_hashes t`)) + JSON.stringify(await db.select().from(starterApplications));
    expect(dump).not.toContain('9012345678');
    // The same number cannot be used by another account (neither to receive a code nor to confirm).
    expect(await requestSmsCode(db, b.id, '+819012345678', deps)).toEqual({ error: 'phone_in_use' });
    expect(await confirmSmsCode(db, b.id, '+819012345678', '123456', deps)).toEqual({ error: 'phone_in_use' });
    // The same person may confirm again (idempotent).
    expect(await confirmSmsCode(db, a.id, '+819012345678', '123456', deps)).toEqual({ ok: true });
    expect(await db.select().from(smsHashes)).toHaveLength(1);
  }));

  it('requires SMS for applications when starter.requireSms is on, and an unconfigured provider is unavailable', () => withTestDb(async (db) => {
    const [op] = await db.insert(accounts).values({ emailHash: `op-${randomUUID()}`, emailEnc: 'e', displayName: 'Op', locale: 'ja', adultFrom: '2030-01' }).returning();
    await db.insert(operators).values({ accountId: op!.id, role: 'owner', tailscaleLogin: 'op@example.com' } as never);
    await db.insert(platformSettings).values({ key: STARTER_SETTING_KEYS.requireSms, value: true, updatedBy: op!.id });
    const a = await acct(db);
    expect(await apply(db, a.id)).toEqual({ error: 'sms_required' });
    const { verifier } = fakeSms();
    await requestSmsCode(db, a.id, '+14155550100', { verifier, hashKey: key });
    await confirmSmsCode(db, a.id, '+14155550100', '123456', { verifier, hashKey: key });
    expect(await apply(db, a.id)).toHaveProperty('ok');
    const { unavailableSmsVerifier } = await import('../src/verification/sms.js');
    expect(await requestSmsCode(db, a.id, '+14155550101', { verifier: unavailableSmsVerifier, hashKey: key })).toEqual({ error: 'unavailable' });
  }));
});

describe('Starter Grant: end notices', () => {
  it('sends the 14-day and 3-day notices exactly once each (also with several workers)', () => withTestDb(async (db) => {
    const a = await acct(db);
    const mailer = createFakeMailer();
    const { ok } = await apply(db, a.id) as { ok: { applicationId: string } };
    const endsAt = new Date(T0.getTime() + 30 * DAY);
    await approveStarter(db, ok.applicationId, endsAt, { approvedBy: 'system', now: T0 });
    const send = (now: Date) => sendStarterNotices(db, { now, mailer, emailKey: KEY });
    expect(await send(new Date(endsAt.getTime() - 20 * DAY))).toBe(0);
    expect(await send(new Date(endsAt.getTime() - 14 * DAY + 3600_000))).toBe(1);
    expect(mailer.lastBodyTo(a.email)).toContain('終了');
    expect(await send(new Date(endsAt.getTime() - 10 * DAY))).toBe(0); // 14 日前は 1 回だけ
    const results = await Promise.all([1, 2, 3].map(() => send(new Date(endsAt.getTime() - 2 * DAY))));
    expect(results.reduce((x, y) => x + y, 0)).toBe(1); // 3 日前は同時に走っても 1 回
    expect(await send(new Date(endsAt.getTime() - DAY))).toBe(0);
    expect(mailer.sentTo(a.email)).toBe(2);
    expect(await send(new Date(endsAt.getTime() + 1000))).toBe(0); // 終了後は送らない
    expect((await db.select().from(starterNotices)).map((r) => r.kind).sort()).toEqual(['d14', 'd3']);
  }));

  it('does not send a "14 days" notice for a grant that is 14 days or shorter, and retries when the mail fails', () => withTestDb(async (db) => {
    const a = await acct(db);
    const { ok } = await apply(db, a.id) as { ok: { applicationId: string } };
    const endsAt = new Date(T0.getTime() + 10 * DAY);
    await approveStarter(db, ok.applicationId, endsAt, { approvedBy: 'system', now: T0 });
    const mailer = createFakeMailer();
    expect(await sendStarterNotices(db, { now: new Date(T0.getTime() + DAY), mailer, emailKey: KEY })).toBe(0);
    const failing = { sendMail: async () => { throw new Error('smtp down'); } };
    const err = console.error;
    console.error = () => undefined;
    try { expect(await sendStarterNotices(db, { now: new Date(endsAt.getTime() - DAY), mailer: failing, emailKey: KEY })).toBe(0); } finally { console.error = err; }
    expect(await sendStarterNotices(db, { now: new Date(endsAt.getTime() - DAY), mailer, emailKey: KEY })).toBe(1);
  }));
});

describe('Starter Grant: HTTP', () => {
  it('applies through the API with an injected GitHub lookup and reports the status', () => withTestDb(async (db) => {
    const a = await acct(db);
    const { token } = await createSession(db, a.id, 'x');
    const calls: string[] = [];
    const http = createHttpApp({
      db, mailer: createFakeMailer(), starter: { githubAge: fakeGithub(500, calls) },
      config: { emailEncKey: KEY, appOrigin: 'http://localhost', rpId: 'localhost', emailHashKey: KEY } as never,
    });
    const headers = { cookie: `sid=${token}`, 'content-type': 'application/json', origin: 'http://localhost' };
    const bad = await http.request('/starter/apply', { method: 'POST', headers, body: JSON.stringify({ ...form, githubLogin: '??' }) });
    expect(bad.status).toBe(400);
    const res = await http.request('/starter/apply', { method: 'POST', headers, body: JSON.stringify(form) });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['octo-student']);
    const again = await http.request('/starter/apply', { method: 'POST', headers, body: JSON.stringify(form) });
    expect(again.status).toBe(409);
    const status = await http.request('/starter/status', { headers });
    expect((await status.json() as { application: { status: string } }).application.status).toBe('pending');
    // No SMS provider configured: the SMS routes answer 503 and never call out.
    const sms = await http.request('/starter/sms/request', { method: 'POST', headers, body: JSON.stringify({ phone: '+14155550100' }) });
    expect(sms.status).toBe(503);
  }));
});
