import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { withSystem, type Db } from '../db/client.js';
import { accounts, emailChallenges } from '../db/schema.js';
import { hashEmail, normalizeEmail } from '../crypto/email.js';
import type { Mailer } from '../mail/mailer.js';

export const CHALLENGE_TTL_MS = 10 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const START_MAX_PER_EMAIL = 3;

export interface EmailLoginConfig {
  emailHashKey: Buffer;
  appOrigin: string;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Constant-time comparison of two hex SHA-256 digests. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export async function startEmailChallenge(
  db: Db,
  mailer: Mailer,
  input: { email: string; purpose: 'login' | 'signup'; locale: Locale; requesterDeviceId: string; requesterDeviceLabel?: string },
  cfg: EmailLoginConfig,
): Promise<{ challengeId: string } | { error: 'rate_limited' }> {
  const email = normalizeEmail(input.email);
  const emailHash = hashEmail(email, cfg.emailHashKey);
  const code = newCode();
  const token = randomBytes(32).toString('base64url');

  // Pre-authentication: nothing identifies the account yet.
  const [account] = await withSystem(db, (tx) => tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.emailHash, emailHash)));
  // Rows live exactly TTL, so "expires in the future" == "started within the last 10 minutes".
  const challengeId = await withSystem(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'challenge:' + emailHash}))`);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(emailChallenges)
      .where(and(eq(emailChallenges.emailHash, emailHash), gt(emailChallenges.expiresAt, new Date())));
    if ((row?.n ?? 0) >= START_MAX_PER_EMAIL) return null;
    const [c] = await tx.insert(emailChallenges).values({
      accountId: input.purpose === 'login' ? (account?.id ?? null) : null,
      emailHash,
      purpose: input.purpose,
      codeHash: sha256Hex(code),
      linkTokenHash: sha256Hex(token),
      requesterDeviceId: input.requesterDeviceId,
      requesterDeviceLabel: input.requesterDeviceLabel ?? null,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    }).returning({ id: emailChallenges.id });
    return c!.id;
  });
  if (!challengeId) return { error: 'rate_limited' };

  // Fire-and-forget so latency does not reveal whether a mail was sent (account existence).
  let send: (() => Promise<void>) | null = null;
  if (input.purpose === 'signup' && account) {
    const subject = t(input.locale, 'login.existsSubject');
    const body = t(input.locale, 'login.existsBody', { origin: cfg.appOrigin });
    send = () => mailer.sendMail(email, subject, body);
  } else if (input.purpose === 'signup') {
    // The link continues the signup in the same browser (it must still match the device that started it).
    const link = `${cfg.appOrigin}/${input.locale}/signup?c=${challengeId}&t=${token}`;
    const subject = t(input.locale, 'login.mailSubject');
    const body = t(input.locale, 'signup.mailBody', { code, link });
    send = () => mailer.sendMail(email, subject, body);
  } else if (account) {
    const link = `${cfg.appOrigin}/login/link?c=${challengeId}&t=${token}`;
    const subject = t(input.locale, 'login.mailSubject');
    const body = t(input.locale, 'login.mailBody', { code, link });
    send = () => mailer.sendMail(email, subject, body);
  }
  // Promise.resolve().then also catches synchronous throws from sendMail.
  if (send) void Promise.resolve().then(send).catch((err: unknown) => console.error('email challenge mail failed', err));
  return { challengeId };
}

export type ChallengeCheck = { ok: true; accountId: string | null; emailHash: string } | { error: 'invalid' | 'expired' | 'locked' };

/** Shared by login verify and signup: checks a challenge row inside `tx` and consumes it on success. */
export async function consumeChallenge(
  tx: Pick<Db, 'select' | 'update'>,
  challengeId: string,
  code: string,
  purpose: 'login' | 'signup',
  requesterDeviceId: string | null,
  /** 'link': `code` is the mailed link token (signup by link) instead of the 6-digit code. */
  by: 'code' | 'link' = 'code',
): Promise<ChallengeCheck> {
  const [c] = await tx.select().from(emailChallenges).where(eq(emailChallenges.id, challengeId)).for('update');
  if (!c || c.consumedAt || c.purpose !== purpose || c.crossDeviceState === 'failed') return { error: 'invalid' };
  if (requesterDeviceId !== null && c.requesterDeviceId !== requesterDeviceId) return { error: 'invalid' };
  if (c.attempts >= CHALLENGE_MAX_ATTEMPTS) return { error: 'locked' };
  if (c.expiresAt.getTime() <= Date.now()) return { error: 'expired' };
  if (!hashesEqual(by === 'link' ? c.linkTokenHash : c.codeHash, sha256Hex(code))) {
    await tx.update(emailChallenges).set({ attempts: c.attempts + 1 }).where(eq(emailChallenges.id, c.id));
    return { error: 'invalid' };
  }
  await tx.update(emailChallenges).set({ consumedAt: new Date() }).where(eq(emailChallenges.id, c.id));
  return { ok: true, accountId: c.accountId, emailHash: c.emailHash };
}

export async function verifyEmailCode(
  db: Db,
  challengeId: string,
  code: string,
  requesterDeviceId: string,
): Promise<{ accountId: string } | { error: 'invalid' | 'expired' | 'locked' }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(challengeId)) return { error: 'invalid' };
  return withSystem(db, async (tx) => {
    const r = await consumeChallenge(tx, challengeId, code, 'login', requesterDeviceId);
    if ('error' in r) return r;
    return r.accountId ? { accountId: r.accountId } : { error: 'invalid' as const };
  });
}
