import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, owners, teamInvites, teamMembers, teams } from '../src/db/schema.js';
import { encryptEmail, hashEmail, normalizeEmail } from '../src/crypto/email.js';
import {
  acceptInvite, changeRole, createTeam, deleteTeam, ensureAccountOwner, inviteMember, leaveTeam, removeMember, transferOwnership,
} from '../src/teams/teams.js';
import { createApp } from '../src/http/app.js';
import { createSession } from '../src/auth/sessions.js';

const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };
const tick = () => new Promise((r) => setTimeout(r, 20));

async function acct(db: TestDb, email: string) {
  const n = normalizeEmail(email);
  const [a] = await db.insert(accounts).values({
    emailHash: hashEmail(n, cfg.emailHashKey), emailEnc: encryptEmail(n, cfg.emailEncKey),
    displayName: 'A', locale: 'ja', adultFrom: '2030-01',
  }).returning();
  return a!;
}
const countOwners = async (db: TestDb, teamId: string) =>
  (await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner')))).length;
const roleOf = async (db: TestDb, teamId: string, accountId: string) =>
  (await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, accountId))))[0]?.role;

async function join(db: TestDb, teamId: string, ownerId: string, email: string, role?: 'admin') {
  const mail = createFakeMailer();
  const acc = await acct(db, email);
  const inv = await inviteMember(db, mail, teamId, ownerId, email, cfg);
  if ('error' in inv) throw new Error(inv.error);
  await tick();
  const body = mail.lastBodyTo(normalizeEmail(email))!;
  const u = new URL(/https?:\/\/\S+/.exec(body)![0]);
  const r = await acceptInvite(db, u.searchParams.get('i')!, u.searchParams.get('t')!, acc.id);
  if ('error' in r) throw new Error(r.error);
  if (role) await db.update(teamMembers).set({ role }).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.accountId, acc.id)));
  return acc;
}

describe('teams', () => {
  it('creates a team with owner and team owners row; account owner is idempotent', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const o1 = await ensureAccountOwner(db, a.id);
      expect(await ensureAccountOwner(db, a.id)).toBe(o1);
      const { teamId, ownerId } = await createTeam(db, a.id, '写真部');
      expect(await roleOf(db, teamId, a.id)).toBe('owner');
      const [o] = await db.select().from(owners).where(eq(owners.id, ownerId));
      expect(o).toMatchObject({ kind: 'team', teamId, accountId: null });
    });
  });

  it('enforces one owner at the DB level', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const b = await acct(db, 'b@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      await expect(db.insert(teamMembers).values({ teamId, accountId: b.id, role: 'owner' })).rejects.toThrow();
    });
  });

  it('caps at 10 including pending invites, and re-checks on accept', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const mail = createFakeMailer();
      for (let i = 0; i < 4; i++) await join(db, teamId, a.id, `m${i}@example.com`);
      for (let i = 0; i < 5; i++) expect(await inviteMember(db, mail, teamId, a.id, `p${i}@example.com`, cfg)).toHaveProperty('inviteId');
      // 1 + 4 members + 5 pending = 10
      expect(await inviteMember(db, mail, teamId, a.id, 'x@example.com', cfg)).toEqual({ error: 'full' });
      // fill the team behind the invites' back, then accept
      await tick();
      const x = await acct(db, 'late@example.com');
      const inv = await inviteMember(db, mail, teamId, a.id, 'late@example.com', cfg);
      expect(inv).toEqual({ error: 'full' });
      await db.delete(teamInvites).where(eq(teamInvites.teamId, teamId));
      const inv2 = await inviteMember(db, mail, teamId, a.id, 'late@example.com', cfg);
      if ('error' in inv2) throw new Error('x');
      await tick();
      const link = new URL(/https?:\/\/\S+/.exec(mail.lastBodyTo('late@example.com')!)![0]);
      for (let i = 0; i < 5; i++) {
        const f = await acct(db, `f${i}@example.com`);
        await db.insert(teamMembers).values({ teamId, accountId: f.id, role: 'member' });
      }
      expect(await acceptInvite(db, link.searchParams.get('i')!, link.searchParams.get('t')!, x.id)).toEqual({ error: 'full' });
    });
  });

  it('a refused re-invite (full) keeps the old pending invite; a permitted one replaces it', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const mail = createFakeMailer();
      const first = await inviteMember(db, mail, teamId, a.id, 'bob@example.com', cfg);
      if ('error' in first) throw new Error('invite');
      // at exactly the cap (own seat included) a re-invite still works and replaces the old one
      for (let i = 0; i < 8; i++) await join(db, teamId, a.id, `m${i}@example.com`);
      const again = await inviteMember(db, mail, teamId, a.id, 'bob@example.com', cfg);
      if ('error' in again) throw new Error('re-invite at cap');
      expect(await db.select().from(teamInvites).where(eq(teamInvites.id, first.inviteId))).toHaveLength(0);
      // fill the last seat behind its back: the re-invite is refused and the old invite survives
      const f = await acct(db, 'f@example.com');
      await db.insert(teamMembers).values({ teamId, accountId: f.id, role: 'member' });
      expect(await inviteMember(db, mail, teamId, a.id, 'bob@example.com', cfg)).toEqual({ error: 'full' });
      expect(await db.select().from(teamInvites).where(eq(teamInvites.id, again.inviteId))).toHaveLength(1);
    });
  });

  it('member cannot invite; admin can', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const m = await join(db, teamId, a.id, 'm@example.com');
      const ad = await join(db, teamId, a.id, 'ad@example.com', 'admin');
      const mail = createFakeMailer();
      expect(await inviteMember(db, mail, teamId, m.id, 'n@example.com', cfg)).toEqual({ error: 'forbidden' });
      expect(await inviteMember(db, mail, teamId, ad.id, 'n@example.com', cfg)).toHaveProperty('inviteId');
      const outsider = await acct(db, 'o@example.com');
      expect(await inviteMember(db, mail, teamId, outsider.id, 'n2@example.com', cfg)).toEqual({ error: 'forbidden' });
      expect(await inviteMember(db, mail, 'not-a-uuid', a.id, 'n2@example.com', cfg)).toEqual({ error: 'forbidden' });
    });
  });

  it('invite: stores only a hash, requires matching email, one-time, 7-day expiry', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const mail = createFakeMailer();
      const inv = await inviteMember(db, mail, teamId, a.id, ' Bob@Example.com ', cfg);
      if ('error' in inv) throw new Error('x');
      await tick();
      const body = mail.lastBodyTo('bob@example.com')!;
      const u = new URL(/https?:\/\/\S+/.exec(body)![0]);
      expect(u.origin + u.pathname).toBe('https://app.example.com/teams/invite');
      const tok = u.searchParams.get('t')!;
      const [row] = await db.select().from(teamInvites).where(eq(teamInvites.id, inv.inviteId));
      expect(JSON.stringify(row)).not.toContain(tok);
      const other = await acct(db, 'other@example.com');
      expect(await acceptInvite(db, inv.inviteId, tok, other.id)).toEqual({ error: 'forbidden' });
      const bob = await acct(db, 'bob@example.com');
      expect(await acceptInvite(db, inv.inviteId, 'wrong', bob.id)).toEqual({ error: 'invalid' });
      expect(await acceptInvite(db, 'zzz', tok, bob.id)).toEqual({ error: 'invalid' });
      expect(await acceptInvite(db, inv.inviteId, tok, bob.id)).toEqual({ teamId });
      expect(await acceptInvite(db, inv.inviteId, tok, bob.id)).toEqual({ error: 'invalid' });
      expect(await roleOf(db, teamId, bob.id)).toBe('member');
    });
  });

  it('expired invite (8 days) cannot be accepted', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const mail = createFakeMailer();
      const inv = await inviteMember(db, mail, teamId, a.id, 'bob@example.com', cfg);
      if ('error' in inv) throw new Error('x');
      await tick();
      const tok = mail.lastLinkToken();
      await db.update(teamInvites).set({ expiresAt: sql`now() - interval '1 day'` });
      const [row] = await db.select().from(teamInvites);
      expect(row!.expiresAt.getTime()).toBeLessThan(Date.now());
      const bob = await acct(db, 'bob@example.com');
      expect(await acceptInvite(db, inv.inviteId, tok, bob.id)).toEqual({ error: 'expired' });
      // a fresh invite is valid for 7 days
      const inv2 = await inviteMember(db, mail, teamId, a.id, 'bob@example.com', cfg);
      if ('error' in inv2) throw new Error('x');
      const [r2] = await db.select().from(teamInvites).where(eq(teamInvites.id, inv2.inviteId));
      const days = (r2!.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThan(7.01);
    });
  });

  it('owner cannot leave or be demoted; members can leave', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const m = await join(db, teamId, a.id, 'm@example.com');
      expect(await leaveTeam(db, teamId, a.id)).toEqual({ error: 'last_owner' });
      expect(await changeRole(db, teamId, a.id, a.id, 'member')).toEqual({ error: 'last_owner' });
      expect(await changeRole(db, teamId, a.id, m.id, 'admin')).toEqual({ ok: true });
      expect(await roleOf(db, teamId, m.id)).toBe('admin');
      expect(await leaveTeam(db, teamId, m.id)).toEqual({ ok: true });
      expect(await leaveTeam(db, teamId, m.id)).toEqual({ error: 'not_member' });
      expect(await leaveTeam(db, 'bad', m.id)).toEqual({ error: 'not_member' });
    });
  });

  it('admin limits for changeRole and removeMember', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const ad = await join(db, teamId, a.id, 'ad@example.com', 'admin');
      const ad2 = await join(db, teamId, a.id, 'ad2@example.com', 'admin');
      const m = await join(db, teamId, a.id, 'm@example.com');
      expect(await changeRole(db, teamId, ad.id, a.id, 'member')).toEqual({ error: 'forbidden' });
      expect(await changeRole(db, teamId, m.id, ad.id, 'member')).toEqual({ error: 'forbidden' });
      expect(await removeMember(db, teamId, ad.id, a.id)).toEqual({ error: 'forbidden' });
      expect(await removeMember(db, teamId, ad.id, ad2.id)).toEqual({ error: 'forbidden' });
      expect(await removeMember(db, teamId, ad.id, m.id)).toEqual({ ok: true });
      expect(await removeMember(db, teamId, ad.id, m.id)).toEqual({ error: 'not_member' });
      expect(await removeMember(db, teamId, a.id, ad2.id)).toEqual({ ok: true });
      expect(await changeRole(db, teamId, a.id, 'x', 'admin')).toEqual({ error: 'not_member' });
      expect(await changeRole(db, teamId, a.id, ad.id, 'owner' as never)).toEqual({ error: 'forbidden' });
    });
  });

  it('transfers ownership: old owner becomes admin, exactly one owner', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const b = await join(db, teamId, a.id, 'b@example.com');
      const outsider = await acct(db, 'o@example.com');
      expect(await transferOwnership(db, teamId, a.id, outsider.id)).toEqual({ error: 'not_member' });
      expect(await transferOwnership(db, teamId, b.id, a.id)).toEqual({ error: 'forbidden' });
      expect(await transferOwnership(db, teamId, a.id, a.id)).toEqual({ error: 'forbidden' });
      expect(await transferOwnership(db, teamId, a.id, b.id)).toEqual({ ok: true });
      expect(await roleOf(db, teamId, a.id)).toBe('admin');
      expect(await roleOf(db, teamId, b.id)).toBe('owner');
      expect(await countOwners(db, teamId)).toBe(1);
    });
  });

  it('deleteTeam: owner only; removes everything', async () => {
    await withTestDb(async (db) => {
      const a = await acct(db, 'a@example.com');
      const { teamId } = await createTeam(db, a.id, 't');
      const ad = await join(db, teamId, a.id, 'ad@example.com', 'admin');
      await inviteMember(db, createFakeMailer(), teamId, a.id, 'p@example.com', cfg);
      expect(await deleteTeam(db, teamId, ad.id)).toEqual({ error: 'forbidden' });
      expect(await deleteTeam(db, teamId, a.id)).toEqual({ ok: true });
      expect(await db.select().from(teams)).toHaveLength(0);
      expect(await db.select().from(teamMembers)).toHaveLength(0);
      expect(await db.select().from(teamInvites)).toHaveLength(0);
      expect(await db.select().from(owners).where(eq(owners.kind, 'team'))).toHaveLength(0);
      expect(await deleteTeam(db, teamId, a.id)).toEqual({ error: 'not_member' });
    });
  });
});

describe('teams http', () => {
  it('requires a session, creates, lists, 404s non-members and bad ids', async () => {
    await withTestDb(async (db) => {
      const app = createApp({ db, mailer: createFakeMailer(), config: cfg });
      expect((await app.request('/teams')).status).toBe(401);
      const a = await acct(db, 'a@example.com');
      const o = await acct(db, 'o@example.com');
      const ck = `sid=${(await createSession(db, a.id, 'x')).token}`;
      const ock = `sid=${(await createSession(db, o.id, 'x')).token}`;
      const post = (path: string, body: unknown, cookie = ck) =>
        app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
      expect((await post('/teams', { name: '' })).status).toBe(400);
      const r = await post('/teams', { name: '写真部' });
      expect(r.status).toBe(200);
      const { teamId } = await r.json() as { teamId: string };
      const list = await (await app.request('/teams', { headers: { cookie: ck } })).json() as { teams: { id: string; role: string }[] };
      expect(list.teams).toMatchObject([{ id: teamId, role: 'owner' }]);
      expect((await app.request(`/teams/${teamId}`, { headers: { cookie: ck } })).status).toBe(200);
      expect((await app.request(`/teams/${teamId}`, { headers: { cookie: ock } })).status).toBe(404);
      expect((await app.request('/teams/not-a-uuid', { headers: { cookie: ck } })).status).toBe(404);
      expect((await post(`/teams/${teamId}/invites`, { email: 'x@example.com' }, ock)).status).toBe(403);
      expect((await post(`/teams/${teamId}/invites`, { email: 'x@example.com' })).status).toBe(200);
      expect((await post(`/teams/${teamId}/leave`, {})).status).toBe(409);
      expect((await app.request(`/teams/${teamId}`, { method: 'DELETE', headers: { cookie: ock } })).status).toBe(404);
      expect((await app.request(`/teams/${teamId}`, { method: 'DELETE', headers: { cookie: ck } })).status).toBe(200);
    });
  });
});
