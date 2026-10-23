import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { withAdmin, type AuditEntry } from './audit-log.js';
import type { Operator } from './operators.js';

/** Record first, then use the owner connection for existing system services in the SAME transaction.
 * Never expose the callback or role switch to request input. Audit failure prevents all work.
 */
export function auditedSystem<T>(db: Db, operator: Operator, entry: AuditEntry, fn: (db: Db) => Promise<T>): Promise<T> {
  return withAdmin(db, operator, entry, async (tx) => {
    await tx.execute(sql`reset role`);
    return fn(tx as unknown as Db);
  });
}
