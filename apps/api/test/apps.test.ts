import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, deployments, teamMembers } from '../src/db/schema.js';
import { createTeam, ensureAccountOwner } from '../src/teams/teams.js';
import { createApp, deleteApp, getApp, listApps, listOwners, updateApp } from '../src/apps/apps.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createSession } from '../src/auth/sessions.js';
import { withAccount } from '../src/db/client.js';

let n = 0;
async function acct(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `h${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}

describe('apps', () => {
  it('lists only the owners the account can act for', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    const team = await createTeam(db, a.id, 'Club');
    const mine = await listOwners(db, a.id);
    expect(mine.map((o) => o.id).sort()).toEqual([a.ownerId, team.ownerId].sort());
    expect(mine.find((o) => o.id === team.ownerId)).toMatchObject({ kind: 'team', name: 'Club' });
    expect((await listOwners(db, b.id)).map((o) => o.id)).toEqual([b.ownerId]);
  }));

  it('creates, lists, gets, updates and deletes', () => withTestDb(async (db) => {
    const a = await acct(db);
    const r = await createApp(db, a.id, { name: 'my-site', ownerId: a.ownerId });
    expect(r).toHaveProperty('appId');
    const { appId } = r as { appId: string };
    expect((await listApps(db, a.id)).map((x) => x.name)).toEqual(['my-site']);
    expect(await getApp(db, a.id, appId)).toMatchObject({ name: 'my-site', kind: 'static', publishDir: '', activeDeploymentId: null });
    expect(await updateApp(db, a.id, appId, { publishDir: '/dist/' })).toEqual({ ok: true });
    expect((await getApp(db, a.id, appId))?.publishDir).toBe('dist');
    expect(await updateApp(db, a.id, appId, { publishDir: '../x' })).toEqual({ error: 'invalid' });
    let cleaned = '';
    expect(await deleteApp(db, a.id, appId, { enqueueStorageCleanup: async (id) => { cleaned = id; } })).toEqual({ ok: true });
    expect(cleaned).toBe(appId);
    expect(await listApps(db, a.id)).toEqual([]);
  }));

  it('rejects bad and reserved names', () => withTestDb(async (db) => {
    const a = await acct(db);
    expect(await createApp(db, a.id, { name: 'ab', ownerId: a.ownerId })).toEqual({ error: 'format' });
    expect(await createApp(db, a.id, { name: 'admin', ownerId: a.ownerId })).toEqual({ error: 'reserved' });
  }));

  it('reports taken for a name used by someone else, and enforces one site per owner', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    await createApp(db, a.id, { name: 'taken-name', ownerId: a.ownerId });
    expect(await createApp(db, b.id, { name: 'taken-name', ownerId: b.ownerId })).toEqual({ error: 'taken' });
    expect(await createApp(db, a.id, { name: 'second-one', ownerId: a.ownerId })).toEqual({ error: 'limit' });
  }));

  it('concurrent creates for one owner yield exactly one app', () => withTestDb(async (db) => {
    const a = await acct(db);
    const rs = await Promise.all(['site-aaa', 'site-bbb', 'site-ccc'].map((name) => createApp(db, a.id, { name, ownerId: a.ownerId })));
    expect(rs.filter((r) => 'appId' in r)).toHaveLength(1);
    expect(rs.filter((r) => 'error' in r && r.error === 'limit')).toHaveLength(2);
  }));

  it('cannot create for someone else\'s owner, and cannot see or touch their apps', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    const { appId } = await createApp(db, a.id, { name: 'a-site', ownerId: a.ownerId }) as { appId: string };
    expect(await createApp(db, b.id, { name: 'b-steal', ownerId: a.ownerId })).toEqual({ error: 'forbidden' });
    expect(await listApps(db, b.id)).toEqual([]);
    expect(await getApp(db, b.id, appId)).toBeNull();
    expect(await updateApp(db, b.id, appId, { publishDir: 'x' })).toEqual({ error: 'not_found' });
    expect(await deleteApp(db, b.id, appId)).toEqual({ error: 'not_found' });
    expect(await listApps(db, a.id)).toHaveLength(1);
  }));

  it('team: member can create (deploy permission), outsider cannot, members see the app', () => withTestDb(async (db) => {
    const owner = await acct(db);
    const member = await acct(db);
    const outsider = await acct(db);
    const { teamId, ownerId } = await createTeam(db, owner.id, 't');
    await db.insert(teamMembers).values({ teamId, accountId: member.id, role: 'member' });
    expect(await createApp(db, outsider.id, { name: 'team-site', ownerId })).toEqual({ error: 'forbidden' });
    const r = await createApp(db, member.id, { name: 'team-site', ownerId });
    expect(r).toHaveProperty('appId');
    expect(await listApps(db, owner.id)).toHaveLength(1);
    expect(await listApps(db, outsider.id)).toEqual([]);
    expect(await createApp(db, owner.id, { name: 'team-two', ownerId })).toEqual({ error: 'limit' });
  }));

  it('RLS: deployments follow their app; app_can_access_owner is defined', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    const { appId } = await createApp(db, a.id, { name: 'dep-site', ownerId: a.ownerId }) as { appId: string };
    await db.insert(deployments).values({ appId, source: 'upload', sourceKey: 'k' });
    expect(await withAccount(db, a.id, (tx) => tx.select().from(deployments))).toHaveLength(1);
    expect(await withAccount(db, b.id, (tx) => tx.select().from(deployments))).toHaveLength(0);
    await db.delete(deployments).where(eq(deployments.appId, appId));
  }));

  it('HTTP: GET/POST /apps, GET/PATCH/DELETE /apps/:id', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    const app = createHttpApp({ db, mailer: createFakeMailer(), config: { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'x@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' } });
    expect((await app.request('/apps')).status).toBe(401);
    const ck = `sid=${(await createSession(db, a.id, 'x')).token}`;
    const bk = `sid=${(await createSession(db, b.id, 'x')).token}`;
    const h = (cookie: string) => ({ 'content-type': 'application/json', cookie });
    const post = (body: unknown, cookie = ck) => app.request('/apps', { method: 'POST', headers: h(cookie), body: JSON.stringify(body) });
    expect((await post({ name: 'ab', ownerId: a.ownerId })).status).toBe(400);
    expect((await post({ name: 'admin', ownerId: a.ownerId })).status).toBe(400);
    expect((await post({ name: 'http-site', ownerId: b.ownerId })).status).toBe(403);
    const created = await post({ name: 'http-site', ownerId: a.ownerId });
    expect(created.status).toBe(201);
    const { appId } = await created.json() as { appId: string };
    expect((await post({ name: 'http-two', ownerId: a.ownerId })).status).toBe(409);
    expect((await app.request(`/apps/${appId}`, { headers: { cookie: ck } })).status).toBe(200);
    expect((await app.request(`/apps/${appId}`, { headers: { cookie: bk } })).status).toBe(404);
    expect((await app.request('/apps/not-a-uuid', { headers: { cookie: ck } })).status).toBe(404);
    expect((await app.request(`/apps/${appId}`, { method: 'PATCH', headers: h(ck), body: JSON.stringify({ publishDir: 'dist' }) })).status).toBe(200);
    expect((await app.request(`/apps/${appId}`, { method: 'PATCH', headers: h(bk), body: JSON.stringify({ publishDir: 'x' }) })).status).toBe(404);
    const list = await (await app.request('/apps', { headers: { cookie: ck } })).json() as { apps: { publishDir: string }[] };
    expect(list.apps[0]?.publishDir).toBe('dist');
    expect((await app.request(`/apps/${appId}`, { method: 'DELETE', headers: { cookie: bk } })).status).toBe(404);
    expect((await app.request(`/apps/${appId}`, { method: 'DELETE', headers: { cookie: ck } })).status).toBe(200);
  }));
});
