import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { withAccount, withSystem, type Db, type Tx } from '../db/client.js';
import { apps, githubDeliveries, githubInstallationLinks, githubOauthStates } from '../db/schema.js';
import { UUID } from '../auth/cross-device.js';
import { mayManage } from '../apps/apps.js';
import type { GithubClient } from './client.js';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const DELIVERY_RETENTION_MS = 7 * 86400_000;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Starts a user-authorization round trip. The nonce is stored hashed and bound to the starting session. */
export async function startConnect(db: Db, accountId: string, sessionId: string, now = new Date()): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  await withSystem(db, (tx) => tx.insert(githubOauthStates).values({
    stateHash: hash(state), accountId, sessionId, expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
  }));
  return state;
}

/**
 * Finishes the round trip: the state must be unexpired, unused and belong to this very session. The installations
 * GitHub says the user can access are then recorded as links for the account.
 */
export async function completeConnect(
  db: Db, accountId: string, sessionId: string, state: string, code: string, client: GithubClient, now = new Date(),
): Promise<{ ok: true; installations: number } | { error: 'invalid' }> {
  const consumed = await withSystem(db, (tx) => tx.delete(githubOauthStates).where(and(
    eq(githubOauthStates.stateHash, hash(state)), eq(githubOauthStates.accountId, accountId),
    eq(githubOauthStates.sessionId, sessionId), gt(githubOauthStates.expiresAt, now),
  )).returning({ h: githubOauthStates.stateHash }));
  if (consumed.length === 0) return { error: 'invalid' };
  const ids = await client.userInstallations(code);
  if (ids.length > 0) {
    await withAccount(db, accountId, (tx) => tx.insert(githubInstallationLinks)
      .values(ids.map((installationId) => ({ accountId, installationId }))).onConflictDoNothing());
  }
  return { ok: true, installations: ids.length };
}

/** Deletes expired OAuth states and webhook delivery ids older than 7 days. */
export async function purgeGithubState(db: Db, now: Date): Promise<number> {
  return withSystem(db, async (tx) => {
    const a = await tx.delete(githubOauthStates).where(lt(githubOauthStates.expiresAt, now)).returning({ h: githubOauthStates.stateHash });
    const b = await tx.delete(githubDeliveries).where(lt(githubDeliveries.receivedAt, new Date(now.getTime() - DELIVERY_RETENTION_MS))).returning({ h: githubDeliveries.deliveryId });
    return a.length + b.length;
  });
}

const hasLink = async (tx: Tx, accountId: string, installationId: string): Promise<boolean> =>
  (await tx.select({ i: githubInstallationLinks.installationId }).from(githubInstallationLinks)
    .where(and(eq(githubInstallationLinks.accountId, accountId), eq(githubInstallationLinks.installationId, installationId)))).length > 0;

/** "owner/name": no "."/".." segments, repo name not ending in ".git". */
export function validRepo(repo: string): boolean {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return false;
  const [owner, name] = repo.split('/') as [string, string];
  return ![owner, name].some((p) => p === '.' || p === '..') && !/\.git$/i.test(name);
}

const validBranch = (b: string): boolean =>
  b.length > 0 && b.length <= 255 && !/[\s~^:?*[\\]/.test(b) && ![...b].some((ch) => ch < ' ' || ch === '\x7f');

/**
 * Connects an app to a GitHub repo/branch through an App installation. Needs the owner's deploy permission AND a
 * link proving that the acting account controls the installation (team apps: the acting member's own link).
 * `verify` then confirms with GitHub that the installation exists and can read the repo.
 */
export async function setGithub(
  db: Db, accountId: string, appId: string, input: { repo: string; branch: string; installationId: string },
  verify: (installationId: string, repo: string) => Promise<boolean>,
): Promise<{ ok: true } | { error: 'not_found' | 'invalid' | 'forbidden' }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  if (!validRepo(input.repo) || !/^\d{1,16}$/.test(input.installationId) || !validBranch(input.branch)) return { error: 'invalid' };
  const access = await withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return 'not_found' as const;
    if (!(await mayManage(tx, accountId, a.ownerId))) return 'forbidden' as const;
    return (await hasLink(tx, accountId, input.installationId)) ? ('ok' as const) : ('forbidden' as const);
  });
  if (access !== 'ok') return { error: access };
  if (!(await verify(input.installationId, input.repo))) return { error: 'invalid' };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId)).for('update');
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId)) || !(await hasLink(tx, accountId, input.installationId))) return { error: 'forbidden' as const };
    await tx.update(apps).set({ githubRepo: input.repo, githubBranch: input.branch, githubInstallationId: input.installationId }).where(eq(apps.id, appId));
    return { ok: true as const };
  });
}
