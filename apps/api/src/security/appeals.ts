import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { withAccount, withSystem, type Db, type Tx } from '../db/client.js';
import { accounts, apps, owners, securityAppeals, securityIncidents, teamMembers } from '../db/schema.js';
import { appendSecurityAudit } from './incidents.js';

/** A team incident belongs to the owner member, not every collaborator. IP hashes never establish identity. */
export async function incidentAccount(tx: Tx, incident: typeof securityIncidents.$inferSelect): Promise<string | null> {
  if (incident.accountId) return incident.accountId;
  if (!incident.appId) return null;
  const [row] = await tx.select({ accountId: owners.accountId, teamId: owners.teamId }).from(apps).innerJoin(owners, eq(owners.id, apps.ownerId)).where(eq(apps.id, incident.appId));
  if (row?.accountId) return row.accountId;
  if (!row?.teamId) return null;
  const [member] = await tx.select({ id: teamMembers.accountId }).from(teamMembers).where(and(eq(teamMembers.teamId, row.teamId), eq(teamMembers.role, 'owner')));
  return member?.id ?? null;
}

/** Only fixed, public text; detector codes, evidence and digests never cross this boundary. */
export function publicReason(locale: Locale): string { return t(locale, 'security.reason'); }
export async function userIncidents(db: Db, accountId: string, locale: Locale) {
  return withAccount(db, accountId, async (tx) => {
    const rows = await tx.select({ id: securityIncidents.id, status: securityIncidents.status, severity: securityIncidents.severity, createdAt: securityIncidents.createdAt }).from(securityIncidents).where(sql`${securityIncidents.accountId} = ${accountId} OR ${securityIncidents.appId} IN (
      SELECT a.id FROM apps a JOIN owners o ON o.id = a.owner_id WHERE o.account_id = ${accountId}
      OR o.team_id IN (SELECT team_id FROM team_members WHERE account_id = ${accountId} AND role = 'owner'))`)
      .orderBy(desc(securityIncidents.createdAt)).limit(100);
    return rows.map((r) => ({ id: r.id, status: r.status, severity: r.severity, reason: publicReason(locale), action: t(locale, 'security.action'), createdAt: r.createdAt }));
  });
}
export async function submitAppeal(db: Db, accountId: string, incidentId: string, message: unknown, now = new Date()): Promise<'ok' | 'not_found' | 'invalid' | 'rate_limited'> {
  if (typeof message !== 'string' || !message.trim() || [...message].length > 2000) return 'invalid';
  return withSystem(db, async (tx) => {
    // Serializes limits across sessions/processes, rather than trusting an in-memory limiter.
    await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for('update');
    const [incident] = await tx.select().from(securityIncidents).where(eq(securityIncidents.id, incidentId));
    if (!incident || await incidentAccount(tx, incident) !== accountId) return 'not_found';
    const history = await tx.select({ incidentId: securityAppeals.incidentId, at: securityAppeals.createdAt }).from(securityAppeals)
      .where(and(eq(securityAppeals.accountId, accountId), gte(securityAppeals.createdAt, new Date(now.getTime() - 86400_000))));
    const [total] = await tx.select({ count: sql<number>`count(*)::int` }).from(securityAppeals).where(and(eq(securityAppeals.accountId, accountId), eq(securityAppeals.incidentId, incidentId)));
    if ((total?.count ?? 0) >= 3 || history.length >= 5) return 'rate_limited';
    await tx.insert(securityAppeals).values({ accountId, incidentId, message: message.trim(), createdAt: now });
    await appendSecurityAudit(tx, incidentId, 'appeal.received', {});
    return 'ok';
  });
}
