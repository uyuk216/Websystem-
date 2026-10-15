import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { assertOwnerBypassesRls, withAccount, withSystem } from '../src/db/client.js';
import { accounts, loginEvents, passkeys, sessions, teamInvites, teamMembers, teams } from '../src/db/schema.js';

const acct = (h: string) => ({ emailHash: h, emailEnc: 'e', displayName: h, locale: 'ja', adultFrom: '2030-01' });

async function seed(db: TestDb) {
  const [a] = await db.insert(accounts).values(acct('a')).returning();
  const [b] = await db.insert(accounts).values(acct('b')).returning();
  for (const x of [a!, b!]) {
    await db.insert(sessions).values({ accountId: x.id, tokenHash: `t-${x.emailHash}`, deviceLabel: 'd' });
    await db.insert(passkeys).values({ id: `pk-${x.emailHash}`, accountId: x.id, publicKey: Buffer.from([1]) });
    await db.insert(loginEvents).values({ accountId: x.id, method: 'email', deviceLabel: 'd', ipPrefix: 'p', deviceKey: 'k' });
  }
  const [ta] = await db.insert(teams).values({ name: 'A-only' }).returning();
  const [tb] = await db.insert(teams).values({ name: 'B-only' }).returning();
  await db.insert(teamMembers).values([
    { teamId: ta!.id, accountId: a!.id, role: 'owner' },
    { teamId: tb!.id, accountId: b!.id, role: 'owner' },
  ]);
  await db.insert(teamInvites).values({ teamId: tb!.id, emailHash: 'x', tokenHash: 'h', invitedBy: b!.id, expiresAt: new Date(Date.now() + 1e6) });
  return { a: a!, b: b!, teamOfA: ta!.id, teamOfBOnly: tb!.id };
}

describe('row level security', () => {
  it('scopes sessions, passkeys, login_events to the account', () =>
    withTestDb(async (db) => {
      const { a, b } = await seed(db);
      await withAccount(db, a.id, async (tx) => {
        const s = await tx.select().from(sessions);
        expect(s).toHaveLength(1);
        expect(s.every((r) => r.accountId === a.id)).toBe(true);
        expect(await tx.select().from(loginEvents).where(eq(loginEvents.accountId, b.id))).toHaveLength(0);
        expect(await tx.select().from(passkeys)).toHaveLength(1);
      });
    }));

  it('hides other teams, members and invites', () =>
    withTestDb(async (db) => {
      const { a, teamOfA, teamOfBOnly } = await seed(db);
      await withAccount(db, a.id, async (tx) => {
        expect(await tx.select().from(teams).where(eq(teams.id, teamOfBOnly))).toHaveLength(0);
        expect(await tx.select().from(teams)).toHaveLength(1);
        expect(await tx.select().from(teamMembers).where(eq(teamMembers.teamId, teamOfBOnly))).toHaveLength(0);
        expect(await tx.select().from(teamMembers).where(eq(teamMembers.teamId, teamOfA))).toHaveLength(1);
        expect(await tx.select().from(teamInvites)).toHaveLength(0);
      });
    }));

  it('returns zero rows when app.account_id is unset', () =>
    withTestDb(async (db) => {
      await seed(db);
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local role platform_api`);
        expect(await tx.select().from(sessions)).toHaveLength(0);
        expect(await tx.select().from(passkeys)).toHaveLength(0);
        expect(await tx.select().from(loginEvents)).toHaveLength(0);
        expect(await tx.select().from(teams)).toHaveLength(0);
        expect(await tx.select().from(teamMembers)).toHaveLength(0);
        expect(await tx.select().from(teamInvites)).toHaveLength(0);
      });
    }));

  it('rejects writes for another account and cannot self-join a team', () =>
    withTestDb(async (db) => {
      const { a, b, teamOfBOnly } = await seed(db);
      await expect(withAccount(db, a.id, (tx) =>
        tx.insert(sessions).values({ accountId: b.id, tokenHash: 'evil', deviceLabel: 'd' }))).rejects.toThrow();
      await withAccount(db, a.id, async (tx) => {
        expect(await tx.update(sessions).set({ deviceLabel: 'x' }).where(eq(sessions.accountId, b.id)).returning()).toHaveLength(0);
        expect(await tx.delete(passkeys).where(eq(passkeys.accountId, b.id)).returning()).toHaveLength(0);
      });
      await expect(withAccount(db, a.id, (tx) =>
        tx.insert(teamMembers).values({ teamId: teamOfBOnly, accountId: a.id, role: 'member' }))).rejects.toThrow();
      await expect(withAccount(db, a.id, (tx) =>
        tx.insert(teamMembers).values({ teamId: teamOfBOnly, accountId: a.id, role: 'owner' }))).rejects.toThrow();
    }));

  it('platform_api has no BYPASSRLS and is not an owner; withSystem sees all rows', () =>
    withTestDb(async (db) => {
      await seed(db);
      const r = await db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(sql`select rolbypassrls, rolsuper from pg_roles where rolname = 'platform_api'`);
      expect(r[0]).toEqual({ rolbypassrls: false, rolsuper: false });
      const o = await db.execute<{ tableowner: string }>(sql`select tableowner from pg_tables where tablename = 'sessions'`);
      expect(o[0]!.tableowner).not.toBe('platform_api');
      expect(await withSystem(db, (tx) => tx.select().from(sessions))).toHaveLength(2);
    }));
});

describe('owner role check', () => {
  it('accepts a bypassing owner and rejects a plain role', () =>
    withTestDb(async (db) => {
      await expect(assertOwnerBypassesRls(db)).resolves.toBeUndefined();
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`set local role platform_api`);
        await assertOwnerBypassesRls(tx as never);
      })).rejects.toThrow(/SUPERUSER or BYPASSRLS/);
    }));
});
