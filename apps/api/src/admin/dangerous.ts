import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { withSystem } from '../db/client.js';
import { accounts, scheduledDangerousActions } from '../db/schema.js';
import { decryptEmail } from '../crypto/email.js';
import type { Mailer } from '../mail/mailer.js';
import { withAdmin } from './audit-log.js';
import { listOwnerAccountIds, type Operator } from './operators.js';

/** Dangerous operations only run this long after they are booked, so a mistaken or hijacked request can be cancelled. */
export const DANGEROUS_LEAD_MS = 24 * 3600_000;

export type DangerousHandler = (tx: Parameters<Parameters<Db['transaction']>[0]>[0], target: string, params: Record<string, unknown>) => Promise<void>;
/** Only registered actions can be booked. This plan ships one example, `unfreeze_account`; the real freeze state arrives with phase 5 task 7. */
export type DangerousHandlers = Record<string, DangerousHandler>;

export async function scheduleDangerous(
  db: Db, mailer: Mailer, emailEncKey: Buffer, handlers: DangerousHandlers, operator: Operator,
  input: { action: string; target: string; params?: Record<string, unknown> }, now = new Date(),
): Promise<{ id: string; executeAfter: Date } | { error: 'unknown_action' | 'invalid' }> {
  if (!Object.hasOwn(handlers, input.action)) return { error: 'unknown_action' };
  if (typeof input.target !== 'string' || input.target.length < 1 || input.target.length > 200) return { error: 'invalid' };
  const executeAfter = new Date(now.getTime() + DANGEROUS_LEAD_MS);
  const row = await withAdmin(db, operator, { action: 'dangerous.schedule', target: input.target, detail: { action: input.action, executeAfter: executeAfter.toISOString() } }, async (tx) => {
    const [r] = await tx.insert(scheduledDangerousActions).values({
      action: input.action, target: input.target, params: input.params ?? {}, requestedBy: operator.accountId, executeAfter,
    }).returning({ id: scheduledDangerousActions.id });
    return r!;
  });
  await notifyOwners(db, mailer, emailEncKey, `[Admin] ${input.action} scheduled`,
    `Operator ${operator.tailscaleLogin} booked "${input.action}" for target ${input.target}.\nIt runs at ${executeAfter.toISOString()} unless cancelled before then.`)
    .then(() => withSystem(db, (tx) => tx.update(scheduledDangerousActions).set({ notifiedAt: new Date() }).where(eq(scheduledDangerousActions.id, row.id))))
    .catch((err: unknown) => console.error('dangerous-action notification failed', err));
  return { id: row.id, executeAfter };
}

export async function cancelDangerous(db: Db, mailer: Mailer, emailEncKey: Buffer, operator: Operator, id: string): Promise<boolean> {
  const done = await withAdmin(db, operator, { action: 'dangerous.cancel', target: id }, async (tx) => {
    const rows = await tx.update(scheduledDangerousActions).set({ status: 'cancelled', cancelledAt: new Date() })
      .where(and(eq(scheduledDangerousActions.id, id), eq(scheduledDangerousActions.status, 'scheduled'))).returning({ action: scheduledDangerousActions.action, target: scheduledDangerousActions.target });
    return rows[0] ?? null;
  });
  if (!done) return false;
  await notifyOwners(db, mailer, emailEncKey, `[Admin] ${done.action} cancelled`, `Operator ${operator.tailscaleLogin} cancelled "${done.action}" for target ${done.target}.`)
    .catch((err: unknown) => console.error('dangerous-action notification failed', err));
  return true;
}

export async function listDangerous(db: Db, operator: Operator) {
  return withAdmin(db, operator, { action: 'dangerous.list', target: '*' }, (tx) =>
    tx.select().from(scheduledDangerousActions).orderBy(sql`${scheduledDangerousActions.createdAt} desc`).limit(200));
}

/**
 * Runs every booked action whose time has come. Each one is claimed with a conditional UPDATE (scheduled -> executed)
 * inside its own transaction together with the handler, so it runs at most once and a failing handler leaves it scheduled.
 * The audit entry is written under the requesting operator's name.
 */
export async function runDueDangerous(db: Db, handlers: DangerousHandlers, now = new Date()): Promise<number> {
  const due = await withSystem(db, (tx) => tx.select().from(scheduledDangerousActions)
    .where(and(eq(scheduledDangerousActions.status, 'scheduled'), lte(scheduledDangerousActions.executeAfter, now))));
  let ran = 0;
  for (const d of due) {
    const handler = Object.hasOwn(handlers, d.action) ? handlers[d.action] : undefined;
    if (!handler) continue;
    try {
      const ok = await withAdmin(db, { accountId: d.requestedBy }, { action: 'dangerous.execute', target: d.target, detail: { action: d.action, scheduledId: d.id } }, async (tx) => {
        const claimed = await tx.update(scheduledDangerousActions).set({ status: 'executed', executedAt: now })
          .where(and(eq(scheduledDangerousActions.id, d.id), eq(scheduledDangerousActions.status, 'scheduled'))).returning({ id: scheduledDangerousActions.id });
        if (!claimed.length) return false;
        await handler(tx, d.target, d.params as Record<string, unknown>);
        return true;
      });
      if (ok) ran++;
    } catch (err) {
      console.error('dangerous action failed', d.id, err);
    }
  }
  return ran;
}

async function notifyOwners(db: Db, mailer: Mailer, emailEncKey: Buffer, subject: string, text: string): Promise<void> {
  const ids = await listOwnerAccountIds(db);
  if (!ids.length) return;
  const rows = await withSystem(db, (tx) => tx.select({ emailEnc: accounts.emailEnc }).from(accounts).where(inArray(accounts.id, ids)));
  for (const r of rows) await mailer.sendMail(decryptEmail(r.emailEnc, emailEncKey), subject, text);
}
