import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { t } from 'i18n';
import { generateRecoveryCode, normalizeRecoveryInput } from 'shared';
import { hash, verify } from '@node-rs/argon2';
import { withSystem, type Db } from '../db/client.js';
import { accounts, passkeys, recoveryAttempts, recoveryRequests, sessions } from '../db/schema.js';
import { decryptEmail, hashEmail, normalizeEmail } from '../crypto/email.js';
import type { Mailer } from '../mail/mailer.js';

export { generateRecoveryCode, normalizeRecoveryInput };

// algorithm 2 = Argon2id (the library's const enum is unusable under verbatimModuleSyntax)
const ARGON_OPTS = { algorithm: 2 as const, memoryCost: 19456, timeCost: 2 };
export const RECOVERY_MAX_ATTEMPTS = 5;
export const RECOVERY_WINDOW_MS = 3600_000;

export const hashRecoveryCode = (code: string): Promise<string> => hash(normalizeRecoveryInput(code), ARGON_OPTS);

export async function verifyRecoveryCode(input: string, hashed: string): Promise<boolean> {
  try {
    return await verify(hashed, normalizeRecoveryInput(input));
  } catch {
    return false;
  }
}

export interface RecoveryRequestConfig {
  emailHashKey: Buffer;
  adminEmail: string;
}
export interface RecoveryApproveConfig {
  emailEncKey: Buffer;
}

// Verified against a throwaway hash when the account is missing, so timing does not reveal registration.
let dummyHash: Promise<string> | undefined;

export async function requestRecovery(
  db: Db,
  mailer: Mailer,
  input: { email: string; recoveryCode: string },
  cfg: RecoveryRequestConfig,
): Promise<{ requestId: string } | { error: 'invalid' | 'rate_limited' }> {
  const emailHash = hashEmail(normalizeEmail(input.email), cfg.emailHashKey);

  // Atomically count + record this attempt (advisory lock per email hash) so concurrent calls cannot exceed the limit.
  const allowed = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'recovery:' + emailHash}))`);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(recoveryAttempts)
      .where(and(eq(recoveryAttempts.emailHash, emailHash), gt(recoveryAttempts.createdAt, new Date(Date.now() - RECOVERY_WINDOW_MS))));
    if ((row?.n ?? 0) >= RECOVERY_MAX_ATTEMPTS) return false;
    await tx.insert(recoveryAttempts).values({ emailHash });
    return true;
  });
  if (!allowed) return { error: 'rate_limited' };

  const [account] = await db.select({ id: accounts.id, recoveryCodeHash: accounts.recoveryCodeHash }).from(accounts).where(eq(accounts.emailHash, emailHash));
  const target = account?.recoveryCodeHash ?? (await (dummyHash ??= hashRecoveryCode('dummy-recovery-code')));
  const ok = await verifyRecoveryCode(input.recoveryCode, target);
  if (!account || !account.recoveryCodeHash || !ok) return { error: 'invalid' };

  const [req] = await db.insert(recoveryRequests).values({ accountId: account.id }).returning({ id: recoveryRequests.id });
  const requestId = req!.id;
  try {
    await mailer.sendMail(cfg.adminEmail, t('ja', 'recovery.adminSubject') + ' / ' + t('en', 'recovery.adminSubject'),
      t('ja', 'recovery.adminBody', { requestId }) + '\n\n' + t('en', 'recovery.adminBody', { requestId }));
  } catch (err) {
    console.error('recovery: failed to notify admin', requestId, err);
  }
  return { requestId };
}

export async function approveRecovery(
  db: Db,
  mailer: Mailer,
  requestId: string,
  cfg: RecoveryApproveConfig,
): Promise<{ newRecoveryCode: string; mailFailed?: true }> {
  const newRecoveryCode = generateRecoveryCode();
  const newHash = await hashRecoveryCode(newRecoveryCode);
  const now = new Date();

  // Decrypt before changing anything: a failure here must leave all state untouched.
  const [target] = await db
    .select({ emailEnc: accounts.emailEnc, locale: accounts.locale })
    .from(recoveryRequests)
    .innerJoin(accounts, eq(accounts.id, recoveryRequests.accountId))
    .where(and(eq(recoveryRequests.id, requestId), eq(recoveryRequests.status, 'pending')));
  if (!target) throw new Error('recovery request not found or already decided');
  const to = decryptEmail(target.emailEnc, cfg.emailEncKey);
  const loc = target.locale === 'en' ? 'en' : 'ja';

  // Admin action across an arbitrary account's sessions and passkeys.
  await withSystem(db, async (tx) => {
    const [req] = await tx
      .update(recoveryRequests)
      .set({ status: 'approved', decidedAt: now })
      .where(and(eq(recoveryRequests.id, requestId), eq(recoveryRequests.status, 'pending')))
      .returning({ accountId: recoveryRequests.accountId });
    if (!req) throw new Error('recovery request not found or already decided');
    await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.accountId, req.accountId), isNull(sessions.revokedAt)));
    await tx.delete(passkeys).where(eq(passkeys.accountId, req.accountId));
    await tx.update(accounts).set({ recoveryCodeHash: newHash }).where(eq(accounts.id, req.accountId));
  });

  try {
    await mailer.sendMail(to, t(loc, 'recovery.approvedSubject'), t(loc, 'recovery.approvedBody'));
  } catch (err) {
    console.error('recovery: failed to notify user', requestId, err);
    return { newRecoveryCode, mailFailed: true };
  }
  return { newRecoveryCode };
}
