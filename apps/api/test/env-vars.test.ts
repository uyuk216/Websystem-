import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, appEnvVars, teamMembers } from '../src/db/schema.js';
import { createTeam, ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createSession } from '../src/auth/sessions.js';
import { createApiToken } from '../src/apps/api-tokens.js';
import { withAccount } from '../src/db/client.js';
import { deleteEnvVar, getAppEnvForRun, listEnvVars, setEnvVar, decryptEnvValue } from '../src/apps/env-vars.js';

const KEY = Buffer.alloc(32, 7);
let n = 0;
async function acct(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `e${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function mkApp(db: TestDb, a: { id: string; ownerId: string }, name: string) {
  const r = await createApp(db, a.id, { name, ownerId: a.ownerId });
  if (!('appId' in r)) throw new Error(r.error);
  return r.appId;
}

describe('app env vars', () => {
  it('stores ciphertext only, lists names without values, round-trips for the runner', () => withTestDb(async (db) => {
    const a = await acct(db);
    const appId = await mkApp(db, a, 'envapp');
    expect(await setEnvVar(db, KEY, a.id, appId, 'DB_URL', 'postgres://secret-pass@x')).toEqual({ ok: true });
    expect(await setEnvVar(db, KEY, a.id, appId, 'DB_URL', 'postgres://secret-pass2@x')).toEqual({ ok: true });
    const raw = await db.select().from(appEnvVars);
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain('secret-pass');
    const list = await listEnvVars(db, a.id, appId);
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(list).toMatchObject([{ name: 'DB_URL' }]);
    expect(await getAppEnvForRun(db, KEY, appId)).toEqual({ DB_URL: 'postgres://secret-pass2@x' });
    expect(await deleteEnvVar(db, a.id, appId, 'DB_URL')).toEqual({ ok: true });
    expect(await deleteEnvVar(db, a.id, appId, 'DB_URL')).toEqual({ error: 'not_found' });
    expect(await getAppEnvForRun(db, KEY, appId)).toEqual({});
  }));

  it('binds ciphertext to app and name (swap fails to decrypt)', () => withTestDb(async (db) => {
    const a = await acct(db);
    const appId = await mkApp(db, a, 'envapp');
    await setEnvVar(db, KEY, a.id, appId, 'A_ONE', 'v');
    const [row] = await db.select().from(appEnvVars);
    expect(() => decryptEnvValue(row!.valueEnc, KEY, appId, 'B_TWO')).toThrow();
    expect(() => decryptEnvValue(row!.valueEnc, KEY, '00000000-0000-0000-0000-000000000000', 'A_ONE')).toThrow();
    expect(decryptEnvValue(row!.valueEnc, KEY, appId, 'A_ONE')).toBe('v');
  }));

  it('Review Focus 5: names, reserved, newline, 32KB value, 64KB total', () => withTestDb(async (db) => {
    const a = await acct(db);
    const appId = await mkApp(db, a, 'envapp');
    const set = (name: string, v: string) => setEnvVar(db, KEY, a.id, appId, name, v);
    for (const bad of ['lower', '1ABC', 'A-B', '', 'A'.repeat(65)]) expect(await set(bad, 'x')).toEqual({ error: 'invalid_name' });
    for (const r of ['PORT', 'HOST', 'YS_TOKEN', 'YS_']) expect(await set(r, 'x')).toEqual({ error: 'reserved' });
    expect(await set('OK', 'a\nb')).toEqual({ error: 'invalid_value' });
    expect(await set('OK', 'a\rb')).toEqual({ error: 'invalid_value' });
    expect(await set('OK', 'a=b=c')).toEqual({ ok: true });
    expect(await set('BIG', 'x'.repeat(32 * 1024 + 1))).toEqual({ error: 'too_large' });
    expect(await set('BIG', 'x'.repeat(32 * 1024))).toEqual({ ok: true });
    expect(await set('BIG2', 'x'.repeat(32 * 1024))).toEqual({ error: 'too_large' });
    expect(await set('BIG2', 'x'.repeat(1000))).toEqual({ ok: true });
    expect(await set('A'.repeat(64), 'x')).toEqual({ ok: true });
  }));

  it('other accounts cannot see or set; team members can; outsiders cannot', () => withTestDb(async (db) => {
    const owner = await acct(db);
    const other = await acct(db);
    const appId = await mkApp(db, owner, 'envapp');
    expect(await setEnvVar(db, KEY, other.id, appId, 'X', '1')).toEqual({ error: 'not_found' });
    expect(await listEnvVars(db, other.id, appId)).toEqual({ error: 'not_found' });
    expect(await deleteEnvVar(db, other.id, appId, 'X')).toEqual({ error: 'not_found' });
    expect(await withAccount(db, other.id, (tx) => tx.select().from(appEnvVars))).toHaveLength(0);
    await setEnvVar(db, KEY, owner.id, appId, 'X', '1');
    expect(await withAccount(db, other.id, (tx) => tx.select().from(appEnvVars))).toHaveLength(0);
    expect(await withAccount(db, owner.id, (tx) => tx.select().from(appEnvVars))).toHaveLength(1);
    const member = await acct(db);
    const { teamId, ownerId } = await createTeam(db, owner.id, 't');
    const tApp = await mkApp(db, { id: owner.id, ownerId }, 'team-env');
    expect(await setEnvVar(db, KEY, member.id, tApp, 'X', '1')).toEqual({ error: 'not_found' });
    await db.insert(teamMembers).values({ teamId, accountId: member.id, role: 'member' });
    expect(await setEnvVar(db, KEY, member.id, tApp, 'X', '1')).toEqual({ ok: true });
    await db.execute(sql`select 1`);
  }));

  it('HTTP: cookie and Bearer work, names only in list, bad input rejected', () => withTestDb(async (db) => {
    const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), appEnvKey: KEY, adminEmail: 'a@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };
    const http = createHttpApp({ db, mailer: createFakeMailer(), config: cfg } as never);
    const a = await acct(db);
    const appId = await mkApp(db, a, 'envapp');
    const { token } = await createApiToken(db, a.id, 'cli');
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const put = (name: string, body: string, headers = h) => http.request(`/apps/${appId}/env/${name}`, { method: 'PUT', headers, body });
    expect((await put('API_KEY', '{"value":"s3cret"}')).status).toBe(200);
    expect((await put('PORT', '{"value":"1"}')).status).toBe(400);
    expect((await put('bad', '{"value":"1"}')).status).toBe(400);
    expect((await put('OK', '{"value":1}')).status).toBe(400);
    expect((await put('OK', JSON.stringify({ value: 'x'.repeat(50 * 1024) }))).status).toBe(413);
    const list = await http.request(`/apps/${appId}/env`, { headers: h });
    const text = await list.text();
    expect(list.status).toBe(200);
    expect(text).toContain('API_KEY');
    expect(text).not.toContain('s3cret');
    const s = await createSession(db, a.id, 'Mac');
    expect((await http.request(`/apps/${appId}/env/API_KEY`, { method: 'DELETE', headers: { cookie: `sid=${s.token}` } })).status).toBe(200);
    const b = await acct(db);
    const { token: tb } = await createApiToken(db, b.id, 'cli');
    expect((await put('X', '{"value":"1"}', { authorization: `Bearer ${tb}`, 'content-type': 'application/json' })).status).toBe(404);
    expect((await http.request(`/apps/${appId}/env`, { headers: { authorization: `Bearer ${tb}` } })).status).toBe(404);
    expect((await http.request(`/apps/${appId}/env`)).status).toBe(401);
  }));
});
