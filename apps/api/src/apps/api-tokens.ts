import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { apiTokens } from '../db/schema.js';

export const TOKEN_PREFIX = 'ysk_';
export const hashApiToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** The plaintext token is returned once; only its SHA-256 is stored. */
export async function createApiToken(db: Db, accountId: string, name: string): Promise<{ token: string; id: string }> {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const [row] = await withAccount(db, accountId, (tx) => tx
    .insert(apiTokens)
    .values({ accountId, name, tokenHash: hashApiToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 4) })
    .returning({ id: apiTokens.id }));
  return { token, id: row!.id };
}

export async function listApiTokens(db: Db, accountId: string): Promise<ApiTokenView[]> {
  return withAccount(db, accountId, (tx) => tx
    .select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, createdAt: apiTokens.createdAt, lastUsedAt: apiTokens.lastUsedAt })
    .from(apiTokens)
    .where(and(eq(apiTokens.accountId, accountId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt)));
}

export async function revokeApiToken(db: Db, accountId: string, id: string): Promise<boolean> {
  const rows = await withAccount(db, accountId, (tx) => tx
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.accountId, accountId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id }));
  return rows.length > 0;
}

/** Pre-authentication lookup by hash (the account is unknown until it resolves). */
export async function resolveApiToken(db: Db, token: string): Promise<{ accountId: string } | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [row] = await withSystem(db, (tx) => tx
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiTokens.tokenHash, hashApiToken(token)), isNull(apiTokens.revokedAt)))
    .returning({ accountId: apiTokens.accountId }));
  return row ?? null;
}
