import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { grants, owners, studentVerifications } from '../db/schema.js';
import { ownerGrantFilter, resolveEntitlements } from './entitlements.js';

/** Only the signed-in account's personal plan; team plans stay on their apps. */
export async function getPlanStatus(db: Db, accountId: string) {
  const [owner] = await withAccount(db, accountId, (tx) => tx.select({ id: owners.id }).from(owners)
    .where(and(eq(owners.kind, 'account'), eq(owners.accountId, accountId))));
  if (!owner) return { plan: 'none', endsAt: null, suspendOn: null };
  const now = new Date();
  const { plan } = await resolveEntitlements(db, owner.id, now);
  // Keep the last expiry and stop date visible during April's renewal grace period.
  const [grant] = await withSystem(db, async (tx) => {
    const mine = await ownerGrantFilter(tx, owner.id);
    return tx.select({ endsAt: grants.endsAt, suspendOn: grants.suspendOn }).from(grants)
      .where(and(mine, isNull(grants.revokedAt), lte(grants.startsAt, now), inArray(grants.kind, ['student', 'starter']),
        plan === 'none' ? lte(grants.endsAt, now) : eq(grants.kind, plan)))
      .orderBy(desc(grants.endsAt)).limit(1);
  });
  return { plan, endsAt: grant?.endsAt ?? null, suspendOn: grant?.suspendOn ?? null };
}

export async function getVerificationStatus(db: Db, accountId: string) {
  const [row] = await withAccount(db, accountId, (tx) => tx.select({
    status: studentVerifications.status, rejectReason: studentVerifications.rejectReason,
    validUntil: studentVerifications.validUntil,
  }).from(studentVerifications).where(eq(studentVerifications.accountId, accountId))
    .orderBy(desc(studentVerifications.createdAt), desc(studentVerifications.id)).limit(1));
  return { verification: row ?? null };
}
