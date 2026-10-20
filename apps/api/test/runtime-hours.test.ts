import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, runtimeMinutes, runtimeUsage } from '../src/db/schema.js';
import { createTeam, ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { withAccount } from '../src/db/client.js';
import { encryptEmail } from '../src/crypto/email.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createApp as createHttpApp } from '../src/http/app.js';
import { createSession } from '../src/auth/sessions.js';
import {
  clearRuntimeBlockCache, fiscalYearKey, getRuntimeUsage, isRuntimeBlocked, jstMonthKey, meterRuntime, nextFiscalYearStart,
  nextMonthStart, runtimeBlockedUntil,
} from '../src/usage/runtime-hours.js';

const KEY = Buffer.alloc(32, 7);
let n = 0;
async function acct(db: TestDb, email: string, locale = 'ja') {
  const [a] = await db.insert(accounts).values({ emailHash: `r${n++}`, emailEnc: encryptEmail(email, KEY), displayName: 'A', locale, adultFrom: '2030-01' }).returning();
  await giveStudent(db, a!.id);
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function dyn(db: TestDb, a: { id: string; ownerId: string }, name: string) {
  const [row] = await db.insert(apps).values({ ownerId: a.ownerId, name, kind: 'dynamic' }).returning({ id: apps.id });
  return row!.id;
}
function fakeDriver(running: Array<{ appId: string; containers: number }>) {
  const stopped: string[] = [];
  return { stopped, driver: { runningCount: async () => running, stop: async (id: string) => { stopped.push(id); } } };
}
const usage = async (db: TestDb, ownerId: string, period: string) =>
  (await db.select().from(runtimeUsage).where(eq(runtimeUsage.ownerId, ownerId))).find((r) => r.period === period);

beforeEach(() => clearRuntimeBlockCache());

describe('JST periods', () => {
  it('splits months at 00:00 JST, not UTC', () => {
    expect(jstMonthKey(new Date('2026-10-31T14:59:59Z'))).toBe('2026-10');
    expect(jstMonthKey(new Date('2026-10-31T15:00:00Z'))).toBe('2026-11'); // 11/01 00:00 JST
    expect(nextMonthStart(new Date('2026-10-15T00:00:00Z')).toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(nextMonthStart(new Date('2026-12-20T00:00:00Z')).toISOString()).toBe('2026-12-31T15:00:00.000Z');
  });
  it('starts fiscal years on April 1st 00:00 JST', () => {
    expect(fiscalYearKey(new Date('2027-03-31T14:59:59Z'))).toBe('FY2026');
    expect(fiscalYearKey(new Date('2027-03-31T15:00:00Z'))).toBe('FY2027');
    expect(fiscalYearKey(new Date('2026-10-15T00:00:00Z'))).toBe('FY2026');
    expect(fiscalYearKey(new Date('2026-03-31T14:59:59Z'))).toBe('FY2025');
    expect(nextFiscalYearStart(new Date('2026-10-15T00:00:00Z')).toISOString()).toBe('2027-03-31T15:00:00.000Z');
    expect(nextFiscalYearStart(new Date('2027-02-01T00:00:00Z')).toISOString()).toBe('2027-03-31T15:00:00.000Z');
  });
});

describe('runtime metering', () => {
  it('records each app-minute once and counts month and fiscal year only on first insert', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const id = await dyn(db, a, 'my-app');
    const { driver } = fakeDriver([{ appId: id, containers: 2 }]);
    const now = () => new Date('2026-10-15T03:00:25Z');
    expect(await meterRuntime({ db, driver, now })).toBe(1);
    expect(await meterRuntime({ db, driver, now })).toBe(0); // same minute again (second worker / retry)
    const rows = await db.select().from(runtimeMinutes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.minute.toISOString()).toBe('2026-10-15T03:00:00.000Z');
    expect((await usage(db, a.ownerId, '2026-10'))?.minutes).toBe(2);
    expect((await usage(db, a.ownerId, 'FY2026'))?.minutes).toBe(2);
    expect(await meterRuntime({ db, driver, now: () => new Date('2026-10-15T03:01:00Z') })).toBe(1);
    expect((await usage(db, a.ownerId, '2026-10'))?.minutes).toBe(4);
  }));

  it('concurrent ticks never double count', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const id = await dyn(db, a, 'my-app');
    const { driver } = fakeDriver([{ appId: id, containers: 1 }]);
    const now = () => new Date('2026-10-15T03:00:00Z');
    await Promise.all([1, 2, 3, 4].map(() => meterRuntime({ db, driver, now })));
    expect((await usage(db, a.ownerId, '2026-10'))?.minutes).toBe(1);
  }));

  it('books the minute into the JST month/fiscal year it belongs to', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const id = await dyn(db, a, 'my-app');
    const { driver } = fakeDriver([{ appId: id, containers: 1 }]);
    await meterRuntime({ db, driver, now: () => new Date('2026-10-31T14:59:30Z') });
    await meterRuntime({ db, driver, now: () => new Date('2026-10-31T15:00:30Z') });
    await meterRuntime({ db, driver, now: () => new Date('2027-03-31T14:59:30Z') });
    await meterRuntime({ db, driver, now: () => new Date('2027-03-31T15:00:30Z') });
    expect((await usage(db, a.ownerId, '2026-10'))?.minutes).toBe(1);
    expect((await usage(db, a.ownerId, '2026-11'))?.minutes).toBe(1);
    expect((await usage(db, a.ownerId, '2027-03'))?.minutes).toBe(1);
    expect((await usage(db, a.ownerId, '2027-04'))?.minutes).toBe(1);
    expect((await usage(db, a.ownerId, 'FY2026'))?.minutes).toBe(3);
    expect((await usage(db, a.ownerId, 'FY2027'))?.minutes).toBe(1);
  }));

  it('aggregates per owner (team) across apps; ignores unknown and invalid apps', () => withTestDb(async (db) => {
    const o = await acct(db, 'o@example.com');
    const { ownerId } = await createTeam(db, o.id, 'Club');
    const a1 = await dyn(db, { id: o.id, ownerId }, 'app-one');
    const a2 = await dyn(db, { id: o.id, ownerId }, 'app-two');
    const { driver } = fakeDriver([{ appId: a1, containers: 1 }, { appId: a2, containers: 1 }, { appId: '00000000-0000-4000-8000-000000000000', containers: 1 }, { appId: 'not-a-uuid', containers: 1 }]);
    await meterRuntime({ db, driver, now: () => new Date('2026-10-15T03:00:00Z') });
    expect((await usage(db, ownerId, '2026-10'))?.minutes).toBe(2);
  }));

  it('mails the owner once at 80% (month), in their locale', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com', 'en');
    const id = await dyn(db, a, 'my-app');
    await db.insert(runtimeUsage).values({ ownerId: a.ownerId, period: '2026-10', minutes: 240 * 60 * 0.8 - 1 });
    const mailer = createFakeMailer();
    const { driver } = fakeDriver([{ appId: id, containers: 1 }]);
    await meterRuntime({ db, driver, mailer, emailKey: KEY, now: () => new Date('2026-10-15T03:00:00Z') });
    await meterRuntime({ db, driver, mailer, emailKey: KEY, now: () => new Date('2026-10-15T03:01:00Z') });
    await new Promise((r) => setTimeout(r, 50));
    expect(mailer.sentTo('o@example.com')).toBe(1);
    expect(mailer.lastBodyTo('o@example.com')).toContain('2026-10');
    expect((await usage(db, a.ownerId, '2026-10'))?.notified80).toBe(true);
  }));

  it('at the monthly limit stops all the owner\'s dynamic apps and blocks until the next JST month', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const other = await acct(db, 'x@example.com');
    const a1 = await dyn(db, a, 'app-one');
    const a2 = await dyn(db, a, 'app-two');
    const b1 = await dyn(db, other, 'app-other');
    await db.insert(runtimeUsage).values({ ownerId: a.ownerId, period: '2026-10', minutes: 240 * 60 - 1 });
    const { driver, stopped } = fakeDriver([{ appId: a1, containers: 1 }]);
    const t0 = new Date('2026-10-15T03:00:00Z');
    expect(await isRuntimeBlocked(db, a.ownerId, t0)).toBe(false);
    await meterRuntime({ db, driver, now: () => t0 });
    expect(stopped.sort()).toEqual([a1, a2].sort());
    expect(stopped).not.toContain(b1);
    clearRuntimeBlockCache();
    expect(await isRuntimeBlocked(db, a.ownerId, new Date('2026-10-15T03:00:30Z'))).toBe(true);
    expect((await runtimeBlockedUntil(db, a.ownerId, t0))?.toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(await isRuntimeBlocked(db, other.ownerId, t0)).toBe(false);
    // Computed unblock at 11/01 00:00 JST, even with a warm cache from the previous period.
    expect(await isRuntimeBlocked(db, a.ownerId, new Date('2026-10-31T14:59:59Z'))).toBe(true);
    expect(await isRuntimeBlocked(db, a.ownerId, new Date('2026-10-31T15:00:00Z'))).toBe(false);
  }));

  it('fiscal-year limit blocks until April 1st JST and survives a month rollover', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const id = await dyn(db, a, 'my-app');
    await db.insert(runtimeUsage).values([
      { ownerId: a.ownerId, period: 'FY2026', minutes: 2000 * 60 - 1 }, { ownerId: a.ownerId, period: '2027-02', minutes: 10 },
    ]);
    const { driver, stopped } = fakeDriver([{ appId: id, containers: 1 }]);
    await meterRuntime({ db, driver, now: () => new Date('2027-02-10T00:00:00Z') });
    expect(stopped).toEqual([id]);
    expect((await runtimeBlockedUntil(db, a.ownerId, new Date('2027-02-10T00:00:00Z')))?.toISOString()).toBe('2027-03-31T15:00:00.000Z');
    expect(await runtimeBlockedUntil(db, a.ownerId, new Date('2027-03-01T00:00:00Z'))).not.toBeNull(); // new month, same FY
    expect(await runtimeBlockedUntil(db, a.ownerId, new Date('2027-03-31T14:59:59Z'))).not.toBeNull();
    expect(await runtimeBlockedUntil(db, a.ownerId, new Date('2027-03-31T15:00:00Z'))).toBeNull();
  }));

  it('caches isRuntimeBlocked for 30 seconds', () => withTestDb(async (db) => {
    const a = await acct(db, 'o@example.com');
    const t0 = new Date('2026-10-15T03:00:00Z');
    expect(await isRuntimeBlocked(db, a.ownerId, t0)).toBe(false);
    await db.insert(runtimeUsage).values({ ownerId: a.ownerId, period: '2026-10', minutes: 240 * 60 });
    expect(await isRuntimeBlocked(db, a.ownerId, new Date(t0.getTime() + 10_000))).toBe(false);
    expect(await isRuntimeBlocked(db, a.ownerId, new Date(t0.getTime() + 31_000))).toBe(true);
  }));
});

describe('runtime read model', () => {
  it('RLS: owner/team members read, others see nothing, platform_api cannot write', () => withTestDb(async (db) => {
    const a = await acct(db, 'a@example.com');
    const b = await acct(db, 'b@example.com');
    const id = await dyn(db, a, 'my-app');
    await db.insert(runtimeUsage).values({ ownerId: a.ownerId, period: '2026-10', minutes: 5 });
    await db.insert(runtimeMinutes).values({ appId: id, minute: new Date('2026-10-15T00:00:00Z'), containers: 1 });
    expect(await withAccount(db, a.id, (tx) => tx.select().from(runtimeUsage))).toHaveLength(1);
    expect(await withAccount(db, b.id, (tx) => tx.select().from(runtimeUsage))).toHaveLength(0);
    expect(await withAccount(db, a.id, (tx) => tx.select().from(runtimeMinutes))).toHaveLength(1);
    expect(await withAccount(db, b.id, (tx) => tx.select().from(runtimeMinutes))).toHaveLength(0);
    await expect(withAccount(db, a.id, (tx) => tx.update(runtimeUsage).set({ minutes: 0 }))).rejects.toThrow();
    await expect(withAccount(db, a.id, (tx) => tx.insert(runtimeMinutes).values({ appId: id, minute: new Date(), containers: 1 }))).rejects.toThrow();
  }));

  it('getRuntimeUsage and GET /apps/:id/usage expose minutes and limits', () => withTestDb(async (db) => {
    const a = await acct(db, 'a@example.com');
    const b = await acct(db, 'b@example.com');
    const id = await dyn(db, a, 'my-app');
    const now = new Date();
    await db.insert(runtimeUsage).values([
      { ownerId: a.ownerId, period: jstMonthKey(now), minutes: 90 }, { ownerId: a.ownerId, period: fiscalYearKey(now), minutes: 300 },
    ]);
    expect(await getRuntimeUsage(db, a.id, id, now)).toEqual({
      month: { period: jstMonthKey(now), minutes: 90, limitMinutes: 14400 },
      fiscalYear: { period: fiscalYearKey(now), minutes: 300, limitMinutes: 120000 },
    });
    expect(await getRuntimeUsage(db, b.id, id, now)).toBeNull();
    const config = { appOrigin: 'http://x', rpId: 'localhost', adminEmail: 'x@example.com', emailEncKey: KEY, emailHashKey: KEY } as never;
    const http = createHttpApp({ db, mailer: createFakeMailer(), config, trustedProxyHops: 0 });
    const sa = await createSession(db, a.id, 'test');
    const res = await http.request(`/apps/${id}/usage`, { headers: { cookie: `sid=${sa.token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runtime: { month: { minutes: number } } }).runtime.month.minutes).toBe(90);
  }));
});
