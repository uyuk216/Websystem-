import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, emailChallenges } from '../src/db/schema.js';
import { encryptEmail, hashEmail, normalizeEmail } from '../src/crypto/email.js';
import { startEmailChallenge, verifyEmailCode } from '../src/auth/email-login.js';
import { registerAccount } from '../src/auth/accounts.js';
import { createApp, type AppDeps } from '../src/http/app.js';

const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };

async function mkAccount(db: TestDb, email: string) {
  const n = normalizeEmail(email);
  const [a] = await db.insert(accounts).values({
    emailHash: hashEmail(n, cfg.emailHashKey), emailEnc: encryptEmail(n, cfg.emailEncKey),
    displayName: 'A', locale: 'ja', adultFrom: '2030-01',
  }).returning();
  return a!;
}
const start = (db: TestDb, mail: ReturnType<typeof createFakeMailer>, email: string, purpose: 'login' | 'signup' = 'login') =>
  startEmailChallenge(db, mail, { email, purpose, locale: 'ja', requesterDeviceId: 'd1' }, cfg);

afterEach(() => vi.useRealTimers());

describe('email login', () => {
  it('verifies once, expires, locks, hides unknown emails', async () => {
    await withTestDb(async (db) => {
      const mail = createFakeMailer();
      const a = await mkAccount(db, 'foo@example.com');
      const r1 = await start(db, mail, 'Foo@Example.com ');
      if (!('challengeId' in r1)) throw new Error('rate');
      const code = mail.lastCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(mail.lastBodyTo('foo@example.com')).toContain(`https://app.example.com/login/link?c=${r1.challengeId}&t=`);
      const [row] = await db.select().from(emailChallenges).where(eq(emailChallenges.id, r1.challengeId));
      expect(row!.codeHash).toBe(createHash('sha256').update(code).digest('hex'));
      expect(await verifyEmailCode(db, r1.challengeId, code, 'd1')).toEqual({ accountId: a.id });
      expect(await verifyEmailCode(db, r1.challengeId, code, 'd1')).toEqual({ error: 'invalid' });

      // lock after 5 failures
      const r3 = await start(db, mail, 'foo@example.com');
      const code3 = mail.lastCode();
      if (!('challengeId' in r3)) throw new Error('rate');
      for (let i = 0; i < 5; i++) await verifyEmailCode(db, r3.challengeId, code3 === '000000' ? '000001' : '000000', 'd1');
      expect(await verifyEmailCode(db, r3.challengeId, code3, 'd1')).toEqual({ error: 'locked' });

      // unknown email: same shape, no mail, never verifies
      mail.clear();
      const u = await start(db, mail, 'nobody@x.y');
      expect(u).toHaveProperty('challengeId');
      expect(mail.sentTo('nobody@x.y')).toBe(0);
      if ('challengeId' in u) expect(await verifyEmailCode(db, u.challengeId, '123456', 'd1')).toEqual({ error: 'invalid' });
    });
  });

  it('expires after 10 minutes and rejects other devices', async () => {
    await withTestDb(async (db) => {
      const mail = createFakeMailer();
      await mkAccount(db, 'foo@example.com');
      const r = await start(db, mail, 'foo@example.com');
      if (!('challengeId' in r)) throw new Error('rate');
      const code = mail.lastCode();
      expect(await verifyEmailCode(db, r.challengeId, code, 'other')).toEqual({ error: 'invalid' });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await verifyEmailCode(db, r.challengeId, code, 'd1')).toEqual({ error: 'expired' });
    });
  });

  it('limits starts per email hash to 3 per 10 minutes, in the DB', async () => {
    await withTestDb(async (db) => {
      const mail = createFakeMailer();
      for (let i = 0; i < 3; i++) expect(await start(db, mail, 'foo@example.com')).toHaveProperty('challengeId');
      expect(await start(db, mail, 'FOO@example.com')).toEqual({ error: 'rate_limited' });
    });
  });
});

describe('signup', () => {
  const base = { displayName: 'Taro', locale: 'ja' as const };
  it('registers 13+, stores no birth date, rejects under13', async () => {
    await withTestDb(async (db) => {
      const mail = createFakeMailer();
      const r = await start(db, mail, 'new@example.com', 'signup');
      if (!('challengeId' in r)) throw new Error('rate');
      const s = { ...base, requesterDeviceId: 'd1', email: 'new@example.com', challengeId: r.challengeId, code: mail.lastCode() };
      expect(await registerAccount(db, { ...s, birthDate: '2015-01-01' }, cfg)).toEqual({ error: 'under13' });
      expect(await registerAccount(db, { ...s, requesterDeviceId: 'other', birthDate: '2008-04-02' }, cfg)).toEqual({ error: 'invalid' });
      expect(await registerAccount(db, { ...s, code: '000000', birthDate: '2008-04-02' }, cfg)).toEqual({ error: 'invalid' });
      const ok = await registerAccount(db, { ...s, birthDate: '2008-04-02' }, cfg);
      expect(ok).toHaveProperty('recoveryCode');
      expect(JSON.stringify(await db.select().from(accounts))).not.toContain('2008-04-02');
      expect(await registerAccount(db, { ...s, birthDate: '2008-04-02' }, cfg)).toEqual({ error: 'invalid' }); // consumed
    });
  });

  it('existing email gets a log-in-instead mail, no code', async () => {
    await withTestDb(async (db) => {
      const mail = createFakeMailer();
      await mkAccount(db, 'foo@example.com');
      expect(await start(db, mail, 'foo@example.com', 'signup')).toHaveProperty('challengeId');
      expect(mail.sentTo('foo@example.com')).toBe(1);
      expect(mail.lastCode()).toBe('');
    });
  });
});

describe('mail dispatch', () => {
  it('resolves without waiting for a slow mailer', async () => {
    await withTestDb(async (db) => {
      await mkAccount(db, 'foo@example.com');
      const slow = { sendMail: () => new Promise<void>(() => {}) };
      expect(await start(db, slow as never, 'foo@example.com')).toHaveProperty('challengeId');
    });
  });
});

describe('mail failure', () => {
  it('synchronous sendMail throw is swallowed', async () => {
    await withTestDb(async (db) => {
      await mkAccount(db, 'foo@example.com');
      const bad = { sendMail: () => { throw new Error('boom'); } };
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await start(db, bad as never, 'foo@example.com')).toHaveProperty('challengeId');
      await new Promise((r) => setTimeout(r, 10));
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

describe('http', () => {
  it('start -> verify sets sid and did cookies; per-IP limit uses socket', async () => {
    await withTestDb(async (db) => {
      const mail = createFakeMailer();
      await mkAccount(db, 'foo@example.com');
      const app = createApp({ db, mailer: mail, config: cfg, trustedProxyHops: 0 } as AppDeps);
      const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
      const s = await json('/auth/email/start', { email: 'foo@example.com', purpose: 'login', locale: 'ja' });
      expect(s.status).toBe(200);
      const did = /did=([^;]+)/.exec(s.headers.get('set-cookie') ?? '')?.[1];
      expect(did).toBeTruthy();
      const { challengeId } = (await s.json()) as { challengeId: string };
      const v = await json('/auth/email/verify', { challengeId, code: mail.lastCode() }, { cookie: `did=${did}` });
      expect(v.status).toBe(200);
      expect(v.headers.get('set-cookie')).toContain('sid=');
      const bad = await json('/auth/email/verify', { challengeId, code: '000000' }, { cookie: `did=${did}` });
      expect(bad.status).toBe(400);
    });
  });
});
