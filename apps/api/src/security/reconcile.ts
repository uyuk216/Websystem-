import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { owners, securityBlocks, teamMembers } from '../db/schema.js';
import { transitionUsageState } from '../usage/state.js';

/** Keep dedicated security reasons separate from quota and manual reasons. Caller holds account lock. */
export async function reconcileAccountSecurity(db: Db, accountId: string): Promise<void> {
  const [block] = await db.select({ id: securityBlocks.id }).from(securityBlocks).where(and(eq(securityBlocks.accountId, accountId), isNull(securityBlocks.releasedAt))).limit(1);
  const teams = db.select({ id: teamMembers.teamId }).from(teamMembers).where(and(eq(teamMembers.accountId, accountId), eq(teamMembers.role, 'owner')));
  const rows = await db.select({ id: owners.id }).from(owners).where(or(eq(owners.accountId, accountId), inArray(owners.teamId, teams)));
  for (const row of rows) await transitionUsageState(db, row.id, block ? 'security_block' : 'security_unblock');
}
