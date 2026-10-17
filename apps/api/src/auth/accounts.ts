import { eq } from 'drizzle-orm';
import type { Locale } from 'i18n';
import { checkAge } from 'shared';
import { withSystem, type Db } from '../db/client.js';
import { accounts, emailChallenges } from '../db/schema.js';
import { encryptEmail, hashEmail, normalizeEmail } from '../crypto/email.js';
import { ensureAccountOwner } from '../teams/teams.js';
import { consumeChallenge } from './email-login.js';
import { generateRecoveryCode, hashRecoveryCode } from './recovery.js';

export interface RegisterConfig {
  emailHashKey: Buffer;
  emailEncKey: Buffer;
}

/**
 * Creates an account from a verified signup challenge. The email must be re-supplied
 * (challenges store only its hash) and is checked against the challenge. The birth date
 * is used only to derive `adultFrom` and is never stored.
 */
export async function registerAccount(
  db: Db,
  input: { challengeId: string; code: string; by?: 'code' | 'link'; email: string; requesterDeviceId: string; displayName: string; birthDate: string; locale: Locale },
  cfg: RegisterConfig,
): Promise<{ accountId: string; recoveryCode: string } | { error: 'under13' | 'invalid' | 'exists' }> {
  const age = checkAge(input.birthDate, new Date());
  if (!age.ok) return { error: age.reason };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.challengeId)) return { error: 'invalid' };
  const email = normalizeEmail(input.email);
  const emailHash = hashEmail(email, cfg.emailHashKey);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = await hashRecoveryCode(recoveryCode);

  return withSystem(db, async (tx) => {
    const r = await consumeChallenge(tx, input.challengeId, input.code, 'signup', input.requesterDeviceId, input.by ?? 'code');
    if ('error' in r) return { error: 'invalid' as const };
    if (r.emailHash !== emailHash) return { error: 'invalid' as const };
    const [dup] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.emailHash, emailHash));
    if (dup) return { error: 'exists' as const };
    const [a] = await tx.insert(accounts).values({
      emailHash, emailEnc: encryptEmail(email, cfg.emailEncKey), displayName: input.displayName,
      locale: input.locale, adultFrom: age.adultFrom, recoveryCodeHash,
    }).onConflictDoNothing().returning({ id: accounts.id });
    if (!a) return { error: 'exists' as const };
    await ensureAccountOwner(tx, a.id);
    await tx.update(emailChallenges).set({ accountId: a.id }).where(eq(emailChallenges.id, input.challengeId));
    return { accountId: a.id, recoveryCode };
  });
}
