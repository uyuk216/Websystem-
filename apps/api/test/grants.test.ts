import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DATABASE_LIMITS, DYNAMIC_LIMITS, NO_PLAN_DYNAMIC_LIMITS, STARTER_LIMITS, STATIC_LIMITS, endOfMarchJst, suspendDateFor } from 'shared';
import { withTestDb, type TestDb } from './helpers/db.js';
import { giveStudent } from './helpers/grants.js';
import { accounts, appDatabases, apps, grants, operators, platformSettings } from '../src/db/schema.js';
import { withAccount } from '../src/db/client.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { addDatabase, getDatabase } from '../src/apps/databases.js';
import { resolveEntitlements } from '../src/grants/entitlements.js';
import { grantStudent, revokeGrant } from '../src/grants/grants.js';
import { getRuntimeUsage, runtimeBlockedUntil } from '../src/usage/runtime-hours.js';

let n = 0;
async function acct(db: TestDb) {
  const [a] = await db.insert(accounts).values({ emailHash: `g${n++}-${randomUUID()}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
const jst = (s: string) => new Date(`${s}+09:00`);
const T0 = jst('2027-01-15T12:00:00');

describe('resolveEntitlements', () => {
  it('no grant = the "none" plan: no dynamic apps, no database, no runtime hours; static sites unchanged', () => withTestDb(async (db) => {
    const a = await acct(db);
    const e = await resolveEntitlements(db, a.ownerId, T0);
    expect(e.plan).toBe('none');
    expect(e.dynamic).toMatchObject({ appsPerOwner: 0, monthlyHours: 0, fiscalYearHours: 0, memoryMb: 0 });
    expect(e.dynamic.appsPerOwner).toBe(NO_PLAN_DYNAMIC_LIMITS.appsPerOwner);
    expect(e.database.sizeBytes).toBe(0);
    expect(e.static).toEqual(STATIC_LIMITS);
    expect(e.endsAt).toBeNull();
    // Rejected: dynamic app creation, database creation, running (blocked until the period end).
    expect(await createApp(db, a.id, { name: `n-${randomUUID().slice(0, 8)}`, ownerId: a.ownerId, kind: 'dynamic' })).toEqual({ error: 'plan_required' });
    expect(await createApp(db, a.id, { name: `s-${randomUUID().slice(0, 8)}`, ownerId: a.ownerId })).toHaveProperty('appId');
    const [d] = await db.insert(apps).values({ ownerId: a.ownerId, name: `d-${randomUUID().slice(0, 8)}`, kind: 'dynamic' }).returning();
    const rt = { envKey: Buffer.alloc(32, 1), databases: { create: async () => { throw new Error('must not be called'); } } as never };
    expect(await addDatabase(db, rt, a.id, d!.id)).toEqual({ error: 'plan_required' });
    expect(await db.select().from(appDatabases)).toHaveLength(0);
    expect(await runtimeBlockedUntil(db, a.ownerId, T0)).not.toBeNull();
  }));

  it('Student has the spec values and the same behaviour as before; expires back to "none"', () => withTestDb(async (db) => {
    const a = await acct(db);
    await grantStudent(db, a.id, endOfMarchJst(2027), { startsAt: jst('2026-10-01T00:00:00') });
    const e = await resolveEntitlements(db, a.ownerId, T0);
    expect(e).toMatchObject({ plan: 'student', endsAt: endOfMarchJst(2027), suspendOn: jst('2027-05-01T00:00:00') });
    expect(e.dynamic).toEqual({ ...DYNAMIC_LIMITS });
    expect(e.database).toEqual({ sizeBytes: DATABASE_LIMITS.sizeBytes, connections: DATABASE_LIMITS.connections, memoryMb: DATABASE_LIMITS.memoryMb });
    expect(suspendDateFor(endOfMarchJst(2027))).toEqual(jst('2027-05-01T00:00:00'));
    expect(await runtimeBlockedUntil(db, a.ownerId, T0)).toBeNull();
    const r1 = await createApp(db, a.id, { name: `d1-${randomUUID().slice(0, 8)}`, ownerId: a.ownerId, kind: 'dynamic' });
    expect(r1).toHaveProperty('appId');
    expect(await createApp(db, a.id, { name: `d2-${randomUUID().slice(0, 8)}`, ownerId: a.ownerId, kind: 'dynamic' })).toEqual({ error: 'limit' });
    expect(await getRuntimeUsage(db, a.id, (r1 as { appId: string }).appId, T0)).toMatchObject({ month: { limitMinutes: 240 * 60 }, fiscalYear: { limitMinutes: 2000 * 60 } });
    // Boundaries: last instant valid, then "none".
    expect((await resolveEntitlements(db, a.ownerId, endOfMarchJst(2027))).plan).toBe('student');
    expect((await resolveEntitlements(db, a.ownerId, new Date(endOfMarchJst(2027).getTime() + 1))).plan).toBe('none');
    expect((await resolveEntitlements(db, a.ownerId, jst('2026-09-30T23:59:59'))).plan).toBe('none');
  }));

  it('re-registration renews the same Student grant; revoking drops the plan', () => withTestDb(async (db) => {
    const a = await acct(db);
    await grantStudent(db, a.id, endOfMarchJst(2027), { startsAt: jst('2026-10-01T00:00:00') });
    await grantStudent(db, a.id, endOfMarchJst(2028), { startsAt: jst('2027-04-10T00:00:00') });
    const rows = await db.select().from(grants);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endsAt: endOfMarchJst(2028), suspendOn: jst('2028-05-01T00:00:00') });
    expect((await resolveEntitlements(db, a.ownerId, jst('2027-06-01T00:00:00'))).plan).toBe('student');
    expect(await revokeGrant(db, rows[0]!.id)).toBe(true);
    expect(await revokeGrant(db, rows[0]!.id)).toBe(false);
    expect((await resolveEntitlements(db, a.ownerId, jst('2027-06-01T00:00:00'))).plan).toBe('none');
  }));

  it('Starter is Student + 2 dynamic apps (provisional), once per account; boosts add on top during their period', () => withTestDb(async (db) => {
    const a = await acct(db);
    const base = { targetKind: 'account' as const, targetId: a.id, startsAt: jst('2026-12-01T00:00:00'), endsAt: jst('2027-06-01T00:00:00'), approvedBy: 'system' };
    await db.insert(grants).values({ ...base, kind: 'starter' });
    await expect(db.insert(grants).values({ ...base, kind: 'starter' })).rejects.toThrow();
    const e = await resolveEntitlements(db, a.ownerId, T0);
    expect(e.plan).toBe('starter');
    expect(e.dynamic).toEqual({ ...STARTER_LIMITS });
    expect(e.dynamic.appsPerOwner).toBe(2);
    await db.insert(grants).values({ ...base, kind: 'event_boost', startsAt: jst('2027-01-14T00:00:00'), endsAt: jst('2027-01-16T00:00:00'), params: { extraTransferBytes: 1000, extraMemoryMb: 256, sleepOff: true } });
    const boosted = await resolveEntitlements(db, a.ownerId, T0);
    expect(boosted.static.monthlyTransferBytes).toBe(STATIC_LIMITS.monthlyTransferBytes + 1000);
    expect(boosted.dynamic).toMatchObject({ memoryMb: 512 + 256, sleepAfterMinutes: null });
    expect((await resolveEntitlements(db, a.ownerId, jst('2027-01-17T00:00:00'))).dynamic.sleepAfterMinutes).toBe(15);
  }));

  it('platform_settings override the numbers (known limits.* keys with valid values only; "none" stays none)', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    await giveStudent(db, a.id);
    await db.insert(operators).values({ accountId: b.id, tailscaleLogin: 'op@x.y', role: 'owner' });
    await db.insert(platformSettings).values([
      { key: 'limits.dynamic.monthlyHours', value: 100, updatedBy: b.id },
      { key: 'limits.static.sitesPerOwner', value: 3, updatedBy: b.id },
      { key: 'limits.database.sizeBytes', value: 'big', updatedBy: b.id }, // invalid value: ignored
      { key: 'limits.nonsense', value: 5, updatedBy: b.id }, // unknown key: ignored
    ]);
    const e = await resolveEntitlements(db, a.ownerId, T0);
    expect(e.dynamic.monthlyHours).toBe(100);
    expect(e.dynamic.fiscalYearHours).toBe(DYNAMIC_LIMITS.fiscalYearHours);
    expect(e.static.sitesPerOwner).toBe(3);
    expect(e.database.sizeBytes).toBe(DATABASE_LIMITS.sizeBytes);
    const c = await acct(db);
    const none = await resolveEntitlements(db, c.ownerId, T0);
    expect(none.dynamic.monthlyHours).toBe(0);
    expect(none.static.sitesPerOwner).toBe(3);
    // The override reaches the metering periods and the database limit shown to the user.
    const r = await createApp(db, a.id, { name: `o-${randomUUID().slice(0, 8)}`, ownerId: a.ownerId, kind: 'dynamic' }) as { appId: string };
    expect(await getRuntimeUsage(db, a.id, r.appId, T0)).toMatchObject({ month: { limitMinutes: 100 * 60 } });
    await db.insert(appDatabases).values({ appId: r.appId, passwordEnc: 'x', status: 'ready' });
    expect(await getDatabase(db, a.id, r.appId)).toMatchObject({ database: { limitBytes: DATABASE_LIMITS.sizeBytes } });
    await db.update(platformSettings).set({ value: 1024 }).where(eq(platformSettings.key, 'limits.database.sizeBytes'));
    expect(await getDatabase(db, a.id, r.appId)).toMatchObject({ database: { limitBytes: 1024 } });
  }));
});

describe('grants table access', () => {
  it('users read only their own grants and can never write', () => withTestDb(async (db) => {
    const a = await acct(db);
    const b = await acct(db);
    await giveStudent(db, a.id);
    await giveStudent(db, b.id);
    const seen = await withAccount(db, a.id, (tx) => tx.select().from(grants));
    expect(seen.map((g) => g.targetId)).toEqual([a.id]);
    const base = { targetKind: 'account' as const, targetId: a.id, kind: 'student' as const, startsAt: new Date(), endsAt: new Date(Date.now() + 1000), approvedBy: 'me' };
    await expect(withAccount(db, a.id, (tx) => tx.insert(grants).values(base))).rejects.toThrow();
    await expect(withAccount(db, a.id, (tx) => tx.update(grants).set({ endsAt: new Date('2200-01-01') }))).rejects.toThrow();
    await expect(withAccount(db, a.id, (tx) => tx.execute(sql`delete from grants`))).rejects.toThrow();
  }));
});
