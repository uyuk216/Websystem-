import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { withTestDb } from './helpers/db.js';
import { accounts, sessions } from '../src/db/schema.js';
import { createSession, listSessions, resolveSession, revokeSession } from '../src/auth/sessions.js';
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
});
