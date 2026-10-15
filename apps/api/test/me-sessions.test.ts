import { describe, expect, it } from 'vitest';
import { withTestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts } from '../src/db/schema.js';
import { createApp } from '../src/http/app.js';
import { createSession, resolveSession } from '../src/auth/sessions.js';

const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };
const acct = (h: string) => ({ emailHash: h, emailEnc: 'e', displayName: 'n', locale: 'ja', adultFrom: '2030-01' });

describe('session routes', () => {
  it('lists with current flag, revokes another session, logs out', () =>
    withTestDb(async (db) => {
      const app = createApp({ db, mailer: createFakeMailer(), config: cfg } as never);
      const [a] = await db.insert(accounts).values(acct('a')).returning();
      const [b] = await db.insert(accounts).values(acct('b')).returning();
      const s1 = await createSession(db, a!.id, 'Mac / Safari');
      const s2 = await createSession(db, a!.id, 'Windows / Chrome');
      const other = await createSession(db, b!.id, 'x');
      const h = (t: string) => ({ headers: { cookie: `sid=${t}` } });
      expect((await app.request('/me/sessions')).status).toBe(401);
      const list = await (await app.request('/me/sessions', h(s1.token))).json() as { sessions: { id: string; current: boolean }[] };
      expect(list.sessions.map((s) => [s.id, s.current])).toEqual([[s1.sessionId, true], [s2.sessionId, false]]);
      expect((await app.request('/me/sessions/not-a-uuid', { method: 'DELETE', ...h(s1.token) })).status).toBe(400);
      // cannot revoke another account's session
      await app.request(`/me/sessions/${other.sessionId}`, { method: 'DELETE', ...h(s1.token) });
      expect(await resolveSession(db, other.token)).not.toBeNull();
      expect((await app.request(`/me/sessions/${s2.sessionId}`, { method: 'DELETE', ...h(s1.token) })).status).toBe(200);
      expect(await resolveSession(db, s2.token)).toBeNull();
      const out = await app.request('/auth/logout', { method: 'POST', ...h(s1.token) });
      expect(out.status).toBe(200);
      expect(await resolveSession(db, s1.token)).toBeNull();
    }));
});
