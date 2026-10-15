import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, transferUsage } from '../src/db/schema.js';
import { createTeam, ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { withAccount } from '../src/db/client.js';
import { encryptEmail } from '../src/crypto/email.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createTransferMeter, getUsage, monthKey, secondsUntilNextMonth } from '../src/usage/transfer.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createSession } from '../src/auth/sessions.js';

const KEY = Buffer.alloc(32, 7);
let n = 0;
async function acct(db: TestDb, email: string, locale = 'ja') {
  const [a] = await db.insert(accounts).values({ emailHash: `h${n++}`, emailEnc: encryptEmail(email, KEY), displayName: 'A', locale, adultFrom: '2030-01' }).returning();
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function site(db: TestDb, a: { id: string; ownerId: string }, name = 'my-site') {
  return ((await createApp(db, a.id, { name, ownerId: a.ownerId })) as { appId: string }).appId;
}
const rowOf = async (db: TestDb, appId: string, month: string) =>
  (await db.select().from(transferUsage).where(and(eq(transferUsage.appId, appId), eq(transferUsage.month, month))))[0];
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('month helpers', () => {
  it('uses the UTC month', () => {
    expect(monthKey(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(monthKey(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
    expect(secondsUntilNextMonth(new Date('2026-12-31T23:59:00Z'))).toBe(60);
  });
});

describe('transfer meter', () => {
  const setup = (db: TestDb, o: { limit?: number } = {}) => {
    const mailer = createFakeMailer();
    const clock = { t: new Date('2026-10-15T00:00:00Z') };
    const meter = createTransferMeter({ db, mailer, emailKey: KEY, limitBytes: o.limit ?? 1000, now: () => clock.t });
    return { mailer, clock, meter };
  };

  it('adds in-memory counters to transfer_usage on each flush', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const id = await site(db, a);
    const { meter } = setup(db);
    meter.record(id, 100);
    meter.record(id, 50);
    await meter.flush();
    expect((await rowOf(db, id, '2026-10'))?.bytes).toBe(150);
    meter.record(id, 25);
    await meter.flush();
    expect((await rowOf(db, id, '2026-10'))?.bytes).toBe(175);
    await meter.flush(); // nothing pending: no-op
    expect((await rowOf(db, id, '2026-10'))?.bytes).toBe(175);
  }));

  it('blocks at the limit (30s cache, pending bytes counted) and resumes in a new UTC month', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const id = await site(db, a);
    const { meter, clock } = setup(db);
    expect(await meter.isBlocked(id)).toBe(false);
    meter.record(id, 1000);
    expect(await meter.isBlocked(id)).toBe(false); // cached for 30s
    clock.t = new Date('2026-10-15T00:00:31Z');
    expect(await meter.isBlocked(id)).toBe(true); // pending (unflushed) bytes count
    await meter.flush();
    clock.t = new Date('2026-10-31T23:59:59Z');
    expect(await meter.isBlocked(id)).toBe(true);
    clock.t = new Date('2026-11-01T00:00:00Z');
    expect(await meter.isBlocked(id)).toBe(false);
    meter.record(id, 10);
    await meter.flush();
    expect((await rowOf(db, id, '2026-11'))?.bytes).toBe(10);
    expect((await rowOf(db, id, '2026-10'))?.bytes).toBe(1000);
  }));

  it('mails the owner once at 80% (in the account locale) and again only in a new month', () => withTestDb(async (db) => {
    const a = await acct(db, 'owner@example.com', 'ja');
    const id = await site(db, a);
    const { meter, mailer, clock } = setup(db);
    meter.record(id, 700);
    await meter.flush();
    await settle();
    expect(mailer.sentTo('owner@example.com')).toBe(0);
    meter.record(id, 100);
    await meter.flush();
    await settle();
    expect(mailer.sentTo('owner@example.com')).toBe(1);
    expect(mailer.lastBodyTo('owner@example.com')).toContain('80%');
    expect(mailer.lastBodyTo('owner@example.com')).toContain('サイト');
    expect((await rowOf(db, id, '2026-10'))?.notified80).toBe(true);
    meter.record(id, 100);
    await meter.flush();
    await settle();
    expect(mailer.sentTo('owner@example.com')).toBe(1);
    clock.t = new Date('2026-11-02T00:00:00Z');
    meter.record(id, 900);
    await meter.flush();
    await settle();
    expect(mailer.sentTo('owner@example.com')).toBe(2);
  }));

  it('sends the notification once even when two processes flush concurrently', () => withTestDb(async (db) => {
    const a = await acct(db, 'owner@example.com');
    const id = await site(db, a);
    const m1 = setup(db);
    const meter2 = createTransferMeter({ db, mailer: m1.mailer, emailKey: KEY, limitBytes: 1000, now: () => m1.clock.t });
    m1.meter.record(id, 850);
    meter2.record(id, 10);
    await Promise.all([m1.meter.flush(), meter2.flush()]);
    await settle();
    expect(m1.mailer.sentTo('owner@example.com')).toBe(1);
  }));

  it('notifies the team owner (in their locale) for a team-owned site', () => withTestDb(async (db) => {
    const owner = await acct(db, 'teamowner@example.com', 'en');
    const { ownerId } = await createTeam(db, owner.id, 'Club');
    const id = await site(db, { id: owner.id, ownerId });
    const { meter, mailer } = setup(db);
    meter.record(id, 900);
    await meter.flush();
    await settle();
    expect(mailer.sentTo('teamowner@example.com')).toBe(1);
    expect(mailer.lastBodyTo('teamowner@example.com')).toContain('monthly transfer limit');
  }));

  it('stop() flushes and waits for the in-flight notification mail', () => withTestDb(async (db) => {
    const a = await acct(db, 'owner@example.com');
    const id = await site(db, a);
    const mailer = createFakeMailer();
    const slow = { sendMail: async (...x: Parameters<typeof mailer.sendMail>) => { await new Promise((r) => setTimeout(r, 100)); await mailer.sendMail(...x); } };
    const meter = createTransferMeter({ db, mailer: slow, emailKey: KEY, limitBytes: 1000 });
    meter.record(id, 900);
    await meter.stop();
    expect(mailer.sentTo('owner@example.com')).toBe(1);
  }));

  it('drops counters of a deleted app without failing the flush', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const id = await site(db, a);
    const { meter } = setup(db);
    await db.delete(apps).where(eq(apps.id, id));
    meter.record(id, 10);
    await expect(meter.flush()).resolves.toBeUndefined();
  }));
});

describe('usage read model', () => {
  it('RLS: another account selecting transfer_usage directly sees no rows', () => withTestDb(async (db) => {
    const a = await acct(db, 'a@example.com');
    const b = await acct(db, 'b@example.com');
    const id = await site(db, a);
    await db.insert(transferUsage).values({ appId: id, month: '2026-10', bytes: 1 });
    expect(await withAccount(db, b.id, (tx) => tx.select().from(transferUsage))).toHaveLength(0);
    expect(await withAccount(db, a.id, (tx) => tx.select().from(transferUsage))).toHaveLength(1);
  }));

  it('shows the current month and the limit to the owner only (RLS), read-only for platform_api', () => withTestDb(async (db) => {
    const a = await acct(db, 'a@example.com');
    const b = await acct(db, 'b@example.com');
    const id = await site(db, a);
    await db.insert(transferUsage).values({ appId: id, month: '2026-10', bytes: 123 });
    const now = new Date('2026-10-20T00:00:00Z');
    expect(await getUsage(db, a.id, id, now)).toEqual({ month: '2026-10', bytes: 123, limitBytes: 10 * 1024 ** 3 });
    expect(await getUsage(db, a.id, id, new Date('2026-11-01T00:00:00Z'))).toMatchObject({ month: '2026-11', bytes: 0 });
    expect(await getUsage(db, b.id, id, now)).toBeNull();
    await expect(withAccount(db, a.id, (tx) => tx.update(transferUsage).set({ bytes: 0 }))).rejects.toThrow();
    await expect(withAccount(db, a.id, (tx) => tx.insert(transferUsage).values({ appId: id, month: '2026-09', bytes: 1 }))).rejects.toThrow();
  }));

  it('GET /apps/:id/usage', () => withTestDb(async (db) => {
    const a = await acct(db, 'a@example.com');
    const b = await acct(db, 'b@example.com');
    const id = await site(db, a);
    const month = monthKey(new Date());
    await db.insert(transferUsage).values({ appId: id, month, bytes: 5 });
    const config = { appOrigin: 'http://x', rpId: 'localhost', adminEmail: 'x@example.com', emailEncKey: KEY, emailHashKey: KEY } as never;
    const http = createHttpApp({ db, mailer: createFakeMailer(), config, trustedProxyHops: 0 });
    const sa = await createSession(db, a.id, 'test');
    const sb = await createSession(db, b.id, 'test');
    const get = (tok: string, path: string) => http.request(path, { headers: { cookie: `sid=${tok}` } });
    const ok = await get(sa.token, `/apps/${id}/usage`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ month, bytes: 5, limitBytes: 10 * 1024 ** 3 });
    expect((await get(sb.token, `/apps/${id}/usage`)).status).toBe(404);
    expect((await get(sa.token, '/apps/not-a-uuid/usage')).status).toBe(404);
  }));
});
