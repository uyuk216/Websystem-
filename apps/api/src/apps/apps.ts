import { and, count, desc, eq } from 'drizzle-orm';
import { STATIC_LIMITS, can, validateAppName, type TeamRole } from 'shared';
import { withAccount, withSystem, type Db, type Tx } from '../db/client.js';
import { apps, deployments, owners, teamMembers } from '../db/schema.js';
import { UUID } from '../auth/cross-device.js';

export type CreateAppError = 'format' | 'reserved' | 'taken' | 'forbidden' | 'limit';

const columns = {
  id: apps.id, ownerId: apps.ownerId, name: apps.name, kind: apps.kind, publishDir: apps.publishDir,
  activeDeploymentId: apps.activeDeploymentId, githubRepo: apps.githubRepo, githubBranch: apps.githubBranch,
  createdAt: apps.createdAt,
} as const;

/** Normalises a publish dir: no leading/trailing slashes, no "." / ".." segments. Null when unsafe. */
export function normalizePublishDir(input: string): string | null {
  const parts = input.trim().split('/').filter((p) => p !== '');
  if (parts.some((p) => p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) return null;
  const dir = parts.join('/');
  return dir.length > 200 ? null : dir;
}

export async function createApp(
  db: Db, accountId: string, input: { name: string; ownerId: string; publishDir?: string },
): Promise<{ appId: string } | { error: CreateAppError }> {
  const v = validateAppName(input.name);
  if (!v.ok) return { error: v.reason };
  if (!UUID.test(input.ownerId)) return { error: 'forbidden' };
  const publishDir = normalizePublishDir(input.publishDir ?? '');
  if (publishDir === null) return { error: 'format' };
  return withAccount(db, accountId, async (tx) => {
    // Lock the owner row: serialises concurrent creates for the same owner so the limit holds.
    // RLS hides owners the account cannot act for, so "not found" means forbidden.
    const [o] = await tx.select().from(owners).where(eq(owners.id, input.ownerId)).for('update');
    if (!o) return { error: 'forbidden' as const };
    if (o.kind === 'team') {
      const [m] = await tx.select({ role: teamMembers.role }).from(teamMembers)
        .where(and(eq(teamMembers.teamId, o.teamId!), eq(teamMembers.accountId, accountId)));
      if (!m || !can(m.role as TeamRole, 'deploy')) return { error: 'forbidden' as const };
    }
    const [n] = await tx.select({ n: count() }).from(apps).where(eq(apps.ownerId, o.id));
    if ((n?.n ?? 0) >= STATIC_LIMITS.sitesPerOwner) return { error: 'limit' as const };
    const [row] = await tx.insert(apps).values({ ownerId: o.id, name: input.name, publishDir })
      .onConflictDoNothing({ target: apps.name }).returning({ id: apps.id });
    return row ? { appId: row.id } : { error: 'taken' as const };
  });
}

export async function listApps(db: Db, accountId: string) {
  return withAccount(db, accountId, (tx) => tx.select(columns).from(apps).orderBy(desc(apps.createdAt)));
}

export async function getApp(db: Db, accountId: string, appId: string) {
  if (!UUID.test(appId)) return null;
  return withAccount(db, accountId, async (tx) => (await tx.select(columns).from(apps).where(eq(apps.id, appId)))[0] ?? null);
}

/** Team members need `deploy` to change settings (role check shared with create/delete). */
export async function mayManage(tx: Tx, accountId: string, ownerId: string): Promise<boolean> {
  const [o] = await tx.select().from(owners).where(eq(owners.id, ownerId));
  if (!o) return false;
  if (o.kind === 'account') return o.accountId === accountId;
  const [m] = await tx.select({ role: teamMembers.role }).from(teamMembers)
    .where(and(eq(teamMembers.teamId, o.teamId!), eq(teamMembers.accountId, accountId)));
  return !!m && can(m.role as TeamRole, 'deploy');
}

export async function updateApp(
  db: Db, accountId: string, appId: string, input: { publishDir: string },
): Promise<{ ok: true } | { error: 'not_found' | 'invalid' | 'forbidden' }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  const publishDir = normalizePublishDir(input.publishDir);
  if (publishDir === null) return { error: 'invalid' };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    await tx.update(apps).set({ publishDir }).where(eq(apps.id, appId));
    return { ok: true as const };
  });
}

/**
 * Deletes the app and its deployment rows. Stored files are removed asynchronously: the queue arrives
 * with the storage tasks, so the caller passes `enqueueStorageCleanup` (called after commit).
 */
export async function deleteApp(
  db: Db, accountId: string, appId: string,
  opts: { enqueueStorageCleanup?: (appId: string) => Promise<void> } = {},
): Promise<{ ok: true } | { error: 'not_found' | 'forbidden' }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  const r = await withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    await tx.delete(apps).where(eq(apps.id, appId));
    return { ok: true as const };
  });
  if ('ok' in r) {
    try { await opts.enqueueStorageCleanup?.(appId); } catch (e) { console.error('storage cleanup enqueue failed', appId, e); }
  }
  return r;
}

/** Read-only lookup for the static server (owner role): the live deployment's site key by app name. */
export async function findLiveSite(db: Db, name: string): Promise<{ appId: string; siteKey: string } | null> {
  const [r] = await withSystem(db, (tx) =>
    tx.select({ appId: apps.id, siteKey: deployments.siteKey }).from(apps)
      .innerJoin(deployments, and(eq(deployments.id, apps.activeDeploymentId), eq(deployments.appId, apps.id)))
      .where(eq(apps.name, name)));
  return r?.siteKey ? { appId: r.appId, siteKey: r.siteKey } : null;
}
