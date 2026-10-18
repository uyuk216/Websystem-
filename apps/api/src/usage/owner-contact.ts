import { and, eq } from 'drizzle-orm';
import type { Locale } from 'i18n';
import { decryptEmail } from '../crypto/email.js';
import { withSystem, type Db } from '../db/client.js';
import { accounts, owners, teamMembers } from '../db/schema.js';

/** Who gets usage mail for an owner: the account itself, or a team's owner member. Null when nobody qualifies. */
export async function ownerContact(db: Db, ownerId: string, emailKey: Buffer): Promise<{ email: string; locale: Locale } | null> {
  const target = await withSystem(db, async (tx) => {
    const [o] = await tx.select({ kind: owners.kind, accountId: owners.accountId, teamId: owners.teamId }).from(owners).where(eq(owners.id, ownerId));
    if (!o) return null;
    let accountId = o.accountId;
    if (o.kind === 'team' && o.teamId) {
      const [m] = await tx.select({ accountId: teamMembers.accountId }).from(teamMembers)
        .where(and(eq(teamMembers.teamId, o.teamId), eq(teamMembers.role, 'owner')));
      accountId = m?.accountId ?? null;
    }
    if (!accountId) return null;
    const [acc] = await tx.select({ emailEnc: accounts.emailEnc, locale: accounts.locale }).from(accounts).where(eq(accounts.id, accountId));
    return acc ?? null;
  });
  if (!target) return null;
  return { email: decryptEmail(target.emailEnc, emailKey), locale: target.locale === 'en' ? 'en' : 'ja' };
}
