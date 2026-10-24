import { desc, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { adminAuditLog } from '../db/schema.js';
import type { Operator } from './operators.js';

export interface AuditContext {
  /** Records one more operator action in the same transaction as the work it describes. */
  audit(action: string, target: string, detail?: Record<string, unknown>): Promise<void>;
}

export interface AuditEntry {
  action: string;
  target: string;
  /** Never put secrets, plaintext e-mail addresses or image data here. */
  detail?: Record<string, unknown>;
}

export class AuditHoldError extends Error { constructor() { super('audit_backlog_hold'); this.name = 'AuditHoldError'; } }
let adminHold: (() => Promise<boolean>) | null = null;
/** WORM 配送がたまりすぎたとき管理変更を保留する判定を登録する（未登録＝保留しない。配送が未導入のうちは登録しない）。既存の遮断は影響を受けない。 */
export function setAdminAuditHold(fn: (() => Promise<boolean>) | null): void { adminHold = fn; }

async function insertAudit(tx: Tx, operatorId: string, e: AuditEntry): Promise<void> {
  await tx.insert(adminAuditLog).values({ seq: 0, /* assigned by the chain trigger */ operatorId, action: e.action, target: e.target, detail: e.detail ?? {} });
}

/**
 * The only way the admin side reaches the database as `platform_admin`. Inside one transaction it (1) switches to the
 * admin role with `app.operator_id` set, (2) writes the audit entry for this operation FIRST, then (3) runs `fn`.
 * If recording fails nothing runs; if `fn` fails the record rolls back with it. Row policies only allow audit rows
 * and settings/schedule writes carrying the current operator id, so a write that bypasses this wrapper is rejected.
 * Viewing sensitive data (e.g. decrypting an ID image) is an operation like any other and goes through here too.
 */
export async function withAdmin<T>(db: Db, operator: Pick<Operator, 'accountId'>, entry: AuditEntry, fn: (tx: Tx, ctx: AuditContext) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operator.accountId)) throw new Error('withAdmin: invalid operator id');
  if (adminHold && (await adminHold().catch(() => false))) throw new AuditHoldError();
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role platform_admin`);
    await tx.execute(sql`select set_config('app.operator_id', ${operator.accountId}, true)`);
    await insertAudit(tx, operator.accountId, entry);
    return fn(tx, { audit: (action, target, detail) => insertAudit(tx, operator.accountId, { action, target, detail }) });
  });
}

/** First seq whose hash chain is broken (edited row, missing row, bad link), or null when the whole log verifies. */
export async function verifyAuditChain(db: Db): Promise<number | null> {
  const rows = await db.execute<{ bad: string | null }>(sql`select admin_audit_verify() as bad`);
  const bad = rows[0]?.bad;
  return bad === null || bad === undefined ? null : Number(bad);
}

export async function listAudit(tx: Tx, limit = 100) {
  return tx.select().from(adminAuditLog).orderBy(desc(adminAuditLog.seq)).limit(Math.min(Math.max(limit, 1), 500));
}
