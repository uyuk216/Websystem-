import { and, eq, inArray, sql } from 'drizzle-orm';
import type { RuntimeDriver } from 'platform';
import { DYNAMIC_LIMITS } from 'shared';
import { createDb, withSystem, type Db } from '../db/client.js';
import { apps, deployments } from '../db/schema.js';
import { resolveEntitlements } from '../grants/entitlements.js';

export type LiveApp =
  | { kind: 'static'; appId: string; siteKey: string }
  | { kind: 'dynamic'; appId: string; deploymentId: string; ownerId: string };

/** Read-only lookup for the edge: what the app name currently serves (static site or dynamic deployment). */
export async function findLiveApp(db: Db, name: string): Promise<LiveApp | null> {
  const [r] = await withSystem(db, (tx) =>
    tx.select({ appId: apps.id, ownerId: apps.ownerId, kind: apps.kind, deploymentId: deployments.id, siteKey: deployments.siteKey, imageRef: deployments.imageRef }).from(apps)
      .innerJoin(deployments, and(eq(deployments.id, apps.activeDeploymentId), eq(deployments.appId, apps.id)))
      .where(eq(apps.name, name)));
  if (!r) return null;
  if (r.kind === 'dynamic') return r.imageRef ? { kind: 'dynamic', appId: r.appId, deploymentId: r.deploymentId, ownerId: r.ownerId } : null;
  return r.siteKey ? { kind: 'static', appId: r.appId, siteKey: r.siteKey } : null;
}

export async function touchLastAccess(db: Db, appId: string): Promise<void> {
  await withSystem(db, (tx) => tx.update(apps).set({ lastAccessAt: sql`now()` }).where(eq(apps.id, appId)));
}

/**
 * Runs `fn` while holding a database-wide lock for the app, so that only one process wakes (or puts to sleep)
 * an app at a time. The lock is released when the transaction ends.
 */
export async function withWakeLock<T>(db: Db, appId: string, fn: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  return withSystem(db, async (tx) => {
    // Waiting for the lock is bounded: a holder that takes too long must not pin this connection forever.
    if (opts.timeoutMs !== undefined) await tx.execute(sql`SELECT set_config('lock_timeout', ${`${Math.max(1, Math.floor(opts.timeoutMs))}ms`}, true)`);
    try {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake:${appId}`}, 0))`);
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '55P03') throw new Error('wake_lock_timeout', { cause: e });
      throw e;
    }
    return fn();
  });
}

/**
 * Wake locks on their own small connection pool. The lock transaction is held while an app starts (up to 30s),
 * so it must never share a pool with the queries made inside it (lookups, run spec, switch): `fn` must not use
 * the main pool's connections for anything that the lock holder waits on, and the main pool must not be able
 * to run dry because wakes are in progress.
 */
export type WakeLock = <T>(appId: string, fn: () => Promise<T>, opts?: { timeoutMs?: number }) => Promise<T>;
export function createWakeLocker(url: string, max = 8): { lock: WakeLock; close: () => Promise<void> } {
  const { db, sql } = createDb(url, { max });
  return { lock: (appId, fn, opts) => withWakeLock(db, appId, fn, opts), close: () => sql.end() };
}

/**
 * Stops dynamic apps that have not been accessed for `sleepAfterMinutes`. Per app, takes the wake lock (also held by rollouts) without
 * waiting (an app being woken is skipped) and re-checks the idle time under it. Returns the stopped app ids.
 */
export async function sleepIdleApps(db: Db, driver: RuntimeDriver, now: Date = new Date(), idleMinutes: number = DYNAMIC_LIMITS.sleepAfterMinutes): Promise<string[]> {
  const running = (await driver.runningCount()).map((r) => r.appId);
  if (running.length === 0) return [];
  const cutoff = new Date(now.getTime() - idleMinutes * 60_000);
  const idle = (cond: ReturnType<typeof sql>) => sql`${apps.kind} = 'dynamic' AND ${cond}`;
  const candidates = await withSystem(db, (tx) => tx.select({ id: apps.id, active: apps.activeDeploymentId, ownerId: apps.ownerId }).from(apps)
    .where(and(inArray(apps.id, running), idle(sql`(${apps.lastAccessAt} IS NULL OR ${apps.lastAccessAt} < ${cutoff.toISOString()}::timestamptz)`))));
  const stopped: string[] = [];
  for (const { id, active, ownerId } of candidates) {
    try {
      // イベントブースト中のアプリはスリープしない（期間が終われば次の巡回から通常に戻る）。
      if ((await resolveEntitlements(db, ownerId, now, { appId: id })).dynamic.sleepAfterMinutes === null) continue;
      const did = await withSystem(db, async (tx) => {
        const [lock] = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`wake:${id}`}, 0)) AS ok`);
        if (!lock?.ok) return false;
        const [row] = await tx.select({ id: apps.id }).from(apps)
          .where(and(eq(apps.id, id), idle(sql`(${apps.lastAccessAt} IS NULL OR ${apps.lastAccessAt} < ${cutoff.toISOString()}::timestamptz)`)));
        if (!row) return false;
        // Only the active deployment's container: one that a rollout is bringing up must not be touched.
        if (active) await driver.stopDeployment(id, active);
        return true;
      });
      if (did) stopped.push(id);
    } catch (e) {
      console.error('sleep: stop failed', id, e);
    }
  }
  return stopped;
}
