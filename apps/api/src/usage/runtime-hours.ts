import { and, eq, inArray, sql } from 'drizzle-orm';
import { t } from 'i18n';
import { DYNAMIC_LIMITS } from 'shared';
import type { RuntimeDriver } from 'platform';
import { withAccount, withSystem, type Db, type Tx } from '../db/client.js';
import { apps, runtimeMinutes, runtimeUsage } from '../db/schema.js';
import { UUID } from '../auth/cross-device.js';
import { resolveEntitlements } from '../grants/entitlements.js';
import { isStoppedState } from 'shared';
import { readUsageState } from './state.js';
import type { Mailer } from '../mail/mailer.js';
import { ownerContact } from './owner-contact.js';

/* Periods are Asia/Tokyo (UTC+9, no DST): months start on the 1st 00:00 JST, fiscal years on April 1st 00:00 JST. */
const JST_MS = 9 * 3600_000;
const jst = (d: Date): Date => new Date(d.getTime() + JST_MS);
const fromJst = (y: number, month0: number): Date => new Date(Date.UTC(y, month0, 1) - JST_MS);

/** 'YYYY-MM' of the JST calendar month. */
export function jstMonthKey(d: Date): string {
  return jst(d).toISOString().slice(0, 7);
}
function fiscalStartYear(d: Date): number {
  const j = jst(d);
  return j.getUTCMonth() >= 3 ? j.getUTCFullYear() : j.getUTCFullYear() - 1;
}
/** 'FY<start year>' of the fiscal year (April 1st 00:00 JST to March 31st 24:00 JST). */
export function fiscalYearKey(d: Date): string {
  return `FY${fiscalStartYear(d)}`;
}
export function nextMonthStart(d: Date): Date {
  const j = jst(d);
  return fromJst(j.getUTCFullYear(), j.getUTCMonth() + 1);
}
export function nextFiscalYearStart(d: Date): Date {
  return fromJst(fiscalStartYear(d) + 1, 3);
}
export const truncateToMinute = (d: Date): Date => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

export const MONTHLY_LIMIT_MINUTES = DYNAMIC_LIMITS.monthlyHours * 60;
export const FISCAL_LIMIT_MINUTES = DYNAMIC_LIMITS.fiscalYearHours * 60;
export const BLOCK_CACHE_MS = 30_000;
const WARN_RATIO = 0.8;

export type PeriodKind = 'month' | 'fiscalYear';
interface Period { kind: PeriodKind; key: string; limit: number; end: Date }
/** The period keys/ends of `at`; the limits (in minutes) come from the owner's plan (`resolveEntitlements`), the Student defaults otherwise. */
function periodsAt(at: Date, limits: { monthly: number; fiscal: number } = { monthly: MONTHLY_LIMIT_MINUTES, fiscal: FISCAL_LIMIT_MINUTES }): Period[] {
  return [
    { kind: 'month', key: jstMonthKey(at), limit: limits.monthly, end: nextMonthStart(at) },
    { kind: 'fiscalYear', key: fiscalYearKey(at), limit: limits.fiscal, end: nextFiscalYearStart(at) },
  ];
}
const planLimits = (e: { dynamic: { monthlyHours: number; fiscalYearHours: number } }) => ({ monthly: e.dynamic.monthlyHours * 60, fiscal: e.dynamic.fiscalYearHours * 60 });

/**
 * 稼働時間の上限と、利用の状態（Task 7）による停止。付与が切れた「猶予」の間は、動かしたまま前のプラン（Student）の上限で数える。
 * 停止・ブロック・凍結の間は `blocked`（上限の残りに関係なく動かさない）。
 */
async function runtimePlan(db: Db | Tx, ownerId: string, at: Date): Promise<{ limits: { monthly: number; fiscal: number }; blocked: boolean }> {
  const e = await resolveEntitlements(db, ownerId, at);
  const state = await readUsageState(db, ownerId);
  return { limits: planLimits(e.plan === 'none' && state === 'grace' ? { dynamic: DYNAMIC_LIMITS } : e), blocked: isStoppedState(state) };
}

export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}

/**
 * Until when the owner is blocked (the end of the exhausted period; the later one when both are), or null.
 * Computed from the counters of the *current* periods, so it lifts by itself when a period rolls over.
 */
export async function runtimeBlockedUntil(db: Db, ownerId: string, at: Date = new Date()): Promise<Date | null> {
  if (!UUID.test(ownerId)) return null;
  // No grant = the "none" plan = 0 hours: the owner is blocked until the end of the period.
  const plan = await runtimePlan(db, ownerId, at);
  // 停止・ブロック・凍結: 再登録・解除まで（少なくとも今年度いっぱいは）動かさない。
  if (plan.blocked) return nextFiscalYearStart(at);
  const periods = periodsAt(at, plan.limits);
  const rows = await withSystem(db, (tx) => tx.select({ period: runtimeUsage.period, minutes: runtimeUsage.minutes })
    .from(runtimeUsage).where(and(eq(runtimeUsage.ownerId, ownerId), inArray(runtimeUsage.period, periods.map((p) => p.key)))));
  let until: Date | null = null;
  for (const p of periods) {
    const m = rows.find((r) => r.period === p.key)?.minutes ?? 0;
    if (m >= p.limit && (!until || p.end > until)) until = p.end;
  }
  return until;
}

const blockCache = new Map<string, { until: Date | null; periods: string; at: number }>();

/** True while the owner has used up this month's or this fiscal year's runtime hours. Cached 30s (for the edge). */
export async function isRuntimeBlocked(db: Db, ownerId: string, now: Date = new Date(), cacheMs = BLOCK_CACHE_MS): Promise<boolean> {
  const periods = periodsAt(now).map((p) => p.key).join('|');
  const hit = blockCache.get(ownerId);
  if (hit && hit.periods === periods && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < cacheMs) return hit.until !== null;
  const until = await runtimeBlockedUntil(db, ownerId, now);
  blockCache.set(ownerId, { until, periods, at: now.getTime() });
  return until !== null;
}
/** Test helper. */
export function clearRuntimeBlockCache(): void {
  blockCache.clear();
}

export interface MeterRuntimeOptions {
  db: Db;
  driver: Pick<RuntimeDriver, 'runningCount' | 'stop'>;
  /** Without a mailer (or key) the 80% flag is still set but no mail is sent. */
  mailer?: Mailer;
  emailKey?: Buffer;
  now?: () => Date;
}

interface Outcome { ownerId: string; period: Period; minutes: number; warn: boolean; stateBlocked: boolean }

/**
 * Records one tick: for every running app inserts (app, current minute, containers) once, and only when that
 * insert happened adds the containers to the owner's month and fiscal-year counters (same transaction), so
 * repeated ticks or several workers never count a minute twice. Owners at a limit have all their dynamic apps stopped.
 * Returns the number of app-minutes newly recorded.
 */
export async function meterRuntime(opts: MeterRuntimeOptions): Promise<number> {
  const { db, driver } = opts;
  const at = (opts.now ?? (() => new Date()))();
  const minute = truncateToMinute(at);
  const running = await driver.runningCount();
  let recorded = 0;
  const exhausted = new Set<string>();

  for (const { appId, containers } of running) {
    if (!UUID.test(appId) || !(containers > 0)) continue;
    let outcomes: Outcome[];
    try {
      outcomes = await withSystem(db, async (tx) => {
        const ins = await tx.insert(runtimeMinutes).values({ appId, minute, containers }).onConflictDoNothing().returning({ appId: runtimeMinutes.appId });
        if (ins.length === 0) return [];
        const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
        if (!a) return [];
        const out: Outcome[] = [];
        const plan = await runtimePlan(tx, a.ownerId, minute);
        const periods = periodsAt(minute, plan.limits);
        for (const p of periods) {
          const [row] = await tx.insert(runtimeUsage).values({ ownerId: a.ownerId, period: p.key, minutes: containers })
            .onConflictDoUpdate({ target: [runtimeUsage.ownerId, runtimeUsage.period], set: { minutes: sql`${runtimeUsage.minutes} + excluded.minutes` } })
            .returning({ minutes: runtimeUsage.minutes });
          let warn = false;
          if (row && row.minutes >= p.limit * WARN_RATIO) {
            // Atomic "first one wins": only the caller that flips the flag sends the mail.
            const flipped = await tx.update(runtimeUsage).set({ notified80: true })
              .where(and(eq(runtimeUsage.ownerId, a.ownerId), eq(runtimeUsage.period, p.key), eq(runtimeUsage.notified80, false)))
              .returning({ ownerId: runtimeUsage.ownerId });
            warn = flipped.length > 0;
          }
          out.push({ ownerId: a.ownerId, period: p, minutes: row?.minutes ?? 0, warn, stateBlocked: plan.blocked });
        }
        return out;
      });
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23503') continue; // app deleted meanwhile
      console.error('runtime metering failed', appId, e);
      continue;
    }
    if (outcomes.length > 0) recorded++;
    for (const o of outcomes) {
      if (o.warn) notifyOwner(opts, o.ownerId, o.period, o.minutes);
      if (o.minutes >= o.period.limit || o.stateBlocked) exhausted.add(o.ownerId);
    }
  }

  for (const ownerId of exhausted) await stopOwnerApps(db, driver, ownerId);
  return recorded;
}

async function stopOwnerApps(db: Db, driver: Pick<RuntimeDriver, 'stop'>, ownerId: string): Promise<void> {
  const list = await withSystem(db, (tx) => tx.select({ id: apps.id }).from(apps).where(and(eq(apps.ownerId, ownerId), eq(apps.kind, 'dynamic'))));
  for (const { id } of list) {
    try { await driver.stop(id); } catch (e) { console.error('runtime limit: stop failed', id, e); }
  }
  blockCache.delete(ownerId);
}

function notifyOwner(opts: MeterRuntimeOptions, ownerId: string, p: Period, used: number): void {
  const { mailer, emailKey, db } = opts;
  if (!mailer || !emailKey) return;
  void Promise.resolve().then(async () => {
    const target = await ownerContact(db, ownerId, emailKey);
    if (!target) return;
    const { locale } = target;
    const params = { period: p.key, limit: formatHours(p.limit), used: formatHours(used) };
    await mailer.sendMail(target.email, t(locale, 'runtime.warnSubject', params), t(locale, 'runtime.warnBody', params));
  }).catch((err: unknown) => console.error('runtime 80% mail failed', ownerId, err));
}

/** Starts the once-a-minute metering loop (idempotent per minute, safe with several workers). */
export function startRuntimeMetering(opts: MeterRuntimeOptions, intervalMs = 60_000): () => void {
  let running = false; // a slow tick must not overlap the next one
  const tick = () => {
    if (running) return;
    running = true;
    void meterRuntime(opts).catch((e) => console.error('runtime metering tick failed', e)).finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface RuntimePeriodUsage { period: string; minutes: number; limitMinutes: number }
export interface RuntimeUsage { month: RuntimePeriodUsage; fiscalYear: RuntimePeriodUsage }

/** Runtime minutes of the app's owner for this JST month and fiscal year (RLS applies); null when the app is not visible. */
export async function getRuntimeUsage(db: Db, accountId: string, appId: string, at: Date = new Date()): Promise<RuntimeUsage | null> {
  if (!UUID.test(appId)) return null;
  const seen = await withAccount(db, accountId, async (tx) => (await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId)))[0] ?? null);
  if (!seen) return null;
  const [m, fy] = periodsAt(at, (await runtimePlan(db, seen.ownerId, at)).limits) as [Period, Period];
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return null;
    const rows = await tx.select({ period: runtimeUsage.period, minutes: runtimeUsage.minutes }).from(runtimeUsage)
      .where(and(eq(runtimeUsage.ownerId, a.ownerId), inArray(runtimeUsage.period, [m.key, fy.key])));
    const of = (p: Period): RuntimePeriodUsage => ({ period: p.key, minutes: rows.find((r) => r.period === p.key)?.minutes ?? 0, limitMinutes: p.limit });
    return { month: of(m), fiscalYear: of(fy) };
  });
}

export const RUNTIME_MINUTES_RETENTION_DAYS = 400;
/** Deletes raw per-minute records older than the retention (the owner counters are kept). Returns the number of rows. */
export async function purgeRuntimeMinutes(db: Db, now: Date = new Date(), days = RUNTIME_MINUTES_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const rows = await withSystem(db, (tx) => tx.delete(runtimeMinutes).where(sql`${runtimeMinutes.minute} < ${cutoff.toISOString()}::timestamptz`).returning({ appId: runtimeMinutes.appId }));
  return rows.length;
}
