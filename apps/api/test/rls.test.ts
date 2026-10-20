import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { assertOwnerBypassesRls, withAccount, withSystem } from '../src/db/client.js';
import { accounts, emailChallenges, loginEvents, owners, passkeys, sessions, studentVerifications, teamInvites, teamMembers, teams, verificationUploads } from '../src/db/schema.js';

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

describe('row level security: accounts, owners and pre-auth tables', () => {
  it('hides other accounts rows and blocks writes to them', () =>
    withTestDb(async (db) => {
      const { a, b } = await seed(db);
      await withAccount(db, a.id, async (tx) => {
        const rows = await tx.select({ id: accounts.id }).from(accounts);
        expect(rows).toEqual([{ id: a.id }]);
        expect(await tx.select().from(accounts).where(eq(accounts.id, b.id))).toHaveLength(0);
        expect(await tx.update(accounts).set({ displayName: 'x' }).where(eq(accounts.id, b.id)).returning()).toHaveLength(0);
      });
      await expect(withAccount(db, a.id, (tx) => tx.insert(accounts).values(acct('c')))).rejects.toThrow();
    }));

  it('shows teammates (read-only) to fellow team members', () =>
    withTestDb(async (db) => {
      const { a, b, teamOfA } = await seed(db);
      await db.insert(teamMembers).values({ teamId: teamOfA, accountId: b.id, role: 'member' });
      await withAccount(db, a.id, async (tx) => {
        expect(await tx.select({ id: accounts.id }).from(accounts)).toHaveLength(2);
        expect(await tx.update(accounts).set({ displayName: 'x' }).where(eq(accounts.id, b.id)).returning()).toHaveLength(0);
      });
    }));

  it('scopes owners to own account and own teams', () =>
    withTestDb(async (db) => {
      const { a, b, teamOfA, teamOfBOnly } = await seed(db);
      await db.insert(owners).values([
        { kind: 'account', accountId: a.id }, { kind: 'account', accountId: b.id },
        { kind: 'team', teamId: teamOfA }, { kind: 'team', teamId: teamOfBOnly },
      ]);
      await withAccount(db, a.id, async (tx) => {
        const rows = await tx.select().from(owners);
        expect(rows).toHaveLength(2);
        expect(rows.some((r) => r.accountId === b.id || r.teamId === teamOfBOnly)).toBe(false);
      });
      await expect(withAccount(db, a.id, (tx) => tx.insert(owners).values({ kind: 'account', accountId: b.id }))).rejects.toThrow();
    }));

  it('platform_api has no access to pre-auth tables', () =>
    withTestDb(async (db) => {
      await seed(db);
      for (const table of ['email_challenges', 'recovery_requests', 'recovery_attempts', 'webauthn_challenges']) {
        const err = await db.transaction(async (tx) => {
          await tx.execute(sql`set local role platform_api`);
          await tx.execute(sql.raw(`select * from ${table}`));
        }).then(() => null, (e: unknown) => e as Error & { cause?: Error });
        expect(err, table).not.toBeNull();
        expect(`${err!.message} ${err!.cause?.message ?? ''}`, table).toMatch(/permission denied/);
      }
      await expect(withAccount(db, (await db.select().from(accounts))[0]!.id, (tx) => tx.select().from(emailChallenges))).rejects.toThrow();
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
describe('row level security: student verifications', () => {
  it('shows a verification and its uploads only to their owner', () =>
    withTestDb(async (db) => {
      const { a, b } = await seed(db);
      const mk = async (accountId: string) => {
        const [v] = await db.insert(studentVerifications).values({ accountId, schoolName: 'S', schoolKind: 'university', expectedGraduationYear: 2030 }).returning();
        await db.insert(verificationUploads).values({ verificationId: v!.id, tokenHash: `h-${accountId}`, tokenExpiresAt: new Date(Date.now() + 1e6), expiresAt: new Date(Date.now() + 1e9) });
        return v!;
      };
      const va = await mk(a.id);
      await mk(b.id);
      await withAccount(db, a.id, async (tx) => {
        expect((await tx.select().from(studentVerifications)).map((r) => r.id)).toEqual([va.id]);
        expect(await tx.select().from(verificationUploads)).toHaveLength(1);
      });
    }));

  it('lets a user start a pending verification but never approve, backdate or delete one', () =>
    withTestDb(async (db) => {
      const { a, b } = await seed(db);
      const row = { schoolName: 'S', schoolKind: 'university', expectedGraduationYear: 2030 };
      await expect(withAccount(db, a.id, (tx) => tx.insert(studentVerifications).values({ ...row, accountId: b.id }))).rejects.toThrow();
      await expect(withAccount(db, a.id, (tx) => tx.insert(studentVerifications).values({ ...row, accountId: a.id, status: 'approved' }))).rejects.toThrow();
      await expect(withAccount(db, a.id, (tx) => tx.insert(studentVerifications).values({ ...row, accountId: a.id, validUntil: new Date() }))).rejects.toThrow();
      const [v] = await withAccount(db, a.id, (tx) => tx.insert(studentVerifications).values({ ...row, accountId: a.id }).returning());
      await withAccount(db, a.id, async (tx) => {
        expect(await tx.update(studentVerifications).set({ schoolName: 'T' }).where(eq(studentVerifications.id, v!.id)).returning()).toHaveLength(1);
      });
      await expect(withAccount(db, a.id, (tx) => tx.update(studentVerifications).set({ status: 'approved' }).where(eq(studentVerifications.id, v!.id)))).rejects.toThrow();
      await expect(withAccount(db, a.id, (tx) => tx.update(studentVerifications).set({ validUntil: new Date() }).where(eq(studentVerifications.id, v!.id)))).rejects.toThrow();
      await withAccount(db, a.id, async (tx) => {
        expect(await tx.delete(studentVerifications).where(eq(studentVerifications.id, v!.id)).returning()).toHaveLength(0);
      });
      // Uploads: a user cannot pre-mark a token as used, point blob_ref anywhere, edit or delete.
      const up = { verificationId: v!.id, tokenHash: 'x', tokenExpiresAt: new Date(Date.now() + 1e6), expiresAt: new Date(Date.now() + 1e9) };
      await expect(withAccount(db, a.id, (tx) => tx.insert(verificationUploads).values({ ...up, blobRef: 'x' }))).rejects.toThrow();
      const [u] = await withAccount(db, a.id, (tx) => tx.insert(verificationUploads).values(up).returning());
      await withAccount(db, a.id, async (tx) => {
        expect(await tx.update(verificationUploads).set({ tokenUsedAt: new Date() }).where(eq(verificationUploads.id, u!.id)).returning()).toHaveLength(0);
        expect(await tx.delete(verificationUploads).where(eq(verificationUploads.id, u!.id)).returning()).toHaveLength(0);
      });
      // And another account cannot attach an upload to it.
      await expect(withAccount(db, b.id, (tx) => tx.insert(verificationUploads).values({ ...up, tokenHash: 'y' }))).rejects.toThrow();
    }));
});
