import type { Readable } from 'node:stream';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { verify } from '@octokit/webhooks-methods';
import type { Storage } from 'platform';
import { withSystem, type Db } from '../db/client.js';
import { apps, deployments, githubDeliveries } from '../db/schema.js';
import { createSystemDeployment, type JobQueue } from '../apps/deployments.js';
import type { GithubClient } from './client.js';

/** Checks the `X-Hub-Signature-256` header against the raw request body. Never throws. */
export async function verifyWebhook(secret: string, payload: string, signature256: string | undefined): Promise<boolean> {
  if (!signature256 || !secret) return false;
  try {
    return await verify(secret, payload, signature256);
  } catch {
    return false;
  }
}

export interface PushEvent {
  ref: string;
  after: string;
  deleted: boolean;
  installationId: string;
  repo: string;
}

/** Narrows an untrusted push payload; null when required fields are missing or malformed. */
export function parsePush(raw: unknown): PushEvent | null {
  const p = raw as { ref?: unknown; after?: unknown; deleted?: unknown; installation?: { id?: unknown }; repository?: { full_name?: unknown } } | null;
  const id = p?.installation?.id;
  if (typeof p?.ref !== 'string' || typeof p.after !== 'string' || !/^[0-9a-f]{40}$/.test(p.after)) return null;
  if ((typeof id !== 'number' && typeof id !== 'string') || typeof p.repository?.full_name !== 'string') return null;
  return { ref: p.ref, after: p.after, deleted: p.deleted === true, installationId: String(id), repo: p.repository.full_name };
}

/** Apps connected to this installation + repo + branch. Empty for deleted pushes and non-branch refs. */
export async function findPushTargets(db: Db, e: PushEvent): Promise<string[]> {
  const prefix = 'refs/heads/';
  if (e.deleted || !e.ref.startsWith(prefix)) return [];
  const branch = e.ref.slice(prefix.length);
  const rows = await withSystem(db, (tx) => tx.select({ id: apps.id }).from(apps).where(and(
    eq(apps.githubInstallationId, e.installationId),
    // GitHub repository names are case-insensitive.
    sql`lower(${apps.githubRepo}) = ${e.repo.toLowerCase()}`,
    eq(apps.githubBranch, branch),
  )));
  return rows.map((r) => r.id);
}

/**
 * Downloads the pushed commit once per app and queues a deployment for it. A failure for one app is logged
 * and does not stop the others. Processing itself happens in the worker.
 */
export async function deployPush(
  db: Db, storage: Storage, queue: JobQueue, client: GithubClient, e: PushEvent, appIds: string[],
): Promise<void> {
  for (const appId of appIds) {
    try {
      // A commit that is already queued, being processed or live is not deployed again.
      const dup = await withSystem(db, (tx) => tx.select({ id: deployments.id }).from(deployments).where(and(
        eq(deployments.appId, appId), eq(deployments.commitSha, e.after), inArray(deployments.status, ['queued', 'processing', 'live']),
      )).limit(1));
      if (dup.length > 0) continue;
      const r = await createSystemDeployment(db, storage, queue, appId, {
        source: 'github', format: 'tar.gz', commitSha: e.after,
        fetchArchive: (): Promise<Readable> => client.downloadTarball(e.installationId, e.repo, e.after),
      });
      if ('error' in r) console.error('github deploy rejected', appId, r.error);
    } catch (err) {
      console.error('github deploy failed', appId, err);
    }
  }
}

/** Records a webhook delivery id. False when it was already seen (a replay or redelivery). */
export async function claimDelivery(db: Db, deliveryId: string): Promise<boolean> {
  const rows = await withSystem(db, (tx) => tx.insert(githubDeliveries).values({ deliveryId })
    .onConflictDoNothing().returning({ id: githubDeliveries.deliveryId }));
  return rows.length > 0;
}
