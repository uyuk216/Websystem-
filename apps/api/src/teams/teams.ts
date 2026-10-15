import { randomBytes, randomUUID } from 'node:crypto';
import { and, count, eq, gt, isNull } from 'drizzle-orm';
import { t } from 'i18n';
import { TEAM_MAX_MEMBERS, can, type TeamRole } from 'shared';
import { withAccount, withSystem, type Db, type Tx } from '../db/client.js';
import { accounts, owners, teamInvites, teamMembers, teams } from '../db/schema.js';
import { hashEmail, normalizeEmail } from '../crypto/email.js';
import { hashesEqual, sha256Hex } from '../auth/email-login.js';
import { UUID } from '../auth/cross-device.js';
import type { Mailer } from '../mail/mailer.js';

export const INVITE_TTL_MS = 7 * 86_400_000;

export interface TeamsConfig {
  emailHashKey: Buffer;
  appOrigin: string;
}

type TeamError = 'forbidden' | 'full' | 'last_owner' | 'not_member';
export type Ok = { ok: true };

/** Locks the team row for the duration of the transaction; false when it does not exist. */
async function lockTeam(tx: Tx, teamId: string): Promise<boolean> {
  if (!UUID.test(teamId)) return false;
  const rows = await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for('update');
  return rows.length > 0;
}

async function roleOf(tx: Tx, teamId: string, accountId: string): Promise<TeamRole | null> {
  if (!UUID.test(accountId)) return null;
  const [r] = await tx.select({ role: teamMembers.role }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, accountId)));
  return (r?.role as TeamRole | undefined) ?? null;
}

/** Members plus unexpired, unaccepted invites (both occupy a seat). */
async function seatsUsed(tx: Tx, teamId: string, exceptInviteId?: string): Promise<number> {
  const [m] = await tx.select({ n: count() }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
  const pending = and(eq(teamInvites.teamId, teamId), isNull(teamInvites.acceptedAt), gt(teamInvites.expiresAt, new Date()));
  const [i] = await tx.select({ n: count() }).from(teamInvites).where(pending);
  let n = (m?.n ?? 0) + (i?.n ?? 0);
  if (exceptInviteId) {
    const [self] = await tx.select({ id: teamInvites.id }).from(teamInvites).where(and(pending, eq(teamInvites.id, exceptInviteId)));
    if (self) n -= 1;
  }
  return n;
}

/** The personal owner row for an account (created on signup). Idempotent. */
export async function ensureAccountOwner(db: Db | Tx, accountId: string): Promise<string> {
  await db.insert(owners).values({ kind: 'account', accountId }).onConflictDoNothing();
  const [o] = await db.select({ id: owners.id }).from(owners).where(and(eq(owners.kind, 'account'), eq(owners.accountId, accountId)));
  return o!.id;
}

export async function createTeam(db: Db, accountId: string, name: string): Promise<{ teamId: string; ownerId: string }> {
  return withAccount(db, accountId, async (tx) => {
    // Id is generated here: RETURNING would need SELECT visibility before the first member exists.
    const teamId = randomUUID();
    await tx.insert(teams).values({ id: teamId, name });
    await tx.insert(teamMembers).values({ teamId, accountId, role: 'owner' });
    const [o] = await tx.insert(owners).values({ kind: 'team', teamId }).returning({ id: owners.id });
    return { teamId, ownerId: o!.id };
  });
}

export async function listTeams(db: Db, accountId: string): Promise<{ id: string; name: string; role: TeamRole }[]> {
  const rows = await withAccount(db, accountId, (tx) => tx.select({ id: teams.id, name: teams.name, role: teamMembers.role }).from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(eq(teamMembers.accountId, accountId)));
  return rows.map((r) => ({ ...r, role: r.role as TeamRole }));
}

export async function getTeam(db: Db, teamId: string, accountId: string) {
  if (!UUID.test(teamId)) return null;
  return withAccount(db, accountId, async (tx) => {
    const [me] = await tx.select({ role: teamMembers.role }).from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, accountId)));
    if (!me) return null;
    const [team] = await tx.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, teamId));
    const members = await tx.select({ accountId: teamMembers.accountId, role: teamMembers.role, displayName: accounts.displayName })
      .from(teamMembers).innerJoin(accounts, eq(accounts.id, teamMembers.accountId)).where(eq(teamMembers.teamId, teamId));
    return { ...team!, role: me.role as TeamRole, members };
  });
}

export async function inviteMember(
  db: Db, mailer: Mailer, teamId: string, byAccountId: string, email: string, cfg: TeamsConfig,
): Promise<{ inviteId: string } | { error: 'forbidden' | 'full' }> {
  const normalized = normalizeEmail(email);
  const emailHash = hashEmail(normalized, cfg.emailHashKey);
  const token = randomBytes(32).toString('base64url');
  const r = await withAccount(db, byAccountId, async (tx) => {
    if (!(await lockTeam(tx, teamId))) return { error: 'forbidden' as const };
    const role = await roleOf(tx, teamId, byAccountId);
    if (!role || !can(role, 'invite')) return { error: 'forbidden' as const };
    // A re-invite replaces the previous pending invite for the same address.
    await tx.delete(teamInvites).where(and(eq(teamInvites.teamId, teamId), eq(teamInvites.emailHash, emailHash), isNull(teamInvites.acceptedAt)));
    if ((await seatsUsed(tx, teamId)) >= TEAM_MAX_MEMBERS) return { error: 'full' as const };
    const [inv] = await tx.insert(teamInvites).values({
      teamId, emailHash, tokenHash: sha256Hex(token), invitedBy: byAccountId, expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    }).returning({ id: teamInvites.id });
    const [team] = await tx.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
    const [by] = await tx.select({ name: accounts.displayName, locale: accounts.locale }).from(accounts).where(eq(accounts.id, byAccountId));
    return { inviteId: inv!.id, teamName: team!.name, inviter: by!.name, locale: by!.locale === 'en' ? ('en' as const) : ('ja' as const) };
  });
  if ('error' in r) return r;
  const link = `${cfg.appOrigin}/teams/invite?i=${r.inviteId}&t=${token}`;
  const subject = t(r.locale, 'team.inviteSubject', { team: r.teamName });
  const body = t(r.locale, 'team.inviteBody', { inviter: r.inviter, team: r.teamName, link });
  // Fire-and-forget; Promise.resolve().then also catches synchronous throws from sendMail.
  void Promise.resolve().then(() => mailer.sendMail(normalized, subject, body)).catch((err: unknown) => console.error('team invite mail failed', err));
  return { inviteId: r.inviteId };
}

export async function acceptInvite(
  db: Db, inviteId: string, token: string, accountId: string,
): Promise<{ teamId: string } | { error: 'invalid' | 'expired' | 'forbidden' | 'full' }> {
  if (!UUID.test(inviteId) || !UUID.test(accountId)) return { error: 'invalid' };
  // Pre-membership: the invitee cannot see the invite or team under RLS until accepted.
  return withSystem(db, async (tx) => {
    const [pre] = await tx.select({ teamId: teamInvites.teamId }).from(teamInvites).where(eq(teamInvites.id, inviteId));
    if (!pre || !(await lockTeam(tx, pre.teamId))) return { error: 'invalid' as const };
    const [inv] = await tx.select().from(teamInvites).where(eq(teamInvites.id, inviteId)).for('update');
    if (!inv || inv.acceptedAt || !hashesEqual(inv.tokenHash, sha256Hex(token))) return { error: 'invalid' as const };
    if (inv.expiresAt.getTime() <= Date.now()) return { error: 'expired' as const };
    const [acc] = await tx.select({ emailHash: accounts.emailHash }).from(accounts).where(eq(accounts.id, accountId));
    if (!acc) return { error: 'invalid' as const };
    if (acc.emailHash !== inv.emailHash) return { error: 'forbidden' as const };
    if (await roleOf(tx, inv.teamId, accountId)) return { error: 'invalid' as const };
    // This invite's own seat is already counted in seatsUsed; every other seat blocks.
    if ((await seatsUsed(tx, inv.teamId, inv.id)) >= TEAM_MAX_MEMBERS) return { error: 'full' as const };
    await tx.insert(teamMembers).values({ teamId: inv.teamId, accountId, role: 'member' });
    await tx.update(teamInvites).set({ acceptedAt: new Date() }).where(eq(teamInvites.id, inv.id));
    return { teamId: inv.teamId };
  });
}

export async function changeRole(
  db: Db, teamId: string, byAccountId: string, targetAccountId: string, role: 'admin' | 'member',
): Promise<Ok | { error: TeamError }> {
  return withAccount(db, byAccountId, async (tx) => {
    if (!(await lockTeam(tx, teamId))) return { error: 'not_member' as const };
    const by = await roleOf(tx, teamId, byAccountId);
    if (!by) return { error: 'not_member' as const };
    if (!can(by, 'changeRole')) return { error: 'forbidden' as const };
    const target = await roleOf(tx, teamId, targetAccountId);
    if (!target) return { error: 'not_member' as const };
    if (role !== 'admin' && role !== 'member') return { error: 'forbidden' as const };
    if (target === 'owner') return { error: by === 'owner' ? ('last_owner' as const) : ('forbidden' as const) };
    await tx.update(teamMembers).set({ role }).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, targetAccountId)));
    return { ok: true as const };
  });
}

export async function removeMember(db: Db, teamId: string, byAccountId: string, targetAccountId: string): Promise<Ok | { error: TeamError }> {
  return withAccount(db, byAccountId, async (tx) => {
    if (!(await lockTeam(tx, teamId))) return { error: 'not_member' as const };
    const by = await roleOf(tx, teamId, byAccountId);
    if (!by) return { error: 'not_member' as const };
    if (!can(by, 'remove')) return { error: 'forbidden' as const };
    const target = await roleOf(tx, teamId, targetAccountId);
    if (!target) return { error: 'not_member' as const };
    if (target === 'owner') return { error: by === 'owner' ? ('last_owner' as const) : ('forbidden' as const) };
    if (by === 'admin' && target !== 'member') return { error: 'forbidden' as const };
    await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, targetAccountId)));
    return { ok: true as const };
  });
}

export async function leaveTeam(db: Db, teamId: string, accountId: string): Promise<Ok | { error: TeamError }> {
  return withAccount(db, accountId, async (tx) => {
    if (!(await lockTeam(tx, teamId))) return { error: 'not_member' as const };
    const role = await roleOf(tx, teamId, accountId);
    if (!role) return { error: 'not_member' as const };
    if (role === 'owner') return { error: 'last_owner' as const };
    await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, accountId)));
    return { ok: true as const };
  });
}

export async function transferOwnership(db: Db, teamId: string, fromAccountId: string, toAccountId: string): Promise<Ok | { error: TeamError }> {
  return withAccount(db, fromAccountId, async (tx) => {
    if (!(await lockTeam(tx, teamId))) return { error: 'not_member' as const };
    const from = await roleOf(tx, teamId, fromAccountId);
    if (!from) return { error: 'not_member' as const };
    if (!can(from, 'transferOwner') || fromAccountId === toAccountId) return { error: 'forbidden' as const };
    if (!(await roleOf(tx, teamId, toAccountId))) return { error: 'not_member' as const };
    // Demote first: the partial unique index allows only one owner at any instant.
    await tx.update(teamMembers).set({ role: 'admin' }).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, fromAccountId)));
    await tx.update(teamMembers).set({ role: 'owner' }).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, toAccountId)));
    return { ok: true as const };
  });
}

export async function deleteTeam(db: Db, teamId: string, byAccountId: string): Promise<Ok | { error: TeamError }> {
  return withAccount(db, byAccountId, async (tx) => {
    if (!(await lockTeam(tx, teamId))) return { error: 'not_member' as const };
    const role = await roleOf(tx, teamId, byAccountId);
    if (!role) return { error: 'not_member' as const };
    if (!can(role, 'deleteTeam')) return { error: 'forbidden' as const };
    await tx.delete(teamInvites).where(eq(teamInvites.teamId, teamId));
    await tx.delete(owners).where(and(eq(owners.kind, 'team'), eq(owners.teamId, teamId)));
    await tx.delete(teams).where(eq(teams.id, teamId));
    return { ok: true as const };
  });
}

