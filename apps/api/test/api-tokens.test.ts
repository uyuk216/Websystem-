import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, apiTokens } from '../src/db/schema.js';
import { withAccount } from '../src/db/client.js';
import { createApp } from '../src/http/app.js';
import { createSession } from '../src/auth/sessions.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../src/apps/api-tokens.js';

const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };
const acct = (h: string) => ({ emailHash: h, emailEnc: 'e', displayName: 'n', locale: 'ja', adultFrom: '2030-01' });

describe('api tokens', () => {
  it('stores only the hash, lists without secrets, isolates accounts', () => withTestDb(async (db) => {
    const [a] = await db.insert(accounts).values(acct('a')).returning();
    const [b] = await db.insert(accounts).values(acct('b')).returning();
    const { token, id } = await createApiToken(db, a!.id, 'laptop');
    expect(token).toMatch(/^ysk_[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(JSON.stringify(row)).not.toContain(token.slice(8));
    expect(await listApiTokens(db, a!.id)).toHaveLength(1);
    expect(JSON.stringify(await listApiTokens(db, a!.id))).not.toContain(token.slice(8));
    expect(await listApiTokens(db, b!.id)).toHaveLength(0);
    expect(await revokeApiToken(db, b!.id, id)).toBe(false);
    expect(await withAccount(db, b!.id, (tx) => tx.select().from(apiTokens))).toHaveLength(0);
  }));

  it('authenticates via Bearer, 401 after revoke, and Bearer cannot manage tokens', () => withTestDb(async (db) => {
    const app = createApp({ db, mailer: createFakeMailer(), config: cfg } as never);
    const [a] = await db.insert(accounts).values(acct('a')).returning();
    const { token, id } = await createApiToken(db, a!.id, 'ci');
    const bearer = { authorization: `Bearer ${token}` };
    expect((await app.request('/apps', { headers: bearer })).status).toBe(200);
    expect((await app.request('/apps', { headers: { authorization: 'Bearer ysk_nope' } })).status).toBe(401);
    expect((await app.request('/me/tokens', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(401);
    expect((await app.request('/me/tokens', { headers: bearer })).status).toBe(401);
    expect((await app.request(`/me/tokens/${id}`, { method: 'DELETE', headers: bearer })).status).toBe(401);
    expect((await app.request('/auth/passkey/register/start', { method: 'POST', headers: bearer })).status).toBe(401);
    const s = await createSession(db, a!.id, 'Mac');
    const ck = { cookie: `sid=${s.token}`, 'content-type': 'application/json' };
    expect((await app.request('/me/tokens', { method: 'POST', headers: ck, body: '{"name":"two"}' })).status).toBe(201);
    expect((await app.request(`/me/tokens/${id}`, { method: 'DELETE', headers: ck })).status).toBe(200);
    expect((await app.request('/apps', { headers: bearer })).status).toBe(401);
  }));
});
