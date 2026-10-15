import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { fakeAuthenticator } from './helpers/fake-authenticator.js';
import { accounts, passkeys, webauthnChallenges, loginEvents } from '../src/db/schema.js';
import { encryptEmail, hashEmail, normalizeEmail } from '../src/crypto/email.js';
import { purgeWebauthnChallenges, finishPasskeyLogin, finishPasskeyRegistration, startPasskeyLogin, startPasskeyRegistration } from '../src/auth/passkeys.js';
import { createSession } from '../src/auth/sessions.js';
import { createApp, type AppDeps } from '../src/http/app.js';

const cfg = { rpId: 'app.example.com', appOrigin: 'https://app.example.com', emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com' };
const auth = () => fakeAuthenticator({ rpId: cfg.rpId, origin: cfg.appOrigin });

async function mk(db: TestDb, email: string) {
  const n = normalizeEmail(email);
  const [a] = await db.insert(accounts).values({
    emailHash: hashEmail(n, cfg.emailHashKey), emailEnc: encryptEmail(n, cfg.emailEncKey), displayName: 'A', locale: 'ja', adultFrom: '2030-01',
  }).returning();
  return a!;
}
async function register(db: TestDb, accountId: string, au = auth()) {
  const s = await startPasskeyRegistration(db, accountId, cfg);
  expect(s.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  expect(s.options.rp.id).toBe(cfg.rpId);
  const r = await finishPasskeyRegistration(db, accountId, { challengeId: s.challengeId, response: au.register(s.options) as never }, cfg);
  return { au, r };
}

describe('passkeys', () => {
  it('registers then logs in; replay, counter rollback, and cross-account are rejected', () =>
    withTestDb(async (db) => {
      const a = await mk(db, 'a@x.y');
      const b = await mk(db, 'b@x.y');
      const { au, r } = await register(db, a.id);
      expect(r).toEqual({ ok: true });
      const { au: bu } = await register(db, b.id);

      const l1 = await startPasskeyLogin(db, cfg);
      expect(l1.options.allowCredentials ?? []).toHaveLength(0);
      expect(l1.options.userVerification).toBe('required');
      const resp1 = au.assert(l1.options);
      expect(await finishPasskeyLogin(db, { challengeId: l1.challengeId, response: resp1 as never }, cfg)).toEqual({ accountId: a.id });
      // replay of the same response
      expect(await finishPasskeyLogin(db, { challengeId: l1.challengeId, response: resp1 as never }, cfg)).toEqual({ error: 'invalid' });

      // b's credential logs in as b, never a
      const l2 = await startPasskeyLogin(db, cfg);
      expect(await finishPasskeyLogin(db, { challengeId: l2.challengeId, response: bu.assert(l2.options) as never }, cfg)).toEqual({ accountId: b.id });

      // counter goes up to 5, then a response with counter 3 is rejected
      const l3 = await startPasskeyLogin(db, cfg);
      expect(await finishPasskeyLogin(db, { challengeId: l3.challengeId, response: au.assert(l3.options, { counter: 5 }) as never }, cfg)).toEqual({ accountId: a.id });
      const l4 = await startPasskeyLogin(db, cfg);
      expect(await finishPasskeyLogin(db, { challengeId: l4.challengeId, response: au.assert(l4.options, { counter: 3 }) as never }, cfg)).toEqual({ error: 'invalid' });
      const [row] = await db.select().from(passkeys).where(eq(passkeys.id, au.credentialId));
      expect(row!.counter).toBe(5);
    }));

  it('rejects expired/unknown challenges, wrong kind, wrong account, and duplicate credentials', () =>
    withTestDb(async (db) => {
      const a = await mk(db, 'a@x.y');
      const b = await mk(db, 'b@x.y');
      const au = auth();
      const s = await startPasskeyRegistration(db, a.id, cfg);
      // another account cannot finish a's registration challenge
      expect(await finishPasskeyRegistration(db, b.id, { challengeId: s.challengeId, response: au.register(s.options) as never }, cfg)).toEqual({ error: 'invalid' });
      // the owner can still finish it once; a second use is rejected
      expect(await finishPasskeyRegistration(db, a.id, { challengeId: s.challengeId, response: au.register(s.options) as never }, cfg)).toEqual({ ok: true });
      expect(await finishPasskeyRegistration(db, a.id, { challengeId: s.challengeId, response: au.register(s.options) as never }, cfg)).toEqual({ error: 'invalid' });
      const s2 = await startPasskeyRegistration(db, a.id, cfg);
      await db.update(webauthnChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(webauthnChallenges.id, s2.challengeId));
      expect(await finishPasskeyRegistration(db, a.id, { challengeId: s2.challengeId, response: au.register(s2.options) as never }, cfg)).toEqual({ error: 'invalid' });
      expect(await finishPasskeyRegistration(db, a.id, { challengeId: 'nope', response: {} as never }, cfg)).toEqual({ error: 'invalid' });
      // a login challenge cannot be used for registration
      const l = await startPasskeyLogin(db, cfg);
      expect(await finishPasskeyRegistration(db, a.id, { challengeId: l.challengeId, response: au.register(l.options) as never }, cfg)).toEqual({ error: 'invalid' });
      // b cannot register a's credential id
      const s3 = await startPasskeyRegistration(db, b.id, cfg);
      expect(await finishPasskeyRegistration(db, b.id, { challengeId: s3.challengeId, response: au.register(s3.options) as never }, cfg)).toEqual({ error: 'invalid' });
      expect(await db.select().from(passkeys).where(eq(passkeys.accountId, b.id))).toHaveLength(0);
    }));

  it('rejects wrong origin', () =>
    withTestDb(async (db) => {
      const a = await mk(db, 'a@x.y');
      const evil = fakeAuthenticator({ rpId: cfg.rpId, origin: 'https://evil.example' });
      const s = await startPasskeyRegistration(db, a.id, cfg);
      expect(await finishPasskeyRegistration(db, a.id, { challengeId: s.challengeId, response: evil.register(s.options) as never }, cfg)).toEqual({ error: 'invalid' });
    }));
});

describe('passkey http', () => {
  it('login finish creates a session and records login; /me/logins lists', () =>
    withTestDb(async (db) => {
      const a = await mk(db, 'a@x.y');
      const { au } = await register(db, a.id);
      const mail = createFakeMailer();
      const app = createApp({ db, mailer: mail, config: cfg, trustedProxyHops: 0 } as AppDeps);
      const post = (path: string, body: unknown, cookie = '') =>
        app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      const start = await post('/auth/passkey/login/start', {});
      const { challengeId, options } = await start.json() as { challengeId: string; options: { challenge: string } };
      const fin = await post('/auth/passkey/login/finish', { challengeId, response: au.assert(options) }, 'did=' + 'A'.repeat(43));
      expect(fin.status).toBe(200);
      const sid = /sid=([^;]+)/.exec(fin.headers.get('set-cookie') ?? '')?.[1];
      expect(sid).toBeTruthy();
      const [ev] = await db.select().from(loginEvents).where(eq(loginEvents.accountId, a.id));
      expect(ev!.method).toBe('passkey');
      const list = await app.request('/me/logins', { headers: { cookie: `sid=${sid}` } });
      const body = await list.json() as { events: { method: string; deviceKey?: string }[] };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]!.deviceKey).toBeUndefined();
      expect((await app.request('/me/logins')).status).toBe(401);
      const bad = await post('/auth/passkey/login/finish', { challengeId, response: au.assert(options) });
      expect(bad.status).toBe(400);
      // register endpoints need a session
      expect((await post('/auth/passkey/register/start', {})).status).toBe(401);
      const { token } = await createSession(db, a.id, 'x');
      const rs = await post('/auth/passkey/register/start', {}, `sid=${token}`);
      expect(rs.status).toBe(200);
      const rj = await rs.json() as { challengeId: string; options: { challenge: string } };
      const au2 = auth();
      const rf = await post('/auth/passkey/register/finish', { challengeId: rj.challengeId, response: au2.register(rj.options) }, `sid=${token}`);
      expect(rf.status).toBe(200);
    }));

  it('login still succeeds (cookie set) when login history fails', () =>
    withTestDb(async (db) => {
      const a = await mk(db, 'a@x.y');
      const { au } = await register(db, a.id);
      await db.execute(sql`drop table login_events`);
      const app = createApp({ db, mailer: createFakeMailer(), config: cfg, trustedProxyHops: 0 } as AppDeps);
      const post = (path: string, body: unknown) =>
        app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const { challengeId, options } = await (await post('/auth/passkey/login/start', {})).json() as { challengeId: string; options: { challenge: string } };
      const fin = await post('/auth/passkey/login/finish', { challengeId, response: au.assert(options) });
      expect(fin.status).toBe(200);
      expect(fin.headers.get('set-cookie')).toContain('sid=');
    }));

  it('purges expired and consumed challenges only', () =>
    withTestDb(async (db) => {
      const a = await mk(db, 'a@x.y');
      await startPasskeyRegistration(db, a.id, cfg); // live
      const dead = await startPasskeyLogin(db, cfg);
      await db.update(webauthnChallenges).set({ consumedAt: new Date() }).where(eq(webauthnChallenges.id, dead.challengeId));
      expect(await purgeWebauthnChallenges(db, new Date())).toBe(1);
      expect(await db.select().from(webauthnChallenges)).toHaveLength(1);
    }));
});
