import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import type { Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { decryptEmail } from '../crypto/email.js';
import { accounts, loginEvents } from '../db/schema.js';

export const LOGIN_EVENT_RETENTION_MS = 30 * 86400_000;

const v4Prefix = (ip: string): string => `${ip.split('.').slice(0, 3).join('.')}.0/24`;

/** Expands an IPv6 address to 8 16-bit groups, or null when malformed. */
function groups6(ip: string): number[] | null {
  let s = ip.split('%')[0]!.toLowerCase();
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (!isIPv4(m[2]!)) return null;
    const o = m[2]!.split('.').map(Number);
    s = `${m[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, tail, extra] = s.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const tl = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - tl.length;
  if (fill < (tail === undefined ? 0 : 1)) return null;
  const all = [...h, ...Array<string>(fill).fill('0'), ...tl].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** Coarse IP for storage: IPv4 -> a.b.c.0/24, IPv6 -> upper 48 bits (/48). IPv4-mapped IPv6 is treated as IPv4. */
export function maskIp(ip: string): string {
  if (isIPv4(ip)) return v4Prefix(ip);
  if (!isIPv6(ip.split('%')[0]!)) return 'unknown';
  const g = groups6(ip);
  if (!g) return 'unknown';
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return v4Prefix(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  }
  return `${g[0]!.toString(16)}:${g[1]!.toString(16)}:${g[2]!.toString(16)}::/48`;
}

export interface RecordLoginInput {
  accountId: string;
  method: 'passkey' | 'email' | 'recovery';
  deviceLabel: string;
  ip: string;
  /** Value of the `did` device cookie. */
  deviceId: string;
}

const deviceKeyOf = (deviceId: string): string => createHash('sha256').update(deviceId).digest('hex');

/** Records a successful login; the first login from a device (by did cookie) mails the account owner (fire-and-forget). */
export async function recordLogin(db: Db, mailer: Mailer, input: RecordLoginInput, cfg: { emailEncKey: Buffer }): Promise<void> {
  const deviceKey = deviceKeyOf(input.deviceId);
  const now = new Date();
  const isNew = await db.transaction(async (tx) => {
    // Serialize per (account, device) so concurrent first logins send a single mail.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.accountId + ':' + deviceKey}, 0))`);
    const [prior] = await tx.select({ id: loginEvents.id }).from(loginEvents)
      .where(and(eq(loginEvents.accountId, input.accountId), eq(loginEvents.deviceKey, deviceKey))).limit(1);
    await tx.insert(loginEvents).values({
      accountId: input.accountId, method: input.method, deviceLabel: input.deviceLabel, ipPrefix: maskIp(input.ip), deviceKey, createdAt: now,
    });
    return !prior;
  });
  if (!isNew) return;
  const [acct] = await db.select({ emailEnc: accounts.emailEnc, locale: accounts.locale }).from(accounts).where(eq(accounts.id, input.accountId));
  if (!acct) return;
  const locale: Locale = acct.locale === 'en' ? 'en' : 'ja';
  const subject = t(locale, 'login.newDeviceSubject');
  const body = t(locale, 'login.newDeviceBody', { device: input.deviceLabel, time: now.toISOString() });
  void Promise.resolve()
    .then(() => mailer.sendMail(decryptEmail(acct.emailEnc, cfg.emailEncKey), subject, body))
    .catch((err: unknown) => console.error('new device mail failed', err));
}

export async function listLoginEvents(db: Db, accountId: string, limit = 50) {
  return db
    .select({ id: loginEvents.id, method: loginEvents.method, deviceLabel: loginEvents.deviceLabel, region: loginEvents.region, ipPrefix: loginEvents.ipPrefix, createdAt: loginEvents.createdAt })
    .from(loginEvents)
    .where(eq(loginEvents.accountId, accountId))
    .orderBy(desc(loginEvents.createdAt))
    .limit(limit);
}

/** Deletes login events older than 30 days. Returns the number of rows removed. */
export async function purgeOldLoginEvents(db: Db, now: Date): Promise<number> {
  const rows = await db.delete(loginEvents).where(lt(loginEvents.createdAt, new Date(now.getTime() - LOGIN_EVENT_RETENTION_MS))).returning({ id: loginEvents.id });
  return rows.length;
}
