import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { BUCKETS, JOBS, appPrefix, collectLogs, waitHealthy, type ArchiveFormat, type Storage } from 'platform';
import { STATIC_LIMITS } from 'shared';
import { runLimitsFor } from './run-limits.js';
import { UUID } from '../auth/cross-device.js';
import { withAccount, withSystem, type Db, type Tx } from '../db/client.js';
import { apps, deployments } from '../db/schema.js';
import { mayManage } from './apps.js';
import { isAppBlocked } from '../security/gate.js';
import { runtimeBlockedUntil } from '../usage/runtime-hours.js';
import { getRunInputs } from './databases.js';
import { CONTAINER_PORT, type DynamicRuntime } from '../ingest/dynamic.js';

/** The slice of pg-boss that deployment code needs (tests pass a fake). */
export interface JobQueue {
  send(name: string, data: object): Promise<unknown>;
}
export type DeploySource = 'upload' | 'cli' | 'github';
export type CreateDeploymentError = 'not_found' | 'forbidden' | 'too_large' | 'invalid';
export type RollbackError = 'not_found' | 'forbidden' | 'invalid_state' | 'start_failed' | 'runtime_limit' | 'security_blocked';

export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Errors the upload stream raises when the archive exceeds the size limit. */
class TooLarge extends Error {}

function capBytes(maxBytes: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > maxBytes) cb(new TooLarge('too_large'));
      else cb(null, chunk);
    },
  });
}

async function storeAndQueue(
  db: Db, storage: Storage, queue: JobQueue, appId: string,
  input: { source: DeploySource; archive: Readable; format: ArchiveFormat; commitSha?: string; maxBytes?: number },
  createdBy: string | null,
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  allowed: (tx: Tx, ownerId: string) => Promise<boolean>,
): Promise<{ deploymentId: string } | { error: CreateDeploymentError }> {
  const deploymentId = randomUUID();
  const sourceKey = `${appPrefix(BUCKETS.sources, appId)}${deploymentId}.${input.format}`;
  const capped = capBytes(input.maxBytes ?? STATIC_LIMITS.storageBytes);
  input.archive.on('error', (e) => capped.destroy(e));
  input.archive.pipe(capped);
  try {
    await storage.sources.put(sourceKey, capped, 'application/octet-stream');
  } catch (e) {
    input.archive.destroy();
    await storage.sources.delete(sourceKey).catch(() => undefined);
    if (e instanceof TooLarge) return { error: 'too_large' };
    throw e;
  }
  try {
    const ok = await run(async (tx) => {
      // The app may have been deleted or permissions changed while the upload streamed.
      const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId)).for('share');
      if (!a || !(await allowed(tx, a.ownerId))) return false;
      await tx.insert(deployments).values({
        id: deploymentId, appId, source: input.source, sourceKey, createdBy, commitSha: input.commitSha ?? null,
      });
      return true;
    });
    if (!ok) throw new Error('app_gone');
    await queue.send(JOBS.processDeployment, { deploymentId });
  } catch (e) {
    await storage.sources.delete(sourceKey).catch(() => undefined);
    if (e instanceof Error && e.message === 'app_gone') return { error: 'not_found' };
    throw e;
  }
  return { deploymentId };
}

/**
 * Stores the uploaded archive at sources/<appId>/<deploymentId>.<ext>, records a `queued` deployment and
 * enqueues processing. The caller needs the `deploy` permission for the app's owner.
 */
export async function createDeployment(
  db: Db, storage: Storage, queue: JobQueue, accountId: string, appId: string,
  input: { source: DeploySource; archive: Readable; format: ArchiveFormat; commitSha?: string; maxBytes?: number },
): Promise<{ deploymentId: string } | { error: CreateDeploymentError }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  const access = await withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return 'not_found' as const;
    return (await mayManage(tx, accountId, a.ownerId)) ? ('ok' as const) : ('forbidden' as const);
  });
  if (access !== 'ok') return { error: access };

  return storeAndQueue(db, storage, queue, appId, input, accountId, (fn) => withAccount(db, accountId, fn), (tx, ownerId) => mayManage(tx, accountId, ownerId));
}

/**
 * Deployment for system callers (GitHub webhook; no account, `created_by` null). The `queued` row is created
 * first so a failing download is visible to the owner: it is then marked `failed` with an i18n message key.
 * The job is enqueued only after the archive is stored.
 */
export async function createSystemDeployment(
  db: Db, storage: Storage, queue: JobQueue, appId: string,
  input: { source: DeploySource; format: ArchiveFormat; commitSha: string; fetchArchive: () => Promise<Readable> },
): Promise<{ deploymentId: string } | { error: 'not_found' | 'failed' | 'duplicate' }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  const deploymentId = randomUUID();
  const sourceKey = `${appPrefix(BUCKETS.sources, appId)}${deploymentId}.${input.format}`;
  const inserted = await withSystem(db, async (tx) => {
    const [a] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).for('share');
    if (!a) return false;
    // The partial unique index (app, commit) over active statuses makes the dedupe atomic.
    const rows = await tx.insert(deployments).values({ id: deploymentId, appId, source: input.source, sourceKey, createdBy: null, commitSha: input.commitSha })
      .onConflictDoNothing({
        target: [deployments.appId, deployments.commitSha],
        where: sql`${deployments.commitSha} is not null and ${deployments.status} in ('queued', 'processing', 'live')`,
      }).returning({ id: deployments.id });
    return rows.length > 0 ? true : 'duplicate' as const;
  });
  if (inserted === 'duplicate') return { error: 'duplicate' };
  if (!inserted) return { error: 'not_found' };
  const fail = async (message: string) => {
    await storage.sources.delete(sourceKey).catch(() => undefined);
    await withSystem(db, async (tx) => {
      await tx.update(deployments).set({ status: 'failed', message, finishedAt: new Date() }).where(eq(deployments.id, deploymentId));
    });
  };
  let archive: Readable | undefined;
  try {
    // Whole download + store is bounded, even if the client's own timeout does not cover the body stream.
    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    archive = await input.fetchArchive();
    const capped = capBytes(STATIC_LIMITS.storageBytes);
    const abort = () => { const err = new Error('download_timeout'); archive?.destroy(err); capped.destroy(err); };
    signal.addEventListener('abort', abort, { once: true });
    archive.on('error', (e) => capped.destroy(e));
    archive.pipe(capped);
    await storage.sources.put(sourceKey, capped, 'application/octet-stream');
  } catch (e) {
    archive?.destroy();
    await fail(e instanceof TooLarge ? 'deploy.error.too_large' : 'deploy.error.download_failed');
    return { error: 'failed' };
  }
  try {
    await queue.send(JOBS.processDeployment, { deploymentId });
  } catch (e) {
    await fail('deploy.error.internal');
    throw e;
  }
  return { deploymentId };
}

export async function listDeployments(db: Db, accountId: string, appId: string) {
  if (!UUID.test(appId)) return [];
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    const manage = !!a && await mayManage(tx, accountId, a.ownerId);
    const rows = await tx.select({
    id: deployments.id, status: deployments.status, source: deployments.source, message: deployments.message,
    findings: deployments.findings, totalBytes: deployments.totalBytes, fileCount: deployments.fileCount,
    commitSha: deployments.commitSha, createdAt: deployments.createdAt, finishedAt: deployments.finishedAt,
    }).from(deployments).where(eq(deployments.appId, appId)).orderBy(desc(deployments.createdAt), desc(deployments.id));
    // Runtime logs may contain app output: only people who can deploy see them (secret-scan findings stay visible).
    return rows.map((r) => (!manage && r.findings && !Array.isArray(r.findings) ? { ...r, findings: null } : r));
  });
}

/**
 * Makes a past `live`/`superseded` deployment the live one again. For a dynamic app the target's image is
 * started again and health-checked first; the current version keeps serving until the switch, and a target
 * that does not come up leaves everything as it was (`start_failed`).
 */
export async function rollback(
  db: Db, accountId: string, appId: string, deploymentId: string, rt?: DynamicRuntime,
): Promise<{ ok: true } | { error: RollbackError; reason?: string; logs?: string[] }> {
  if (!UUID.test(appId) || !UUID.test(deploymentId)) return { error: 'not_found' };
  const pre = await withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId, kind: apps.kind }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    const [d] = await tx.select({ status: deployments.status, siteKey: deployments.siteKey, imageRef: deployments.imageRef })
      .from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)));
    if (!d) return { error: 'not_found' as const };
    if (!['live', 'superseded'].includes(d.status) || !(a.kind === 'dynamic' ? d.imageRef : d.siteKey)) return { error: 'invalid_state' as const };
    return { ownerId: a.ownerId, kind: a.kind, imageRef: d.imageRef, wasLive: d.status === 'live' };
  });
  if (pre.error) return { error: pre.error };

  let started = false;
  if (pre.kind === 'dynamic') {
    if (!rt || !pre.imageRef) return { error: 'invalid_state' };
    if (await runtimeBlockedUntil(db, pre.ownerId)) return { error: 'runtime_limit' };
    const imageRef = pre.imageRef;
    // Under the app's wake lock (like a rollout), so the sleeper and the edge never race the start.
    const startTarget = async (): Promise<{ error: RollbackError; reason?: string; logs?: string[] } | null> => {
      try {
        // 遮断中のアプリは、ロールバックでも起動しない（ロックの中、起動の直前に確かめる）。
        if (await isAppBlocked(db, appId)) return { error: 'security_blocked', reason: 'deploy.error.security_blocked' };
        const { env, networks, secrets } = await getRunInputs(db, rt, appId);
        await rt.driver.start({
          appId, deploymentId, ownerId: pre.ownerId, image: imageRef, env: { ...env, PORT: String(CONTAINER_PORT) },
          limits: await runLimitsFor(db, pre.ownerId, appId), port: CONTAINER_PORT, networks,
        });
        started = true;
        const health = await waitHealthy(rt.driver, appId, deploymentId, rt.health);
        if (!health.ok) {
          const logs = await collectLogs(rt.driver, appId, deploymentId, secrets);
          if (!pre.wasLive) await rt.driver.stopDeployment(appId, deploymentId);
          return { error: 'start_failed', reason: health.reason === 'exited' ? 'deploy.error.app_exited' : 'deploy.error.health_check_failed', logs };
        }
        return null;
      } catch (e) {
        if (started && !pre.wasLive) await rt.driver.stopDeployment(appId, deploymentId).catch(() => undefined);
        console.error('rollback start failed', appId, deploymentId, e);
        return { error: 'start_failed' };
      }
    };
    const failed = await (rt.lock ? rt.lock(appId, startTarget) : startTarget());
    if (failed) return failed;
  }

  // 公開の切り替えの直前にもう一度。起動の後に遮断された場合、起動した分は止めて切り替えない。
  if (await isAppBlocked(db, appId)) {
    if (started && !pre.wasLive && rt) await rt.driver.stopDeployment(appId, deploymentId).catch(() => undefined);
    return { error: 'security_blocked', reason: 'deploy.error.security_blocked' };
  }
  const switched = await withSystem(db, async (systemTx) => {
    await systemTx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).for('update');
    if (await isAppBlocked(systemTx, appId)) return { error: 'security_blocked' as const, reason: 'deploy.error.security_blocked' };
    return withAccount(systemTx, accountId, async (tx) => {
    // Same lock as the worker's switch, so a rollback and a finishing deployment serialise.
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId)).for('update');
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    const [d] = await tx.select().from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)));
    if (!d) return { error: 'not_found' as const };
    if (!['live', 'superseded'].includes(d.status) || !(pre.kind === 'dynamic' ? d.imageRef : d.siteKey)) return { error: 'invalid_state' as const };
    const old = await tx.update(deployments).set({ status: 'superseded' })
      .where(and(eq(deployments.appId, appId), eq(deployments.status, 'live'), ne(deployments.id, d.id))).returning({ id: deployments.id });
    // A queued/processing deployment of the same commit would violate the active-commit unique index; its
    // job then no-ops (processDeployment only claims queued/processing rows, and re-checks before switching).
    if (d.commitSha) {
      await tx.update(deployments).set({ status: 'superseded' }).where(and(
        eq(deployments.appId, appId), eq(deployments.commitSha, d.commitSha), ne(deployments.id, d.id), inArray(deployments.status, ['queued', 'processing']),
      ));
    }
    await tx.update(deployments).set({ status: 'live' }).where(eq(deployments.id, d.id));
    await tx.update(apps).set({ activeDeploymentId: d.id, rolledBackAt: sql`now()`, lastAccessAt: sql`now()` }).where(eq(apps.id, appId));
    return { ok: true as const, stop: old.map((r) => r.id) };
    });
  });
  if ('error' in switched) {
    if (started && !pre.wasLive && rt) await rt.driver.stopDeployment(appId, deploymentId).catch(() => undefined);
    return switched;
  }
  if (rt) for (const id of switched.stop) await rt.driver.stopDeployment(appId, id).catch((e: unknown) => console.error('stop old deployment failed', appId, id, e));
  return { ok: true };
}

/** Restarts the active deployment of a dynamic app (to apply changed env vars), under the app's wake lock with a health check. */
export async function restart(
  db: Db, accountId: string, appId: string, rt?: DynamicRuntime,
): Promise<{ ok: true } | { error: RollbackError; reason?: string; logs?: string[] }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  const pre = await withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId, kind: apps.kind, active: apps.activeDeploymentId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    if (a.kind !== 'dynamic' || !a.active) return { error: 'invalid_state' as const };
    const [d] = await tx.select({ imageRef: deployments.imageRef }).from(deployments).where(eq(deployments.id, a.active));
    if (!d?.imageRef) return { error: 'invalid_state' as const };
    return { ownerId: a.ownerId, deploymentId: a.active, imageRef: d.imageRef };
  });
  if ('error' in pre) return { error: pre.error as RollbackError };
  if (!rt) return { error: 'invalid_state' };
  if (await runtimeBlockedUntil(db, pre.ownerId)) return { error: 'runtime_limit' };
  const run = async (): Promise<{ error: RollbackError; reason?: string; logs?: string[] } | null> => {
    try {
      if (await isAppBlocked(db, appId)) return { error: 'security_blocked', reason: 'deploy.error.security_blocked' };
      const { env, networks, secrets } = await getRunInputs(db, rt, appId);
      await rt.driver.stopDeployment(appId, pre.deploymentId);
      await rt.driver.start({
        appId, deploymentId: pre.deploymentId, ownerId: pre.ownerId, image: pre.imageRef, env: { ...env, PORT: String(CONTAINER_PORT) },
        limits: await runLimitsFor(db, pre.ownerId, appId), port: CONTAINER_PORT, networks,
      });
      if (await isAppBlocked(db, appId)) {
        await rt.driver.stopDeployment(appId, pre.deploymentId);
        return { error: 'security_blocked', reason: 'deploy.error.security_blocked' };
      }
      const health = await waitHealthy(rt.driver, appId, pre.deploymentId, rt.health);
      if (!health.ok) {
        const logs = await collectLogs(rt.driver, appId, pre.deploymentId, secrets);
        // Leave the app asleep rather than with a broken container, so the next request goes through the normal wake path.
        await rt.driver.stopDeployment(appId, pre.deploymentId).catch((e: unknown) => console.error('stop after failed restart', appId, e));
        return { error: 'start_failed', reason: health.reason === 'exited' ? 'deploy.error.app_exited' : 'deploy.error.health_check_failed', logs };
      }
      return null;
    } catch (e) {
      console.error('restart failed', appId, e);
      return { error: 'start_failed' };
    }
  };
  const failed = await (rt.lock ? rt.lock(appId, run) : run());
  return failed ?? { ok: true };
}
