import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { buildImage, detectStack, extractArchive, type ArchiveFormat, type Storage } from 'platform';
import { DYNAMIC_LIMITS } from 'shared';
import { withSystem, type Db } from '../db/client.js';
import { deployments } from '../db/schema.js';
import { LIMITS, entryPath, inspect, relativeToPublishDir } from './inspect.js';

export type DynamicJob = {
  deploymentId: string;
  appId: string;
  sourceKey: string;
  format: ArchiveFormat;
  stripTop: boolean;
  publishDir: string;
};

export const imageTag = (appId: string, deploymentId: string): string => `ys/${appId}:${deploymentId}`;
export const buildLogKey = (appId: string, deploymentId: string): string => `${appId}/${deploymentId}.build.log`;

const BUILD_ERROR = { timeout: 'deploy.error.build_timeout', too_large: 'deploy.error.image_too_large', build_failed: 'deploy.error.build_failed' } as const;
const DOCKERIGNORE = '.git\nnode_modules\n.env\n.env.*\n';

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(root, p));
    else out.push(p);
  }
  return out;
}

async function extractTo(storage: Storage, job: DynamicJob, dir: string): Promise<void> {
  const src = await storage.sources.get(job.sourceKey);
  if (!src) throw new Error('source_missing');
  const root = resolve(dir) + sep;
  for await (const e of extractArchive(src.body, job.format, LIMITS)) {
    const inner = entryPath(e.path, job.stripTop);
    const rel = inner === null ? null : relativeToPublishDir(inner, job.publishDir);
    if (rel === null) continue;
    const target = resolve(dir, rel);
    if (!target.startsWith(root)) continue; // extractArchive already rejects these; belt and braces
    await mkdir(dirname(target), { recursive: true });
    await pipeline(e.open(), createWriteStream(target, { mode: 0o644 }));
  }
}

/**
 * Hand-off to the rollout step (Task 3: start container, health check, switch traffic).
 * Until that exists, the deployment just stays `built` with its image recorded.
 */
export async function rolloutDynamic(db: Db, deploymentId: string): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx.update(deployments).set({ status: 'built', message: null, finishedAt: new Date() })
      .where(sql`${deployments.id} = ${deploymentId} AND ${deployments.status} = 'processing'`);
  });
}

/**
 * Dynamic-app deployment up to "image built": inspect (secrets, executables), detect the stack, build the
 * image, store the build log, record the image and hand off to rolloutDynamic. Infrastructure errors are thrown
 * (retry); every user-caused outcome is recorded on the deployment.
 */
export async function processDynamicDeployment(db: Db, storage: Storage, job: DynamicJob): Promise<void> {
  const { deploymentId, appId } = job;
  const finish = (set: Partial<typeof deployments.$inferInsert>) => withSystem(db, async (tx) => {
    await tx.update(deployments).set({ ...set, finishedAt: new Date() }).where(eq(deployments.id, deploymentId));
  });

  const out = await inspect(storage, job.sourceKey, job.format, job.publishDir, job.stripTop);
  if (out.kind === 'failed') return finish({ status: 'failed', message: out.message });
  if (out.kind === 'blocked') {
    return finish({
      status: 'blocked_secret', message: 'deploy.blockedSecret',
      findings: out.findings.map(({ path, line, rule }) => ({ path, line, rule })),
    });
  }
  if (out.kind === 'held') return finish({ status: 'held_for_review', message: 'deploy.heldForReview' });

  const dir = await mkdtemp(join(tmpdir(), 'ys-ctx-'));
  const tag = imageTag(appId, deploymentId);
  try {
    await extractTo(storage, job, dir);
    const files = await listFiles(dir);
    const stack = detectStack(files, (p) => { try { return readFileSync(join(dir, p), 'utf8'); } catch { return null; } });
    if ('error' in stack) return await finish({ status: 'failed', message: 'deploy.error.unknown_stack', totalBytes: out.bytes, fileCount: out.files });
    if (stack.kind !== 'dockerfile') {
      await writeFile(join(dir, 'Dockerfile'), stack.dockerfile);
      if (!files.includes('.dockerignore')) await writeFile(join(dir, '.dockerignore'), DOCKERIGNORE);
    }

    const result = await buildImage(dir, {
      tag,
      timeoutMs: DYNAMIC_LIMITS.buildTimeoutMinutes * 60_000,
      maxImageBytes: DYNAMIC_LIMITS.imageBytes,
      maxLogBytes: 5 * 1024 ** 2,
    });
    const logKey = buildLogKey(appId, deploymentId);
    await storage.sources.put(logKey, Buffer.from(result.log), 'text/plain; charset=utf-8');
    const common = { buildLogKey: logKey, totalBytes: out.bytes, fileCount: out.files };
    if (!result.ok) return await finish({ ...common, status: 'failed', message: BUILD_ERROR[result.reason] });

    const updated = await withSystem(db, async (tx) => {
      const rows = await tx.update(deployments).set({ ...common, imageRef: result.imageRef })
        .where(sql`${deployments.id} = ${deploymentId} AND ${deployments.status} = 'processing'`).returning({ id: deployments.id });
      return rows.length;
    });
    if (updated === 0) return; // app or deployment gone meanwhile; image cleanup belongs to app deletion (Task 3)
    await rolloutDynamic(db, deploymentId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
