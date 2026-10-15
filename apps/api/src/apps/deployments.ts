import { randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { BUCKETS, JOBS, appPrefix, type ArchiveFormat, type Storage } from 'platform';
import { STATIC_LIMITS } from 'shared';
import { UUID } from '../auth/cross-device.js';
import { withAccount, withSystem, type Db, type Tx } from '../db/client.js';
import { apps, deployments } from '../db/schema.js';
import { mayManage } from './apps.js';

/** The slice of pg-boss that deployment code needs (tests pass a fake). */
export interface JobQueue {
  send(name: string, data: object): Promise<unknown>;
}
export type DeploySource = 'upload' | 'cli' | 'github';
export type CreateDeploymentError = 'not_found' | 'forbidden' | 'too_large' | 'invalid';
export type RollbackError = 'not_found' | 'forbidden' | 'invalid_state';

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
  input: { source: DeploySource; archive: Readable; format: ArchiveFormat; commitSha?: string },
  createdBy: string | null,
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  allowed: (tx: Tx, ownerId: string) => Promise<boolean>,
): Promise<{ deploymentId: string } | { error: CreateDeploymentError }> {
  const deploymentId = randomUUID();
  const sourceKey = `${appPrefix(BUCKETS.sources, appId)}${deploymentId}.${input.format}`;
  const capped = capBytes(STATIC_LIMITS.storageBytes);
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
  input: { source: DeploySource; archive: Readable; format: ArchiveFormat; commitSha?: string },
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
    archive = await input.fetchArchive();
    const capped = capBytes(STATIC_LIMITS.storageBytes);
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
  return withAccount(db, accountId, (tx) => tx.select({
    id: deployments.id, status: deployments.status, source: deployments.source, message: deployments.message,
    findings: deployments.findings, totalBytes: deployments.totalBytes, fileCount: deployments.fileCount,
    commitSha: deployments.commitSha, createdAt: deployments.createdAt, finishedAt: deployments.finishedAt,
  }).from(deployments).where(eq(deployments.appId, appId)).orderBy(desc(deployments.createdAt), desc(deployments.id)));
}

/** Makes a past `live`/`superseded` deployment the live one again. */
export async function rollback(
  db: Db, accountId: string, appId: string, deploymentId: string,
): Promise<{ ok: true } | { error: RollbackError }> {
  if (!UUID.test(appId) || !UUID.test(deploymentId)) return { error: 'not_found' };
  return withAccount(db, accountId, async (tx) => {
    // Same lock as the worker's switch, so a rollback and a finishing deployment serialise.
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId)).for('update');
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    const [d] = await tx.select().from(deployments).where(and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)));
    if (!d) return { error: 'not_found' as const };
    if (!['live', 'superseded'].includes(d.status) || !d.siteKey) return { error: 'invalid_state' as const };
    await tx.update(deployments).set({ status: 'superseded' })
      .where(and(eq(deployments.appId, appId), eq(deployments.status, 'live'), ne(deployments.id, d.id)));
    await tx.update(deployments).set({ status: 'live' }).where(eq(deployments.id, d.id));
    await tx.update(apps).set({ activeDeploymentId: d.id, rolledBackAt: sql`now()` }).where(eq(apps.id, appId));
    return { ok: true as const };
  });
}
