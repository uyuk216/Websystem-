import { eq, sql } from 'drizzle-orm';
import {
  ArchiveError, BUCKETS, JOBS, MAX_SCAN_BYTES, appPrefix, extractArchive, findExecutables, scanSecrets,
  type ArchiveFormat, type Finding, type Storage,
} from 'platform';
import { STATIC_LIMITS } from 'shared';
import { UUID } from '../auth/cross-device.js';
import { withSystem, type Db } from '../db/client.js';
import { apps, deployments } from '../db/schema.js';

const LIMITS = { maxTotalBytes: STATIC_LIMITS.storageBytes, maxFileBytes: STATIC_LIMITS.fileBytes } as const;

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  txt: 'text/plain; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', pdf: 'application/pdf',
  xml: 'application/xml', wasm: 'application/wasm', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
};
const contentType = (path: string): string => MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/** Resolves an archive path against publishDir. Null when the entry lies outside the publish folder. */
function relativeToPublishDir(path: string, publishDir: string): string | null {
  if (publishDir === '') return path;
  const prefix = `${publishDir}/`;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null;
}

/** GitHub tarballs wrap everything in `<owner>-<repo>-<sha>/`; drops that first segment (null for entries outside it). */
function stripTopDir(path: string): string | null {
  const i = path.indexOf('/');
  return i > 0 && i < path.length - 1 ? path.slice(i + 1) : null;
}

/** Path of an archive entry as the site sees it, before publishDir is applied. */
const entryPath = (path: string, stripTop: boolean): string | null => (stripTop ? stripTopDir(path) : path);

type Outcome =
  | { kind: 'ready'; files: number; bytes: number }
  | { kind: 'blocked'; findings: Finding[] }
  | { kind: 'held' }
  | { kind: 'failed'; message: string };

/** Pass 1: extract and inspect only. Nothing is written to the sites bucket. */
async function inspect(storage: Storage, sourceKey: string, format: ArchiveFormat, publishDir: string, stripTop: boolean): Promise<Outcome> {
  const src = await storage.sources.get(sourceKey);
  if (!src) return { kind: 'failed', message: 'deploy.error.source_missing' };
  const findings: Finding[] = [];
  const kept: string[] = [];
  let bytes = 0;
  for await (const e of extractArchive(src.body, format, LIMITS)) {
    // extractArchive already drops always-excluded paths. It sees the full path, so a publishDir such as
    // ".git" or "node_modules/x" leaves nothing to publish.
    const inner = entryPath(e.path, stripTop);
    const rel = inner === null ? null : relativeToPublishDir(inner, publishDir);
    if (rel === null) continue;
    kept.push(rel);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of e.open() as AsyncIterable<Buffer>) {
      if (n <= MAX_SCAN_BYTES) chunks.push(c);
      n += c.length;
    }
    bytes += n;
    if (n <= MAX_SCAN_BYTES) findings.push(...scanSecrets(rel, Buffer.concat(chunks)));
  }
  if (kept.length === 0) return { kind: 'failed', message: 'deploy.error.empty' };
  if (findings.length) return { kind: 'blocked', findings };
  if (findExecutables(kept).length) return { kind: 'held' };
  return { kind: 'ready', files: kept.length, bytes };
}

/** Pass 2: copy the publish folder to sites/<appId>/<deploymentId>/. */
async function publishFiles(storage: Storage, sourceKey: string, format: ArchiveFormat, publishDir: string, siteKey: string, stripTop: boolean): Promise<void> {
  const src = await storage.sources.get(sourceKey);
  if (!src) throw new ArchiveError('corrupt');
  for await (const e of extractArchive(src.body, format, LIMITS)) {
    const inner = entryPath(e.path, stripTop);
    const rel = inner === null ? null : relativeToPublishDir(inner, publishDir);
    if (rel === null) continue;
    await storage.sites.put(`${siteKey}${rel}`, e.open(), contentType(rel));
  }
}

/**
 * Worker entry point: inspects the archive, publishes the publish folder and, unless a newer deployment of
 * the same app is already live, switches the app to it. Runs as the system role (no account context).
 * Every outcome, including unexpected errors, is recorded on the deployment (status + i18n message key).
 */
export async function processDeployment(
  db: Db, storage: Storage, deploymentId: string, opts: { lastAttempt?: boolean } = {},
): Promise<void> {
  if (!UUID.test(deploymentId)) return;
  const claimed = await withSystem(db, async (tx) => {
    const rows = await tx.execute<{ app_id: string; source_key: string; publish_dir: string; source: string }>(sql`
      UPDATE deployments d SET status = 'processing'
      FROM apps a WHERE d.id = ${deploymentId} AND a.id = d.app_id AND d.status IN ('queued', 'processing')
      RETURNING d.app_id, d.source_key, d.source, a.publish_dir`);
    return rows[0] ?? null;
  });
  if (!claimed) return;
  const appId = claimed.app_id;
  const sourceKey = claimed.source_key;
  const format: ArchiveFormat = sourceKey.endsWith('.tar.gz') ? 'tar.gz' : 'zip';
  const stripTop = claimed.source === 'github';
  const siteKey = `${appPrefix(BUCKETS.sites, appId)}${deploymentId}/`;

  const finish = (set: Partial<typeof deployments.$inferInsert>) => withSystem(db, async (tx) => {
    await tx.update(deployments).set({ ...set, finishedAt: new Date() }).where(eq(deployments.id, deploymentId));
  });

  try {
    const out = await inspect(storage, sourceKey, format, claimed.publish_dir, stripTop);
    if (out.kind === 'failed') return await finish({ status: 'failed', message: out.message });
    if (out.kind === 'blocked') {
      return await finish({
        status: 'blocked_secret', message: 'deploy.blockedSecret',
        findings: out.findings.map(({ path, line, rule }) => ({ path, line, rule })),
      });
    }
    if (out.kind === 'held') return await finish({ status: 'held_for_review', message: 'deploy.heldForReview' });

    await publishFiles(storage, sourceKey, format, claimed.publish_dir, siteKey, stripTop);
    await withSystem(db, async (tx) => {
      // Serialises with other finishing deployments and with rollbacks of this app.
      const [app] = await tx.select({ id: apps.id, rolledBackAt: apps.rolledBackAt }).from(apps).where(eq(apps.id, appId)).for('update');
      if (!app) { // app deleted meanwhile: remove what this run published
        await storage.sites.deletePrefix(siteKey);
        return;
      }
      const [cur] = await tx.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, deploymentId));
      if (cur?.status !== 'processing') { // superseded meanwhile (e.g. by a rollback to the same commit): do not go live
        await storage.sites.deletePrefix(siteKey);
        return;
      }
      const done = { siteKey, totalBytes: out.bytes, fileCount: out.files, finishedAt: new Date(), message: null };
      const newer = await tx.execute(sql`
        SELECT 1 FROM deployments WHERE app_id = ${appId} AND status = 'live'
          AND (created_at, id) > (SELECT created_at, id FROM deployments WHERE id = ${deploymentId}) LIMIT 1`);
      // A rollback after this deployment was created pins the rolled-back version: older uploads must not override it.
      const [rb] = await tx.execute<{ stale: boolean }>(sql`
        SELECT (a.rolled_back_at IS NOT NULL AND d.created_at <= a.rolled_back_at) AS stale FROM apps a, deployments d
        WHERE a.id = ${appId} AND d.id = ${deploymentId}`);
      if (newer.length > 0 || rb?.stale) {
        await tx.update(deployments).set({ ...done, status: 'superseded' }).where(eq(deployments.id, deploymentId));
        return;
      }
      await tx.execute(sql`UPDATE deployments SET status = 'superseded' WHERE app_id = ${appId} AND status = 'live'`);
      await tx.update(deployments).set({ ...done, status: 'live' }).where(eq(deployments.id, deploymentId));
      await tx.update(apps).set({ activeDeploymentId: deploymentId }).where(eq(apps.id, appId));
    });
  } catch (e) {
    await storage.sites.deletePrefix(siteKey).catch(() => undefined);
    if (e instanceof ArchiveError) return await finish({ status: 'failed', message: `deploy.error.${e.code}` });
    // Infrastructure error: let the queue retry; only the last attempt records the failure.
    if (!opts.lastAttempt) throw e;
    console.error('processDeployment failed', deploymentId, e);
    await finish({ status: 'failed', message: 'deploy.error.internal' });
  }
}

/** Removes all stored files of an app (sources and published sites). */
export async function deleteAppStorage(storage: Storage, appId: string): Promise<void> {
  await storage.sources.deletePrefix(appPrefix(BUCKETS.sources, appId));
  await storage.sites.deletePrefix(appPrefix(BUCKETS.sites, appId));
}

export const STALE_QUEUED_MS = 15 * 60_000;

/**
 * Marks `queued` deployments older than 15 minutes that have no pending pg-boss job (never enqueued, or the
 * process died in between) as `failed` (deploy.error.stale), which also frees their (app, commit) dedupe slot
 * so the next push of that commit is accepted. Returns the number of deployments marked.
 */
export async function sweepStaleDeployments(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_QUEUED_MS);
  return withSystem(db, async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE deployments d SET status = 'failed', message = 'deploy.error.stale', finished_at = now()
      WHERE d.status = 'queued' AND d.created_at < ${cutoff.toISOString()}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM pgboss.job j
          WHERE j.name = ${JOBS.processDeployment} AND j.data->>'deploymentId' = d.id::text
            AND j.state IN ('created', 'retry', 'active'))
      RETURNING d.id`);
    return rows.length;
  });
}
