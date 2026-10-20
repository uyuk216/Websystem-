import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { withSystem, type Db } from '../db/client.js';
import { adminSessions } from '../db/schema.js';

export const ADMIN_SESSION_TTL_MS = 30 * 60_000;
export const ADMIN_SESSION_COOKIE = 'asid';

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Called only after the operator's passkey assertion (userVerification: required) has been verified. */
export async function createAdminSession(db: Db, operatorId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  await withSystem(db, (tx) => tx.insert(adminSessions).values({ operatorId, tokenHash: hash(token), createdAt: now, expiresAt }));
  return { token, expiresAt };
}

/** The operator a live (unexpired, unrevoked) session belongs to. Sessions are absolute 30-minute windows, never extended. */
export async function resolveAdminSession(db: Db, token: string | undefined, now = new Date()): Promise<{ operatorId: string; expiresAt: Date } | null> {
  if (!token || token.length > 100) return null;
  const [row] = await withSystem(db, (tx) => tx.select({ operatorId: adminSessions.operatorId, expiresAt: adminSessions.expiresAt }).from(adminSessions)
    .where(and(eq(adminSessions.tokenHash, hash(token)), isNull(adminSessions.revokedAt), gt(adminSessions.expiresAt, now))));
  return row ?? null;
}

export async function revokeAdminSession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await withSystem(db, (tx) => tx.update(adminSessions).set({ revokedAt: new Date() }).where(and(eq(adminSessions.tokenHash, hash(token)), isNull(adminSessions.revokedAt))));
}
