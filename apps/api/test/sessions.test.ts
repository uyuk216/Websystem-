import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { withTestDb } from './helpers/db.js';
import { eq } from 'drizzle-orm';
import { accounts, sessions } from '../src/db/schema.js';
import { SESSION_ABSOLUTE_DAYS, createSession, listSessions, purgeExpiredSessions, resolveSession, revokeSession } from '../src/auth/sessions.js';
import { rateLimit, requireSession } from '../src/http/middleware.js';

const acct = (h: string) => ({ emailHash: h, emailEnc: 'e', displayName: 'n', locale: 'ja', adultFrom: '2030-01' });

afterEach(() => vi.useRealTimers());

describe('sessions', () => {
  it('creates, resolves, revokes, and expires', () =>
    withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values(acct('a')).returning();
      const [b] = await db.insert(accounts).values(acct('b')).returning();
      const { token, sessionId } = await createSession(db, a!.id, 'Mac / Safari');
      expect((await resolveSession(db, token))?.accountId).toBe(a!.id);
      expect(await db.select().from(sessions)).not.toContainEqual(expect.objectContaining({ tokenHash: token }));
      expect(await listSessions(db, a!.id)).toHaveLength(1);
      await revokeSession(db, b!.id, sessionId);
      expect(await resolveSession(db, token)).not.toBeNull();
      await revokeSession(db, a!.id, sessionId);
      expect(await resolveSession(db, token)).toBeNull();
      const fresh = await createSession(db, a!.id, 'x');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31 * 86400_000);
      expect(await resolveSession(db, fresh.token)).toBeNull(); // expired
      expect(await resolveSession(db, (await createSession(db, a!.id, 'x')).token)).not.toBeNull();
    }));

  it('caps a session at created_at + 90 days even when kept active', () =>
    withTestDb(async (db) => {
      expect(SESSION_ABSOLUTE_DAYS).toBe(90);
      const [a] = await db.insert(accounts).values(acct('a')).returning();
      const { token, sessionId } = await createSession(db, a!.id, 'x');
      const day = 86400_000;
      const t0 = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      // active every 20 days: the sliding window keeps it alive
      for (const d of [20, 40, 60, 80]) {
        vi.setSystemTime(t0 + d * day);
        expect(await resolveSession(db, token)).not.toBeNull();
      }
      vi.setSystemTime(t0 + 89 * day);
      expect(await resolveSession(db, token)).not.toBeNull();
      expect(await listSessions(db, a!.id)).toHaveLength(1);
      vi.setSystemTime(t0 + 91 * day);
      expect(await resolveSession(db, token)).toBeNull(); // last seen 2 days ago, but past the absolute cap
      expect(await listSessions(db, a!.id)).toHaveLength(0);
      expect(sessionId).toBeTruthy();
    }));

  it('purgeExpiredSessions removes revoked, idle and over-age sessions only', () =>
    withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values(acct('a')).returning();
      const mk = async () => (await createSession(db, a!.id, 'x')).sessionId;
      const live = await mk();
      const revoked = await mk();
      const idle = await mk();
      const old = await mk();
      const now = new Date();
      const ago = (d: number) => new Date(now.getTime() - d * 86400_000);
      await db.update(sessions).set({ revokedAt: ago(1) }).where(eq(sessions.id, revoked));
      await db.update(sessions).set({ lastSeenAt: ago(31) }).where(eq(sessions.id, idle));
      await db.update(sessions).set({ createdAt: ago(91) }).where(eq(sessions.id, old));
      expect(await purgeExpiredSessions(db, now)).toBe(3);
      expect((await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id)).toEqual([live]);
      expect(await purgeExpiredSessions(db, now)).toBe(0);
    }));

  it('requireSession reads the sid cookie', () =>
    withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values(acct('a')).returning();
      const { token } = await createSession(db, a!.id, 'x');
      const app = new Hono();
      app.use('*', requireSession(db));
      app.get('/me', (c) => c.json({ id: c.get('accountId') }));
      expect((await app.request('/me')).status).toBe(401);
      const r = await app.request('/me', { headers: { cookie: `sid=${token}` } });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ id: a!.id });
    }));
});

describe('rateLimit', () => {
  it('returns 429 beyond max within window', async () => {
    const app = new Hono();
    app.use('*', rateLimit(() => 'k', 2, 60));
    app.get('/', (c) => c.text('ok'));
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(429);
  });

  it('rejects new keys when the bucket cap is full, and recovers after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let sweeps = 0;
    const app = new Hono();
    app.use('*', rateLimit((c) => c.req.header('x-k') ?? '', 5, 60, 2, () => sweeps++));
    app.get('/', (c) => c.text('ok'));
    const hit = (k: string) => app.request('/', { headers: { 'x-k': k } });
    expect((await hit('a')).status).toBe(200);
    expect((await hit('b')).status).toBe(200);
    const before = sweeps;
    expect((await hit('c')).status).toBe(429);
    expect((await hit('d')).status).toBe(429);
    expect(sweeps).toBe(before); // full map, nextSweep in future: no scan
    expect((await hit('a')).status).toBe(200); // existing keys still served
    vi.setSystemTime(Date.now() + 61_000);
    expect((await hit('c')).status).toBe(200); // expired entries evicted
  });
});
