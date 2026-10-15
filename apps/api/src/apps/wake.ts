import { and, eq, inArray, sql } from 'drizzle-orm';
import type { RuntimeDriver } from 'platform';
import { DYNAMIC_LIMITS } from 'shared';
import { withSystem, type Db } from '../db/client.js';
import { apps, deployments } from '../db/schema.js';

export type LiveApp =
  | { kind: 'static'; appId: string; siteKey: string }
  | { kind: 'dynamic'; appId: string; deploymentId: string };

/** Read-only lookup for the edge: what the app name currently serves (static site or dynamic deployment). */
export async function findLiveApp(db: Db, name: string): Promise<LiveApp | null> {
  const [r] = await withSystem(db, (tx) =>
    tx.select({ appId: apps.id, kind: apps.kind, deploymentId: deployments.id, siteKey: deployments.siteKey, imageRef: deployments.imageRef }).from(apps)
      .innerJoin(deployments, and(eq(deployments.id, apps.activeDeploymentId), eq(deployments.appId, apps.id)))
      .where(eq(apps.name, name)));
  if (!r) return null;
  if (r.kind === 'dynamic') return r.imageRef ? { kind: 'dynamic', appId: r.appId, deploymentId: r.deploymentId } : null;
  return r.siteKey ? { kind: 'static', appId: r.appId, siteKey: r.siteKey } : null;
}

export async function touchLastAccess(db: Db, appId: string): Promise<void> {
  await withSystem(db, (tx) => tx.update(apps).set({ lastAccessAt: sql`now()` }).where(eq(apps.id, appId)));
}

/**
 * Runs `fn` while holding a database-wide lock for the app, so that only one process wakes (or puts to sleep)
 * an app at a time. The lock is released when the transaction ends.
 */
export async function withWakeLock<T>(db: Db, appId: string, fn: () => Promise<T>): Promise<T> {
  return withSystem(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wake:${appId}`}, 0))`);
    return fn();
  });
}

/**
 * Stops dynamic apps that have not been accessed for `sleepAfterMinutes`. Per app, takes the wake lock without
 * waiting (an app being woken is skipped) and re-checks the idle time under it. Returns the stopped app ids.
 */
export async function sleepIdleApps(db: Db, driver: RuntimeDriver, now: Date = new Date(), idleMinutes: number = DYNAMIC_LIMITS.sleepAfterMinutes): Promise<string[]> {
  const running = (await driver.runningCount()).map((r) => r.appId);
  if (running.length === 0) return [];
  const cutoff = new Date(now.getTime() - idleMinutes * 60_000);
  const idle = (cond: ReturnType<typeof sql>) => sql`${apps.kind} = 'dynamic' AND ${cond}`;
  const candidates = await withSystem(db, (tx) => tx.select({ id: apps.id }).from(apps)
    .where(and(inArray(apps.id, running), idle(sql`(${apps.lastAccessAt} IS NULL OR ${apps.lastAccessAt} < ${cutoff.toISOString()}::timestamptz)`))));
  const stopped: string[] = [];
  for (const { id } of candidates) {
    try {
      const did = await withSystem(db, async (tx) => {
        const [lock] = await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`wake:${id}`}, 0)) AS ok`);
        if (!lock?.ok) return false;
        const [row] = await tx.select({ id: apps.id }).from(apps)
          .where(and(eq(apps.id, id), idle(sql`(${apps.lastAccessAt} IS NULL OR ${apps.lastAccessAt} < ${cutoff.toISOString()}::timestamptz)`)));
        if (!row) return false;
        await driver.stop(id);
        return true;
      });
      if (did) stopped.push(id);
    } catch (e) {
      console.error('sleep: stop failed', id, e);
    }
  }
  return stopped;
}
