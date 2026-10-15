import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, apiTokens } from '../src/db/schema.js';
import { createApp } from '../src/http/app.js';
import { createApiToken } from '../src/apps/api-tokens.js';

const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'admin@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };
const acct = (h: string) => ({ emailHash: h, emailEnc: 'e', displayName: 'n', locale: 'ja', adultFrom: '2030-01' });

describe('bearer hardening', () => {
  it('destructive and ownership routes are cookie-only', () => withTestDb(async (db) => {
    const app = createApp({ db, mailer: createFakeMailer(), config: cfg } as never);
    const [a] = await db.insert(accounts).values(acct('a')).returning();
    const { token } = await createApiToken(db, a!.id, 'ci');
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const u = '00000000-0000-0000-0000-000000000001';
    for (const [m, path] of [['DELETE', `/teams/${u}`], ['POST', `/teams/${u}/transfer`], ['DELETE', `/apps/${u}`], ['PATCH', `/teams/${u}/members/${u}`], ['DELETE', `/teams/${u}/members/${u}`]] as const) {
      expect((await app.request(path, { method: m, headers: h, body: m === 'DELETE' ? undefined : '{}' })).status, `${m} ${path}`).toBe(401);
    }
  }));

  it('lastUsedAt is throttled and failed Bearer attempts are rate limited', () => withTestDb(async (db) => {
    const app = createApp({ db, mailer: createFakeMailer(), config: cfg } as never);
    const [a] = await db.insert(accounts).values(acct('a')).returning();
    const { token, id } = await createApiToken(db, a!.id, 'ci');
    const last = async () => (await db.select().from(apiTokens).where(eq(apiTokens.id, id)))[0]!.lastUsedAt;
    expect(await last()).toBeNull();
    const ok = { headers: { authorization: `Bearer ${token}` } };
    await app.request('/apps', ok);
    const t1 = await last();
    expect(t1).not.toBeNull();
    await app.request('/apps', ok);
    expect((await last())!.getTime()).toBe(t1!.getTime());
    for (let i = 0; i < 30; i++) expect((await app.request('/apps', { headers: { authorization: 'Bearer ysk_bad' } })).status).toBe(401);
    expect((await app.request('/apps', { headers: { authorization: 'Bearer ysk_bad' } })).status).toBe(429);
    expect((await app.request('/apps', ok)).status).toBe(429);
  }));
});
