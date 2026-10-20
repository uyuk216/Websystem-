import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accessLogs, accounts, apps, deployments } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { createApp } from '../src/apps/apps.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createApiToken } from '../src/apps/api-tokens.js';
import { createAccessLogger, getAppLogs, listAccessLogs, purgeOldAccessLogs, uaKind } from '../src/apps/logs.js';
import { setEnvVar } from '../src/apps/env-vars.js';

const KEY = Buffer.alloc(32, 7);
let n = 0;
async function acct(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `l${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  await giveStudent(db, a!.id);
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function mkApp(db: TestDb, a: { id: string; ownerId: string }, name: string) {
  const r = await createApp(db, a.id, { name, ownerId: a.ownerId });
  if (!('appId' in r)) throw new Error(r.error);
  return r.appId;
}

describe('access logs', () => {
  it('batches writes, masks IPs, classifies UA, strips referrer path', () => withTestDb(async (db) => {
    const a = await acct(db);
    const appId = await mkApp(db, a, 'logapp');
    const log = createAccessLogger(db);
    log.record({ appId, method: 'GET', path: '/x', status: 200, bytes: 12, userAgent: 'Mozilla/5.0 Chrome', referrer: 'https://e.com/a?token=1', ip: '203.0.113.77' });
    log.record({ appId, method: 'GET', path: '/y', status: 404, bytes: 0, userAgent: 'curl/8', ip: '2001:db8:1234:5678::1' });
    expect(await db.select().from(accessLogs)).toHaveLength(0);
    await log.flush();
    const rows = await db.select().from(accessLogs);
    expect(rows.map((r) => r.ipPrefix).sort()).toEqual(['2001:db8:1234::/48', '203.0.113.0/24']);
    expect(rows.find((r) => r.path === '/x')).toMatchObject({ uaKind: 'browser', referrer: 'https://e.com' });
    expect(uaKind('Googlebot/2.1')).toBe('bot');
    // The full address never reaches the table (check the IP column only: ids and timestamps may contain "77").
    expect(rows.every((r) => !r.ipPrefix.includes('.77'))).toBe(true);
  }));

  it('purges rows older than 30 days', () => withTestDb(async (db) => {
    const a = await acct(db);
    const appId = await mkApp(db, a, 'logapp');
    const now = new Date('2026-10-15T00:00:00Z');
    const base = { appId, method: 'GET', path: '/', status: 200, uaKind: 'other', ipPrefix: '1.2.3.0/24' };
    await db.insert(accessLogs).values([{ ...base, createdAt: new Date('2026-09-14T00:00:00Z') }, { ...base, createdAt: new Date('2026-09-20T00:00:00Z') }]);
    expect(await purgeOldAccessLogs(db, now)).toBe(1);
    expect(await db.select().from(accessLogs)).toHaveLength(1);
  }));

  it('re-queues rows when the insert fails (retried on the next flush)', () => withTestDb(async (db) => {
    const log = createAccessLogger(db, { maxBuffer: 3 });
    log.record({ appId: '00000000-0000-4000-8000-000000000000', method: 'GET', path: '/bad', status: 200, bytes: 0, ip: '1.2.3.4' }); // FK violation
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await log.flush();
    await log.flush();
    expect(err).toHaveBeenCalledTimes(2); // second flush found the row again
    err.mockRestore();
  }));

  it('is visible to the owner only, newest first, limit capped', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    const appId = await mkApp(db, a, 'logapp');
    const base = { appId, method: 'GET', status: 200, uaKind: 'other', ipPrefix: '1.2.3.0/24' };
    await db.insert(accessLogs).values([
      { ...base, path: '/old', createdAt: new Date('2026-10-01T00:00:00Z') }, { ...base, path: '/new', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);
    const mine = await listAccessLogs(db, a.id, appId);
    expect('logs' in mine && mine.logs!.map((l) => l.path)).toEqual(['/new', '/old']);
    expect('logs' in (await listAccessLogs(db, a.id, appId, 1)) && (await listAccessLogs(db, a.id, appId, 1) as { logs: unknown[] }).logs).toHaveLength(1);
    expect(await listAccessLogs(db, b.id, appId)).toEqual({ error: 'not_found' });
    // writes are system-only
    const { withAccount } = await import('../src/db/client.js');
    await expect(withAccount(db, a.id, (tx) => tx.delete(accessLogs).where(eq(accessLogs.appId, appId)))).rejects.toThrow();
    // HTTP
    const http = createHttpApp({ db, mailer: createFakeMailer(), config: { appEnvKey: KEY } } as never);
    const t = await createApiToken(db, a.id, 'cli');
    const r = await http.request(`/apps/${appId}/access-logs?limit=1`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(r.status).toBe(200);
    expect((await r.json() as { logs: unknown[] }).logs).toHaveLength(1);
    const t2 = await createApiToken(db, b.id, 'cli');
    expect((await http.request(`/apps/${appId}/access-logs`, { headers: { authorization: `Bearer ${t2.token}` } })).status).toBe(404);
  }));
});

describe('app logs', () => {
  it('returns the active deployment tail with env values redacted; other accounts get 404', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    const appId = await mkApp(db, a, 'logapp');
    await db.update(apps).set({ kind: 'dynamic' }).where(eq(apps.id, appId));
    const [d] = await db.insert(deployments).values({ appId, source: 'upload', status: 'live', imageRef: 'ys/x:1', sourceKey: 'k' } as never).returning({ id: deployments.id });
    await db.update(apps).set({ activeDeploymentId: d!.id }).where(eq(apps.id, appId));
    await setEnvVar(db, KEY, a.id, appId, 'TOKEN', 'supersecretvalue');
    const calls: unknown[][] = [];
    const rt = { envKey: KEY, driver: { logs: async (...args: unknown[]) => { calls.push(args); return ['boot', 'key=supersecretvalue']; } } } as never;
    expect(await getAppLogs(db, rt, a.id, appId, 5000)).toEqual({ lines: ['boot', 'key=***'] });
    expect(calls[0]).toEqual([appId, 1000, d!.id]);
    expect(await getAppLogs(db, rt, b.id, appId)).toEqual({ error: 'not_found' });
    const http = createHttpApp({ db, mailer: createFakeMailer(), config: { appEnvKey: KEY }, runtime: rt } as never);
    const ta = await createApiToken(db, a.id, 'cli');
    const tb = await createApiToken(db, b.id, 'cli');
    const ok = await http.request(`/apps/${appId}/logs`, { headers: { authorization: `Bearer ${ta.token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ lines: ['boot', 'key=***'] });
    expect((await http.request(`/apps/${appId}/logs`, { headers: { authorization: `Bearer ${tb.token}` } })).status).toBe(404);
  }));
});
