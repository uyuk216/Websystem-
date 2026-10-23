import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RuntimeDriver } from 'platform';
import { DYNAMIC_LIMITS, STATIC_LIMITS } from 'shared';
import { withTestDb, type TestDb } from './helpers/db.js';
import { giveStudent } from './helpers/grants.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, apps, deployments, eventBoosts, grants, transferUsage } from '../src/db/schema.js';
import { encryptEmail } from '../src/crypto/email.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { BOOST_DEFAULTS, approveEventBoost, reconcileEventBoosts, rejectEventBoost, requestEventBoost } from '../src/grants/event-boost.js';
import { resolveEntitlements } from '../src/grants/entitlements.js';
import { sleepIdleApps } from '../src/apps/wake.js';
import { createTransferMeter } from '../src/usage/transfer.js';
import { getRuntimeUsage, meterRuntime, clearRuntimeBlockCache } from '../src/usage/runtime-hours.js';
import type { DynamicRuntime } from '../src/ingest/dynamic.js';

vi.setConfig({ testTimeout: 30_000 });
const KEY = Buffer.alloc(32, 5);
const DAY = 86_400_000;
const NOW = new Date('2027-02-01T03:00:00Z');
const START = new Date(NOW.getTime() + 5 * DAY);
const END = new Date(START.getTime() + 2 * DAY);
const iso = (d: Date) => d.toISOString();
let n = 0;

const srv = createServer((_q, r) => r.end('ok'));
let port = 1;
beforeAll(async () => { await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as AddressInfo).port; });
afterAll(() => { srv.close(); });

async function setup(db: TestDb, kind: 'static' | 'dynamic' = 'dynamic') {
  const email = `b${n++}-${randomUUID().slice(0, 6)}@example.com`;
  const [a] = await db.insert(accounts).values({ emailHash: `eb${n}-${randomUUID()}`, emailEnc: encryptEmail(email, KEY), displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  await giveStudent(db, a!.id);
  const [app] = await db.insert(apps).values({ ownerId, name: `b-${randomUUID().slice(0, 8)}`, kind }).returning();
  const [d] = await db.insert(deployments).values({ appId: app!.id, source: 'upload', status: 'live', sourceKey: 'k', imageRef: 'img:1' }).returning();
  await db.update(apps).set({ activeDeploymentId: d!.id }).where(eq(apps.id, app!.id));
  return { accountId: a!.id, email, ownerId, appId: app!.id };
}
const body = (over: Record<string, unknown> = {}) => ({ eventName: 'Hack day', startsAt: iso(START), endsAt: iso(END), expectedVisits: 5000, ...over });
const req = (db: TestDb, s: { accountId: string; appId: string }, over: Record<string, unknown> = {}) => requestEventBoost(db, s.accountId, s.appId, body(over), NOW);

function fakeRuntime(running: string[]) {
  const starts: Array<{ appId: string; memoryMb: number }> = [];
  const stops: string[] = [];
  const driver = {
    start: async (spec: { appId: string; limits: { memoryMb: number } }) => { starts.push({ appId: spec.appId, memoryMb: spec.limits.memoryMb }); return {}; },
    stopDeployment: async (appId: string) => { stops.push(appId); },
    status: async () => 'running',
    endpoint: async () => ({ host: '127.0.0.1', port }),
    logs: async () => [],
    runningCount: async () => running.map((appId) => ({ appId, containers: 1 })),
  } as unknown as RuntimeDriver;
  const rt: DynamicRuntime = { driver, envKey: Buffer.alloc(32, 7), health: { timeoutMs: 500, intervalMs: 50 } };
  return { rt, starts, stops };
}

describe('event boost: request rules', () => {
  it('accepts a valid request and rejects late, too long, overlapping, static and unauthorised ones', () => withTestDb(async (db) => {
    const s = await setup(db);
    expect(await req(db, s, { startsAt: iso(new Date(NOW.getTime() + 3 * DAY - 1000)), endsAt: iso(END) })).toEqual({ error: 'too_late' });
    expect(await req(db, s, { endsAt: iso(new Date(START.getTime() + 7 * DAY + 1000)) })).toEqual({ error: 'too_long' });
    expect(await req(db, s, { endsAt: iso(START) })).toEqual({ error: 'period' });
    expect(await req(db, s, { eventName: '' })).toEqual({ error: 'event_name' });
    expect(await req(db, s, { expectedVisits: -1 })).toEqual({ error: 'expected_visits' });
    // Exactly 3 days before and exactly 7 days long are allowed.
    expect(await req(db, s, { startsAt: iso(new Date(NOW.getTime() + 3 * DAY)), endsAt: iso(new Date(NOW.getTime() + 10 * DAY)) })).toHaveProperty('ok.boostId');
    expect(await req(db, s, { startsAt: iso(new Date(NOW.getTime() + 9 * DAY)), endsAt: iso(new Date(NOW.getTime() + 11 * DAY)) })).toEqual({ error: 'overlap' });
    expect(await req(db, s, { startsAt: iso(new Date(NOW.getTime() + 10 * DAY)), endsAt: iso(new Date(NOW.getTime() + 11 * DAY)) })).toHaveProperty('ok');
    const st = await setup(db, 'static');
    expect(await req(db, st)).toEqual({ error: 'not_dynamic' });
    const other = await setup(db);
    expect(await requestEventBoost(db, other.accountId, s.appId, body(), NOW)).toEqual({ error: 'not_found' });
  }));

  it('needs a plan (no grant = plan_required)', () => withTestDb(async (db) => {
    const s = await setup(db);
    await db.delete(grants);
    expect(await req(db, s)).toEqual({ error: 'plan_required' });
  }));
});

describe('event boost: effect during the period only', () => {
  async function approved(db: TestDb) {
    const s = await setup(db);
    const mailer = createFakeMailer();
    const r = await req(db, s) as { ok: { boostId: string } };
    const ap = await approveEventBoost(db, r.ok.boostId, { extraTransferBytes: 30 * 1024 ** 3, extraMemoryMb: 256 }, { reviewedBy: 'system', now: NOW, mailer, emailKey: KEY });
    expect(ap).toHaveProperty('ok.grantId');
    expect(mailer.sentTo(s.email)).toBe(1);
    return { s, boostId: r.ok.boostId };
  }

  it('raises transfer and memory and turns sleep off for that app only, then returns by itself', () => withTestDb(async (db) => {
    const { s } = await approved(db);
    const other = await db.insert(apps).values({ ownerId: s.ownerId, name: `o-${randomUUID().slice(0, 8)}`, kind: 'dynamic' }).returning();
    const at = (d: Date) => resolveEntitlements(db, s.ownerId, d, { appId: s.appId });
    const before = await at(new Date(START.getTime() - 1000));
    expect(before.dynamic.memoryMb).toBe(DYNAMIC_LIMITS.memoryMb);
    expect(before.dynamic.sleepAfterMinutes).toBe(DYNAMIC_LIMITS.sleepAfterMinutes);
    expect(before.static.monthlyTransferBytes).toBe(STATIC_LIMITS.monthlyTransferBytes);
    const during = await at(new Date(START.getTime() + DAY));
    expect(during.dynamic.memoryMb).toBe(DYNAMIC_LIMITS.memoryMb + 256);
    expect(during.dynamic.sleepAfterMinutes).toBeNull();
    expect(during.static.monthlyTransferBytes).toBe(STATIC_LIMITS.monthlyTransferBytes + 30 * 1024 ** 3);
    // Not for another app of the same owner, nor for the owner as a whole.
    const others = await resolveEntitlements(db, s.ownerId, new Date(START.getTime() + DAY), { appId: other[0]!.id });
    expect(others.dynamic.memoryMb).toBe(DYNAMIC_LIMITS.memoryMb);
    expect((await resolveEntitlements(db, s.ownerId, new Date(START.getTime() + DAY))).dynamic.sleepAfterMinutes).toBe(DYNAMIC_LIMITS.sleepAfterMinutes);
    const after = await at(new Date(END.getTime() + 1000));
    expect(after.dynamic.memoryMb).toBe(DYNAMIC_LIMITS.memoryMb);
    expect(after.dynamic.sleepAfterMinutes).toBe(DYNAMIC_LIMITS.sleepAfterMinutes);
    expect(after.static.monthlyTransferBytes).toBe(STATIC_LIMITS.monthlyTransferBytes);
    const [g] = await db.select().from(grants).where(eq(grants.kind, 'event_boost'));
    expect(g!.params).toMatchObject({ anomalyThresholdMultiplier: 2 });
  }));

  it('defaults the amounts, validates them, and a rejected request has no effect', () => withTestDb(async (db) => {
    const s = await setup(db);
    const a = await req(db, s) as { ok: { boostId: string } };
    expect(await approveEventBoost(db, a.ok.boostId, { extraMemoryMb: -1 }, { reviewedBy: 'system', now: NOW })).toEqual({ error: 'invalid_amount' });
    expect(await approveEventBoost(db, a.ok.boostId, {}, { reviewedBy: 'system', now: NOW })).toHaveProperty('ok');
    expect((await resolveEntitlements(db, s.ownerId, new Date(START.getTime() + 1000), { appId: s.appId })).dynamic.memoryMb).toBe(DYNAMIC_LIMITS.memoryMb + BOOST_DEFAULTS.extraMemoryMb);
    expect(await approveEventBoost(db, a.ok.boostId, {}, { reviewedBy: 'system', now: NOW })).toEqual({ error: 'not_requested' });
    const b = await requestEventBoost(db, s.accountId, s.appId, body({ startsAt: iso(new Date(START.getTime() + 20 * DAY)), endsAt: iso(new Date(START.getTime() + 21 * DAY)) }), NOW) as { ok: { boostId: string } };
    expect(await rejectEventBoost(db, b.ok.boostId, 'no', { reviewedBy: 'system', now: NOW })).toEqual({ ok: true });
    expect(await db.select().from(grants).where(eq(grants.kind, 'event_boost'))).toHaveLength(1);
    expect(await approveEventBoost(db, b.ok.boostId, {}, { reviewedBy: 'system', now: NOW })).toEqual({ error: 'not_requested' });
  }));

  it('does not put the app to sleep during the period; sleeps normally afterwards', () => withTestDb(async (db) => {
    const { s } = await approved(db);
    const { rt, stops } = fakeRuntime([s.appId]);
    const idleSince = new Date(START.getTime() - DAY);
    await db.update(apps).set({ lastAccessAt: idleSince }).where(eq(apps.id, s.appId));
    expect(await sleepIdleApps(db, rt.driver, new Date(START.getTime() + DAY))).toEqual([]);
    expect(stops).toEqual([]);
    expect(await sleepIdleApps(db, rt.driver, new Date(END.getTime() + 60_000))).toEqual([s.appId]);
    expect(stops).toEqual([s.appId]);
  }));

  it('recreates running containers at the start and the end (clock advanced), once each; sleeping apps are left alone', () => withTestDb(async (db) => {
    const { s } = await approved(db);
    const run = fakeRuntime([s.appId]);
    expect(await reconcileEventBoosts(db, run.rt, new Date(START.getTime() - 1000))).toBe(0);
    expect(await reconcileEventBoosts(db, run.rt, new Date(START.getTime() + 60_000))).toBe(1);
    expect(run.starts).toEqual([{ appId: s.appId, memoryMb: DYNAMIC_LIMITS.memoryMb + 256 }]);
    expect(await reconcileEventBoosts(db, run.rt, new Date(START.getTime() + DAY))).toBe(0); // 2 回目はしない
    expect(await reconcileEventBoosts(db, run.rt, new Date(END.getTime() + 60_000))).toBe(1);
    expect(run.starts.at(-1)).toEqual({ appId: s.appId, memoryMb: DYNAMIC_LIMITS.memoryMb });
    expect(await reconcileEventBoosts(db, run.rt, new Date(END.getTime() + DAY))).toBe(0);
    const [b] = await db.select().from(eventBoosts);
    expect(b!.appliedAt).not.toBeNull();
    expect(b!.restoredAt).not.toBeNull();
    // A sleeping app: nothing is started, but the marks are still set (the next wake uses the current limits).
    const { s: s2 } = await approved(db);
    const idle = fakeRuntime([]);
    expect(await reconcileEventBoosts(db, idle.rt, new Date(END.getTime() + 60_000))).toBe(0);
    expect(idle.starts).toEqual([]);
    const marks = await db.select().from(eventBoosts).where(eq(eventBoosts.appId, s2.appId));
    expect(marks[0]!.restoredAt).not.toBeNull();
  }));

  it('counts runtime hours into the month and the fiscal year during the boost', () => withTestDb(async (db) => {
    clearRuntimeBlockCache();
    const { s } = await approved(db);
    const t = new Date(START.getTime() + DAY);
    const driver = { runningCount: async () => [{ appId: s.appId, containers: 1 }], stop: async () => undefined };
    expect(await meterRuntime({ db, driver, now: () => t })).toBe(1);
    const u = await getRuntimeUsage(db, s.accountId, s.appId, t);
    expect(u!.month.minutes).toBe(1);
    expect(u!.fiscalYear.minutes).toBe(1);
  }));

  it('raises the monthly transfer limit during the boost and returns afterwards', () => withTestDb(async (db) => {
    const { s } = await approved(db);
    const month = (d: Date) => d.toISOString().slice(0, 7);
    const used = STATIC_LIMITS.monthlyTransferBytes + 5 * 1024 ** 3; // 通常の上限を超えているがブースト中の上限は超えていない
    let clock = new Date(START.getTime() + DAY);
    const meter = createTransferMeter({ db, now: () => clock, limitCacheMs: 0 });
    await db.insert(transferUsage).values({ appId: s.appId, month: month(clock), bytes: used });
    expect(await meter.isBlocked(s.appId)).toBe(false);
    clock = new Date(END.getTime() + 1000); // 期間の後（同じ月のまま）
    expect(month(clock)).toBe(month(new Date(START.getTime() + DAY)));
    expect(await meter.isBlocked(s.appId)).toBe(true);
  }));
});
