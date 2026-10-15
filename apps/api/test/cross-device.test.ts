import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, emailChallenges } from '../src/db/schema.js';
import { encryptEmail, hashEmail, normalizeEmail } from '../src/crypto/email.js';
import { startEmailChallenge } from '../src/auth/email-login.js';
import {
  completeCrossDeviceLogin, confirmNumber, getConfirmChoices, getRequesterScreen, openEmailLink,
} from '../src/auth/cross-device.js';
import { verifyEmailCode } from '../src/auth/email-login.js';
import { createApp } from '../src/http/app.js';

const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };


async function acct(db: TestDb, email: string) {
  const n = normalizeEmail(email);
  const [a] = await db.insert(accounts).values({
    emailHash: hashEmail(n, cfg.emailHashKey), emailEnc: encryptEmail(n, cfg.emailEncKey),
    displayName: 'A', locale: 'ja', adultFrom: '2030-01',
  }).returning();
  return a!;
}

async function mk(db: TestDb, email = 'foo@example.com', purpose: 'login' | 'signup' = 'login') {
  const mail = createFakeMailer();
  const r = await startEmailChallenge(db, mail, { email, purpose, locale: 'ja', requesterDeviceId: 'd1', requesterDeviceLabel: 'Mac / Safari' }, cfg);
  if (!('challengeId' in r)) throw new Error('rate');
  await new Promise((res) => setTimeout(res, 20));
  return { id: r.challengeId, tok: mail.lastLinkToken() };
}
const tokenOf = (s: { qrPayload: string }) => new URL(s.qrPayload).searchParams.get('s')!;
const wrong = (choices: number[], n: number) => choices.find((c) => c !== n)!;

async function pending(db: TestDb) {
  const { id, tok } = await mk(db);
  expect(await openEmailLink(db, id, tok, 'phone')).toEqual({ result: 'cross_device_pending' });
  const scr = await getRequesterScreen(db, id, 'd1', cfg.appOrigin);
  if (scr.state !== 'awaiting_scan') throw new Error('state');
  return { id, tok, scr, s: tokenOf(scr) };
}

describe('cross-device login', () => {
  it('same device logs in once; token is single use', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'foo@example.com');
      const { id, tok } = await mk(db);
      expect(await openEmailLink(db, id, 'bad', 'd1')).toEqual({ error: 'invalid' });
      expect(await openEmailLink(db, id, tok, 'd1')).toEqual({ result: 'logged_in', accountId: a.id });
      expect(await openEmailLink(db, id, tok, 'd1')).toEqual({ error: 'invalid' });
    });
  });

  it('refuses signup and unknown-email challenges', async () => {
    await withTestDb(async (db) => {
      const s = await mk(db, 'new@example.com', 'signup');
      expect(await openEmailLink(db, s.id, s.tok, 'd1')).toEqual({ error: 'invalid' });
      const u = await mk(db, 'nobody@example.com', 'login');
      expect(await openEmailLink(db, u.id, u.tok, 'd1')).toEqual({ error: 'invalid' });
    });
  });

  it('reports expiry', async () => {
    await withTestDb(async (db) => {
      await acct(db, 'foo@example.com');
      const { id, tok } = await mk(db);
      await db.update(emailChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(emailChallenges.id, id));
      expect(await openEmailLink(db, id, tok, 'phone')).toEqual({ error: 'expired' });
    });
  });

  it('full cross-device flow with number matching', async () => {
    await withTestDb(async (db) => {
      await acct(db, 'foo@example.com');
      const { id, tok } = await mk(db);
      expect(await openEmailLink(db, id, tok, 'phone')).toEqual({ result: 'cross_device_pending' });
      expect(await openEmailLink(db, id, tok, 'phone')).toEqual({ error: 'invalid' }); // link token consumed
      expect(await getRequesterScreen(db, id, 'attacker', cfg.appOrigin)).toEqual({ state: 'none' });
      const scr = await getRequesterScreen(db, id, 'd1', cfg.appOrigin);
      if (scr.state !== 'awaiting_scan') throw new Error('state');
      expect(scr.qrPayload.startsWith(`https://app.example.com/login/confirm?c=${id}&s=`)).toBe(true);
      expect(scr.number).toBeGreaterThanOrEqual(10);
      expect(scr.number).toBeLessThanOrEqual(99);
      // polling returns the same, still-valid QR
      const again = await getRequesterScreen(db, id, 'd1', cfg.appOrigin);
      expect(again).toEqual(scr);
      const r = await getConfirmChoices(db, id, tokenOf(scr));
      if ('error' in r) throw new Error('choices');
      expect(r.choices).toContain(scr.number);
      expect(new Set(r.choices).size).toBe(3);
      expect(r.requesterDevice).toBe('Mac / Safari');
      expect(r.region).toBeNull();
      expect(await completeCrossDeviceLogin(db, id, 'd1')).toEqual({ error: 'invalid' }); // not yet approved
      expect(await confirmNumber(db, id, tokenOf(scr), scr.number)).toEqual({ ok: true });
      expect((await getRequesterScreen(db, id, 'd1', cfg.appOrigin)).state).toBe('approved');
      expect(await completeCrossDeviceLogin(db, id, 'attacker')).toEqual({ error: 'invalid' });
      const done = await completeCrossDeviceLogin(db, id, 'd1');
      expect('accountId' in done).toBe(true);
      expect(await completeCrossDeviceLogin(db, id, 'd1')).toEqual({ error: 'invalid' });
    });
  });

  it('a wrong number invalidates the challenge', async () => {
    await withTestDb(async (db) => {
      await acct(db, 'foo@example.com');
      const { id, scr, s } = await pending(db);
      const r = await getConfirmChoices(db, id, s);
      if ('error' in r) throw new Error('choices');
      expect(await confirmNumber(db, id, s, wrong(r.choices, scr.number))).toEqual({ error: 'mismatch' });
      expect(await confirmNumber(db, id, s, scr.number)).toEqual({ error: 'invalid' });
      expect(await getConfirmChoices(db, id, s)).toEqual({ error: 'invalid' });
      expect(await getRequesterScreen(db, id, 'd1', cfg.appOrigin)).toEqual({ state: 'none' });
      expect(await completeCrossDeviceLogin(db, id, 'd1')).toEqual({ error: 'invalid' });
      const [row] = await db.select().from(emailChallenges).where(eq(emailChallenges.id, id));
      expect(row!.crossDeviceState).toBe('failed');
    });
  });

  it('a failed challenge cannot be completed by typing the code', async () => {
    await withTestDb(async (db) => {
      await acct(db, 'foo@example.com');
      const mail = createFakeMailer();
      const r = await startEmailChallenge(db, mail, { email: 'foo@example.com', purpose: 'login', locale: 'ja', requesterDeviceId: 'd1' }, cfg);
      if (!('challengeId' in r)) throw new Error('rate');
      await new Promise((res) => setTimeout(res, 20));
      await openEmailLink(db, r.challengeId, mail.lastLinkToken(), 'phone');
      const scr = await getRequesterScreen(db, r.challengeId, 'd1', cfg.appOrigin);
      if (scr.state !== 'awaiting_scan') throw new Error('state');
      const ch = await getConfirmChoices(db, r.challengeId, tokenOf(scr));
      if ('error' in ch) throw new Error('choices');
      await confirmNumber(db, r.challengeId, tokenOf(scr), wrong(ch.choices, scr.number));
      expect(await verifyEmailCode(db, r.challengeId, mail.lastCode(), 'd1')).toEqual({ error: 'invalid' });
    });
  });

  it('malformed 36-char ids are invalid, not 500', async () => {
    await withTestDb(async (db) => {
      const bad = 'z'.repeat(8) + '-' + 'z'.repeat(4) + '-' + 'z'.repeat(4) + '-' + 'z'.repeat(4) + '-' + 'z'.repeat(12);
      const dashes = '-'.repeat(36);
      for (const x of [bad, dashes]) {
        expect(await openEmailLink(db, x, 't', 'd')).toEqual({ error: 'invalid' });
        expect(await verifyEmailCode(db, x, '123456', 'd')).toEqual({ error: 'invalid' });
      }
    });
  });

  it('a scan token from another challenge fails and kills the target', async () => {
    await withTestDb(async (db) => {
      await acct(db, 'foo@example.com');
      const a = await pending(db);
      const b = await pending(db);
      expect(await confirmNumber(db, b.id, a.s, b.scr.number)).toEqual({ error: 'invalid' });
      expect(await confirmNumber(db, b.id, b.s, b.scr.number)).toEqual({ error: 'invalid' });
      expect(await confirmNumber(db, a.id, a.s, a.scr.number)).toEqual({ ok: true });
    });
  });

  it('expired pending challenge cannot be approved', async () => {
    await withTestDb(async (db) => {
      await acct(db, 'foo@example.com');
      const { id, scr, s } = await pending(db);
      await db.update(emailChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(emailChallenges.id, id));
      expect(await confirmNumber(db, id, s, scr.number)).toEqual({ error: 'invalid' });
      expect(await getRequesterScreen(db, id, 'd1', cfg.appOrigin)).toEqual({ state: 'none' });
    });
  });
});

describe('cross-device http', () => {
  it('link -> screen -> confirm -> complete sets a session', async () => {
    await withTestDb(async (db) => {
      await acct(db, 'foo@example.com');
      const app = createApp({ db, mailer: createFakeMailer(), config: cfg });
      const { id, tok } = await mk(db);
      // opener is a different device (no matching did cookie)
      expect((await app.request(`/auth/email/link?c=${id}&t=${tok}`)).status).toBe(404); // GET must not change state
      const open = await app.request('/auth/email/link', { method: 'POST', body: JSON.stringify({ c: id, t: tok }), headers: { 'user-agent': 'x' } });
      expect(await open.json()).toEqual({ result: 'cross_device_pending' });
      const bad = await app.request(`/auth/email/screen?c=${id}`);
      expect(await bad.json()).toEqual({ state: 'none' });
      expect((await app.request('/auth/email/complete', { method: 'POST', body: JSON.stringify({ challengeId: id }) })).status).toBe(400);
    });
  });
});
