import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateRecoveryCode } from 'shared';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, passkeys, recoveryRequests, sessions } from '../src/db/schema.js';
import { createSession, resolveSession } from '../src/auth/sessions.js';
import { encryptEmail, hashEmail, normalizeEmail } from '../src/crypto/email.js';
import { approveRecovery, hashRecoveryCode, requestRecovery, verifyRecoveryCode } from '../src/auth/recovery.js';

const ADMIN = 'admin@example.com';
const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: ADMIN };
const toFullWidth = (s: string) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

async function mkAccount(db: TestDb, email: string, code: string) {
  const n = normalizeEmail(email);
  const [a] = await db.insert(accounts).values({
    emailHash: hashEmail(n, cfg.emailHashKey), emailEnc: encryptEmail(n, cfg.emailEncKey),
    displayName: 'A', locale: 'ja', adultFrom: '2030-01', recoveryCodeHash: await hashRecoveryCode(code),
  }).returning();
  return a!;
}

describe('hash/verify', () => {
  it('verifies normalized input', async () => {
    const code = generateRecoveryCode();
    const h = await hashRecoveryCode(code);
    expect(h).toContain('$argon2id$');
    expect(await verifyRecoveryCode(toFullWidth(code), h)).toBe(true);
    expect(await verifyRecoveryCode(` ${code.slice(0, 8)}-${code.slice(8)} `, h)).toBe(true);
    expect(await verifyRecoveryCode(code.slice(0, 15) + 'X', h)).toBe(false);
  });
});

describe('recovery requests', () => {
  it('request -> approve flow', () =>
    withTestDb(async (db) => {
      const mail = createFakeMailer();
      const codeOfA = generateRecoveryCode();
      const a = await mkAccount(db, 'a@x.y', codeOfA);
      const { token } = await createSession(db, a.id, 'Mac');
      await db.insert(passkeys).values({ id: 'pk', accountId: a.id, publicKey: Buffer.from([1]) });

      expect(await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: 'wrong' }, cfg)).toEqual({ error: 'invalid' });
      expect(await requestRecovery(db, mail, { email: 'nobody@x.y', recoveryCode: codeOfA }, cfg)).toEqual({ error: 'invalid' });
      expect(mail.sentTo(ADMIN)).toBe(0);

      const r = await requestRecovery(db, mail, { email: ' A@X.Y ', recoveryCode: codeOfA }, cfg);
      if ('error' in r) throw new Error('expected ok');
      expect(mail.sentTo(ADMIN)).toBe(1);
      const body = mail.lastBodyTo(ADMIN)!;
      expect(body).not.toContain(codeOfA);
      expect(body).not.toContain('a@x.y');
      expect(body).toContain(r.requestId);

      const { newRecoveryCode } = await approveRecovery(db, mail, r.requestId, cfg);
      expect(newRecoveryCode).not.toBe(codeOfA);
      expect(await resolveSession(db, token)).toBeNull();
      expect(await db.select().from(passkeys).where(eq(passkeys.accountId, a.id))).toHaveLength(0);
      expect((await db.select().from(sessions)).every((s) => s.revokedAt)).toBe(true);
      const [req] = await db.select().from(recoveryRequests);
      expect(req!.status).toBe('approved');
      expect(req!.decidedAt).not.toBeNull();
      expect(mail.sentTo('a@x.y')).toBe(1);
      expect(mail.lastBodyTo('a@x.y')).not.toContain(newRecoveryCode);

      expect(await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: codeOfA }, cfg)).toEqual({ error: 'invalid' });
      expect('requestId' in await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: newRecoveryCode }, cfg)).toBe(true);
      await expect(approveRecovery(db, mail, r.requestId, cfg)).rejects.toThrow(); // already decided
    }));

  it('rate limits 5 attempts per hour per email hash', () =>
    withTestDb(async (db) => {
      const mail = createFakeMailer();
      await mkAccount(db, 'a@x.y', generateRecoveryCode());
      for (let i = 0; i < 5; i++) {
        expect(await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: 'bad' }, cfg)).toEqual({ error: 'invalid' });
      }
      expect(await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: 'bad' }, cfg)).toEqual({ error: 'rate_limited' });
    }));
});

describe('mail failures', () => {
  it('approve still returns the code; admin mail failure still yields requestId', () =>
    withTestDb(async (db) => {
      const code = generateRecoveryCode();
      await mkAccount(db, 'a@x.y', code);
      const bad = { async sendMail() { throw new Error('smtp down'); } };
      const r = await requestRecovery(db, bad, { email: 'a@x.y', recoveryCode: code }, cfg);
      if ('error' in r) throw new Error('expected ok');
      const out = await approveRecovery(db, bad, r.requestId, cfg);
      expect(out.mailFailed).toBe(true);
      expect(out.newRecoveryCode).toHaveLength(16);
      const [row] = await db.select().from(accounts);
      expect(await verifyRecoveryCode(out.newRecoveryCode, row!.recoveryCodeHash!)).toBe(true);
    }));
});

describe('approve with undecryptable email', () => {
  it('rejects and changes nothing', () =>
    withTestDb(async (db) => {
      const mail = createFakeMailer();
      const code = generateRecoveryCode();
      const a = await mkAccount(db, 'a@x.y', code);
      const { token } = await createSession(db, a.id, 'Mac');
      await db.insert(passkeys).values({ id: 'pk', accountId: a.id, publicKey: Buffer.from([1]) });
      const r = await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: code }, cfg);
      if ('error' in r) throw new Error('expected ok');
      await db.update(accounts).set({ emailEnc: 'corrupt' });
      await expect(approveRecovery(db, mail, r.requestId, cfg)).rejects.toThrow();
      expect(await resolveSession(db, token)).not.toBeNull();
      expect(await db.select().from(passkeys)).toHaveLength(1);
      const [acc] = await db.select().from(accounts);
      expect(await verifyRecoveryCode(code, acc!.recoveryCodeHash!)).toBe(true);
      expect((await db.select().from(recoveryRequests))[0]!.status).toBe('pending');
    }));
});
