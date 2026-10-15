import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { sessions } from '../db/schema.js';

export const SESSION_TTL_MS = 30 * 86400_000;
/** Sliding idle window is SESSION_TTL_MS; a session never outlives created_at + this, however active. */
export const SESSION_ABSOLUTE_DAYS = 90;
export const SESSION_ABSOLUTE_MS = SESSION_ABSOLUTE_DAYS * 86400_000;

export interface SessionView {
  id: string;
  deviceLabel: string;
  createdAt: Date;
  lastSeenAt: Date;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, accountId: string, deviceLabel: string): Promise<{ token: string; sessionId: string }> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await withAccount(db, accountId, (tx) =>
    tx.insert(sessions).values({ accountId, tokenHash: hashToken(token), deviceLabel, lastSeenAt: new Date() }).returning({ id: sessions.id }));
  return { token, sessionId: row!.id };
}

export async function resolveSession(db: Db, token: string): Promise<{ accountId: string; sessionId: string } | null> {
  const now = new Date();
  // Pre-authentication: the account is unknown until the token resolves.
  const [row] = await withSystem(db, (tx) => tx
    .update(sessions)
    .set({ lastSeenAt: now })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.lastSeenAt, new Date(now.getTime() - SESSION_TTL_MS)), gt(sessions.createdAt, new Date(now.getTime() - SESSION_ABSOLUTE_MS))))
    .returning({ accountId: sessions.accountId, sessionId: sessions.id }));
  return row ?? null;
}

export async function listSessions(db: Db, accountId: string): Promise<SessionView[]> {
  return withAccount(db, accountId, (tx) => tx
    .select({ id: sessions.id, deviceLabel: sessions.deviceLabel, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt), gt(sessions.lastSeenAt, new Date(Date.now() - SESSION_TTL_MS)), gt(sessions.createdAt, new Date(Date.now() - SESSION_ABSOLUTE_MS))))
    .orderBy(sessions.createdAt));
}

export async function revokeSession(db: Db, accountId: string, sessionId: string): Promise<void> {
  await withAccount(db, accountId, (tx) => tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId), isNull(sessions.revokedAt))));
}

/** Deletes revoked sessions and those past the idle or absolute limit. Returns the number of rows removed. */
export async function purgeExpiredSessions(db: Db, now: Date): Promise<number> {
  const rows = await withSystem(db, (tx) => tx.delete(sessions).where(or(
    isNotNull(sessions.revokedAt),
    lt(sessions.lastSeenAt, new Date(now.getTime() - SESSION_TTL_MS)),
    lt(sessions.createdAt, new Date(now.getTime() - SESSION_ABSOLUTE_MS)),
  )).returning({ id: sessions.id }));
  return rows.length;
}
