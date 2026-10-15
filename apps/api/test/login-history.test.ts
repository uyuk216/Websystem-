import { describe, expect, it } from 'vitest';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts } from '../src/db/schema.js';
import { encryptEmail } from '../src/crypto/email.js';
import { listLoginEvents, maskIp, purgeOldLoginEvents, recordLogin } from '../src/auth/login-history.js';

const cfg = { emailEncKey: Buffer.alloc(32, 1) };
async function mk(db: TestDb, email: string) {
  const [a] = await db.insert(accounts).values({
    emailHash: email, emailEnc: encryptEmail(email, cfg.emailEncKey), displayName: 'A', locale: 'ja', adultFrom: '2030-01',
  }).returning();
  return a!;
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('maskIp', () => {
  it('masks IPv4 /24, IPv6 /48, mapped IPv4', () => {
    expect(maskIp('203.0.113.45')).toBe('203.0.113.0/24');
    expect(maskIp('::ffff:203.0.113.45')).toBe('203.0.113.0/24');
    expect(maskIp('::ffff:cb00:712d')).toBe('203.0.113.0/24');
    expect(maskIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::/48');
    expect(maskIp('2001:0DB8:1::9')).toBe('2001:db8:1::/48');
    expect(maskIp('::1')).toBe('0:0:0::/48');
    expect(maskIp('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(maskIp('unknown')).toBe('unknown');
  });
});

describe('login history', () => {
  it('records masked ip, notifies only on first login from a device, purges after 30 days', () =>
    withTestDb(async (db) => {
      const mail = createFakeMailer();
      const a = await mk(db, 'a@x.y');
      const input = { accountId: a.id, method: 'email' as const, deviceLabel: 'Mac / Safari', ip: '203.0.113.45', deviceId: 'dev1' };
      await recordLogin(db, mail, input, cfg);
      await flush();
      expect((await listLoginEvents(db, a.id))[0]!.ipPrefix).toBe('203.0.113.0/24');
      expect(mail.sentTo('a@x.y')).toBe(1);
      mail.clear();
      await recordLogin(db, mail, input, cfg);
      await flush();
      expect(mail.sentTo('a@x.y')).toBe(0);
      await recordLogin(db, mail, { ...input, deviceId: 'dev2' }, cfg);
      await flush();
      expect(mail.sentTo('a@x.y')).toBe(1);
      const now = new Date();
      await purgeOldLoginEvents(db, new Date(now.getTime() + 29 * 86400_000));
      expect(await listLoginEvents(db, a.id)).toHaveLength(3);
      await purgeOldLoginEvents(db, new Date(now.getTime() + 31 * 86400_000));
      expect(await listLoginEvents(db, a.id)).toHaveLength(0);
    }));

  it('concurrent first logins send one mail; mail failure does not throw; limit and isolation', () =>
    withTestDb(async (db) => {
      const mail = createFakeMailer();
      const a = await mk(db, 'a@x.y');
      const b = await mk(db, 'b@x.y');
      const input = { accountId: a.id, method: 'passkey' as const, deviceLabel: 'x', ip: '2001:db8:1::5', deviceId: 'd' };
      await Promise.all([recordLogin(db, mail, input, cfg), recordLogin(db, mail, input, cfg)]);
      await flush();
      expect(mail.sentTo('a@x.y')).toBe(1);
      await recordLogin(db, { sendMail: () => { throw new Error('smtp'); } }, { ...input, accountId: b.id }, cfg);
      expect(await listLoginEvents(db, a.id, 1)).toHaveLength(1);
      expect((await listLoginEvents(db, a.id))[0]!.ipPrefix).toBe('2001:db8:1::/48');
      expect(await listLoginEvents(db, b.id)).toHaveLength(1);
    }));
});
