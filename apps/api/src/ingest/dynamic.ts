import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { DockerDatabaseDriver, DockerDriver, KubernetesDriver, type DatabaseDriver, buildImage, pushImage, collectLogs, detectStack, extractArchive, removeImage, waitHealthy, type AppRunSpec, type ArchiveFormat, type HealthOptions, type RuntimeDriver, type Storage } from 'platform';
import { DYNAMIC_LIMITS } from 'shared';
import { withSystem, type Db } from '../db/client.js';
import { getRunInputs } from '../apps/databases.js';
import { apps, deployments } from '../db/schema.js';
import { runtimeBlockedUntil } from '../usage/runtime-hours.js';
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

export const CONTAINER_PORT = 8080;

/** What the rollout needs to run apps. `envKey` is mandatory: apps cannot start without their decrypted env vars. */
export interface DynamicRuntime {
  driver: RuntimeDriver;
  envKey: Buffer;
  health?: HealthOptions;
  /** Cross-process per-app lock (see createWakeLocker). Held by rollouts so the sleeper and edge wakes never race them. */
  lock?: <T>(appId: string, fn: () => Promise<T>, opts?: { timeoutMs?: number }) => Promise<T>;
  /** User databases (phase 4); undefined when unavailable (e.g. the Kubernetes driver until Task 6). */
  databases?: DatabaseDriver;
  /** Registry the built images are pushed to (IMAGE_REGISTRY); needed when the cluster cannot see local Docker images. */
  imageRegistry?: string;
}

/**
 * Builds the runtime from the process environment. DYNAMIC_RUNTIME=off disables it (undefined); otherwise a
 * Docker driver (or the Kubernetes driver with RUNTIME_DRIVER=kubernetes) is used and APP_ENV_KEY (32 bytes, base64) must be set, or this throws.
 */
export function createDynamicRuntime(env: NodeJS.ProcessEnv): DynamicRuntime | undefined {
  if (env.DYNAMIC_RUNTIME === 'off') return undefined;
  const raw = env.APP_ENV_KEY;
  if (!raw) throw new Error('APP_ENV_KEY is required when the dynamic runtime is enabled (set DYNAMIC_RUNTIME=off to disable it)');
  const envKey = Buffer.from(raw, 'base64');
  if (envKey.length !== 32) throw new Error('APP_ENV_KEY must be 32 bytes (base64)');
  const kind = env.RUNTIME_DRIVER ?? 'docker';
  if (kind !== 'docker' && kind !== 'kubernetes') throw new Error(`RUNTIME_DRIVER must be docker or kubernetes (got ${kind})`);
  return {
    driver: kind === 'kubernetes' ? new KubernetesDriver() : new DockerDriver(), envKey,
    ...(kind === 'docker' ? { databases: new DockerDatabaseDriver() } : {}),
    ...(env.IMAGE_REGISTRY ? { imageRegistry: env.IMAGE_REGISTRY } : {}),
  };
}

export const runLimits = { memoryMb: DYNAMIC_LIMITS.memoryMb, cpu: DYNAMIC_LIMITS.cpu, pids: DYNAMIC_LIMITS.pids };

/**
 * The run spec for a deployment (decrypted env + PORT), shared by the rollout and the edge waking a sleeping app.
 * Null when the deployment has no image (or does not belong to the app).
 */
export async function buildRunSpec(db: Db, rt: DynamicRuntime, appId: string, deploymentId: string): Promise<AppRunSpec | null> {
  const [d] = await withSystem(db, (tx) => tx.select({ imageRef: deployments.imageRef, ownerId: apps.ownerId })
    .from(deployments).innerJoin(apps, eq(apps.id, deployments.appId))
    .where(sql`${deployments.id} = ${deploymentId} AND ${deployments.appId} = ${appId}`));
  if (!d?.imageRef) return null;
  const { env, networks } = await getRunInputs(db, rt, appId);
  return { appId, deploymentId, ownerId: d.ownerId, image: d.imageRef, env: { ...env, PORT: String(CONTAINER_PORT) }, limits: runLimits, port: CONTAINER_PORT, networks };
}

/**
 * Starts the deployment's image as a new container next to the running one, health-checks it and, only if
 * healthy, switches the app to it (Phase 2 ordering rules) and stops the previous container. The old version
 * keeps answering until the switch. Without a runtime the deployment just stays `built`.
 * User-caused failures are recorded; infrastructure errors are thrown (the job is retried).
 */
export async function rolloutDynamic(db: Db, deploymentId: string, rt?: DynamicRuntime): Promise<void> {
  if (!rt) {
    await withSystem(db, async (tx) => {
      await tx.update(deployments).set({ status: 'built', message: null, finishedAt: new Date() })
        .where(sql`${deployments.id} = ${deploymentId} AND ${deployments.status} = 'processing'`);
    });
    return;
  }
  const { driver } = rt;
  const [d] = await withSystem(db, (tx) => tx.select({
    appId: deployments.appId, imageRef: deployments.imageRef, ownerId: apps.ownerId,
  }).from(deployments).innerJoin(apps, eq(apps.id, deployments.appId))
    .where(sql`${deployments.id} = ${deploymentId} AND ${deployments.status} = 'processing'`));
  if (!d?.imageRef) return;
  const { appId, imageRef } = d;

  // Held through start, health check and switch: the sleeper and the edge's wake never see a half-started app.
  const body = async (): Promise<void> => {
  let env: Record<string, string> = {};
  let secrets: string[] = [];
  let started = false;
  try {
    // An owner who used up their runtime hours cannot start anything until the period rolls over.
    if (await runtimeBlockedUntil(db, d.ownerId)) {
      await withSystem(db, async (tx) => {
        await tx.update(deployments).set({ status: 'failed', imageRef: null, finishedAt: new Date(), message: 'deploy.error.runtime_limit' })
          .where(sql`${deployments.id} = ${deploymentId} AND ${deployments.status} = 'processing'`);
      });
      await removeImage(imageRef).catch(() => undefined);
      return;
    }
    // An app being deployed counts as accessed, so it is not put to sleep right after going live.
    await withSystem(db, (tx) => tx.update(apps).set({ lastAccessAt: new Date() }).where(eq(apps.id, appId)));
    const run = await getRunInputs(db, rt, appId);
    env = run.env;
    secrets = run.secrets;
    await driver.start({ appId, deploymentId, ownerId: d.ownerId, image: imageRef, env: { ...env, PORT: String(CONTAINER_PORT) }, limits: runLimits, port: CONTAINER_PORT, networks: run.networks });
    started = true;
    const health = await waitHealthy(driver, appId, deploymentId, rt.health);
    if (!health.ok) {
      const logs = await collectLogs(driver, appId, deploymentId, secrets);
      await driver.stopDeployment(appId, deploymentId);
      await withSystem(db, async (tx) => {
        await tx.update(deployments).set({
          status: 'failed', imageRef: null, finishedAt: new Date(),
          message: health.reason === 'exited' ? 'deploy.error.app_exited' : 'deploy.error.health_check_failed',
          findings: { kind: 'runtime', logs },
        }).where(sql`${deployments.id} = ${deploymentId} AND ${deployments.status} = 'processing'`);
      });
      await removeImage(imageRef).catch(() => undefined);
      return;
    }
    const stopOld = await withSystem(db, async (tx): Promise<string[] | null> => {
      // Serialises with other finishing deployments and with rollbacks of this app.
      const [app] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).for('update');
      const [cur] = await tx.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, deploymentId));
      if (!app || cur?.status !== 'processing') return null; // app deleted / superseded meanwhile
      const done = { finishedAt: new Date(), message: null };
      const newer = await tx.execute(sql`
        SELECT 1 FROM deployments WHERE app_id = ${appId} AND status = 'live'
          AND (created_at, id) > (SELECT created_at, id FROM deployments WHERE id = ${deploymentId}) LIMIT 1`);
      const [rb] = await tx.execute<{ stale: boolean }>(sql`
        SELECT (a.rolled_back_at IS NOT NULL AND d.created_at <= a.rolled_back_at) AS stale FROM apps a, deployments d
        WHERE a.id = ${appId} AND d.id = ${deploymentId}`);
      if (newer.length > 0 || rb?.stale) {
        await tx.update(deployments).set({ ...done, status: 'superseded' }).where(eq(deployments.id, deploymentId));
        return null;
      }
      const old = await tx.execute<{ id: string }>(sql`UPDATE deployments SET status = 'superseded' WHERE app_id = ${appId} AND status = 'live' RETURNING id`);
      await tx.update(deployments).set({ ...done, status: 'live' }).where(eq(deployments.id, deploymentId));
      await tx.update(apps).set({ activeDeploymentId: deploymentId, lastAccessAt: new Date() }).where(eq(apps.id, appId));
      return old.map((r) => r.id);
    });
    if (stopOld === null) {
      await driver.stopDeployment(appId, deploymentId);
      const [row] = await withSystem(db, (tx) => tx.select({ status: deployments.status }).from(deployments).where(eq(deployments.id, deploymentId)));
      if (!row) await removeImage(imageRef).catch(() => undefined); // app gone: nothing can roll back to it
      else if (row.status === 'processing') await removeImage(imageRef).catch(() => undefined);
      return;
    }
    for (const id of stopOld) await driver.stopDeployment(appId, id).catch((e: unknown) => console.error('stop old deployment failed', appId, id, e));
  } catch (e) {
    if (started) await driver.stopDeployment(appId, deploymentId).catch(() => undefined);
    throw e;
  }
  };
  await (rt.lock ? rt.lock(appId, body) : body());
}

/**
 * Dynamic-app deployment up to "image built": inspect (secrets, executables), detect the stack, build the
 * image, store the build log, record the image and hand off to rolloutDynamic. Infrastructure errors are thrown
 * (retry); every user-caused outcome is recorded on the deployment.
 */
export async function processDynamicDeployment(db: Db, storage: Storage, job: DynamicJob, rt?: DynamicRuntime): Promise<void> {
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
  let imageRef = tag; // becomes the registry ref once pushed
  let handedOff = false;
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
      tag, buildId: deploymentId,
      timeoutMs: DYNAMIC_LIMITS.buildTimeoutMinutes * 60_000,
      maxImageBytes: DYNAMIC_LIMITS.imageBytes,
      maxLogBytes: 5 * 1024 ** 2,
    });
    const logKey = buildLogKey(appId, deploymentId);
    await storage.sources.put(logKey, Buffer.from(result.log), 'text/plain; charset=utf-8');
    const common = { buildLogKey: logKey, totalBytes: out.bytes, fileCount: out.files };
    if (!result.ok) return await finish({ ...common, status: 'failed', message: BUILD_ERROR[result.reason] });
    imageRef = result.imageRef;
    if (rt?.imageRegistry) {
      const pushed = await pushImage(result.imageRef, rt.imageRegistry);
      if (!pushed.ok) {
        await storage.sources.put(logKey, Buffer.from(`${result.log}\n[image push failed]\n${pushed.log}`), 'text/plain; charset=utf-8');
        return await finish({ ...common, status: 'failed', message: 'deploy.error.build_failed' });
      }
      imageRef = pushed.imageRef;
      await removeImage(result.imageRef).catch(() => undefined); // the pushed tag stays until the deployment is removed
    }

    const updated = await withSystem(db, async (tx) => {
      const rows = await tx.update(deployments).set({ ...common, imageRef })
        .where(sql`${deployments.id} = ${deploymentId} AND ${deployments.status} = 'processing'`).returning({ id: deployments.id });
      return rows.length;
    });
    if (updated === 0) return; // app or deployment gone meanwhile: the image is removed in finally
    await rolloutDynamic(db, deploymentId, rt);
    handedOff = true;
  } finally {
    // Every path except a successful hand-off must not leave the image behind (failure, retry, deleted app).
    if (!handedOff) {
      await removeImage(tag).catch(() => undefined);
      if (imageRef !== tag) await removeImage(imageRef).catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true });
  }
}
