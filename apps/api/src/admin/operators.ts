import { eq, sql } from 'drizzle-orm';
import { withSystem, type Db } from '../db/client.js';
import { operators } from '../db/schema.js';

export type OperatorRole = 'reviewer' | 'owner';
export interface Operator {
  accountId: string;
  role: OperatorRole;
  tailscaleLogin: string;
}

/** The active operator whose registered Tailscale login equals the header value (case-insensitive), or null. */
export async function findOperatorByLogin(db: Db, login: string | undefined): Promise<Operator | null> {
  const l = login?.trim().toLowerCase();
  if (!l || l.length > 320) return null;
  // Pre-authentication lookup: operators is not readable by platform_api, so the owner role does it.
  const [row] = await withSystem(db, (tx) => tx.select().from(operators).where(sql`${operators.tailscaleLogin} = ${l} and ${operators.active}`));
  return row ? { accountId: row.accountId, role: row.role, tailscaleLogin: row.tailscaleLogin } : null;
}

export async function getOperator(db: Db, accountId: string): Promise<Operator | null> {
  const [row] = await withSystem(db, (tx) => tx.select().from(operators).where(eq(operators.accountId, accountId)));
  return row?.active ? { accountId: row.accountId, role: row.role, tailscaleLogin: row.tailscaleLogin } : null;
}

export async function listOwnerAccountIds(db: Db): Promise<string[]> {
  const rows = await withSystem(db, (tx) => tx.select({ id: operators.accountId }).from(operators).where(sql`${operators.role} = 'owner' and ${operators.active}`));
  return rows.map((r) => r.id);
}
