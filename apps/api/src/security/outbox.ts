import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { securityOutbox } from '../db/schema.js';

export type OutboxKind = (typeof securityOutbox.$inferSelect)['kind'];

/** 事件と同じ transaction で副作用を積む。`effectKey` が同じなら二重に積まない。積んだら true。 */
export async function enqueueOutbox(tx: Tx, e: { incidentId: string; kind: OutboxKind; effectKey: string; payload?: Record<string, string | number | boolean>; now?: Date; priority?: number }): Promise<boolean> {
  const rows = await tx.insert(securityOutbox).values({
    priority: e.priority ?? 0, incidentId: e.incidentId, kind: e.kind, effectKey: e.effectKey, payload: e.payload ?? {}, nextAttemptAt: e.now ?? new Date(),
  }).onConflictDoNothing().returning({ id: securityOutbox.id });
  return rows.length > 0;
}

/** 再試行の間隔: 30 秒から倍々で最大 1 時間。 */
export const backoffMs = (attempts: number): number => Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 3_600_000);

/**
 * 期限の来た未処理の行を 1 件だけ `FOR UPDATE SKIP LOCKED` で取り、`run` の間ロックを持つ（複数 worker が同じ副作用を同時に実行しない）。
 * 成功なら完了、失敗なら試行数・次回時刻・失敗コード（例外の名前だけ。メッセージは保存しない）を更新する。処理したら true。
 */
export async function runNextOutbox(
  tx: Tx, kinds: readonly OutboxKind[], now: Date,
  run: (row: typeof securityOutbox.$inferSelect) => Promise<void>,
  queue?: 'urgent' | 'normal',
): Promise<'done' | 'failed' | null> {
  if (kinds.length === 0) return null;
  const [row] = await tx.select().from(securityOutbox)
    .where(and(isNull(securityOutbox.doneAt), lte(securityOutbox.nextAttemptAt, now), inArray(securityOutbox.kind, [...kinds]), queue === 'urgent' ? gt(securityOutbox.priority, 0) : queue === 'normal' ? lte(securityOutbox.priority, 0) : undefined))
    .orderBy(desc(securityOutbox.priority), asc(securityOutbox.nextAttemptAt), asc(securityOutbox.createdAt)).limit(1).for('update', { skipLocked: true });
  if (!row) return null;
  await tx.execute(sql`savepoint outbox_run`);
  try {
    await run(row);
  } catch (e) {
    await tx.execute(sql`rollback to savepoint outbox_run`);
    const attempts = row.attempts + 1;
    await tx.update(securityOutbox).set({
      attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), failureCode: e instanceof Error && ['Error', 'TypeError', 'RangeError', 'TimeoutError', 'AbortError'].includes(e.name) ? e.name : 'effect_failed',
    }).where(eq(securityOutbox.id, row.id));
    return 'failed';
  }
  await tx.update(securityOutbox).set({ doneAt: now, attempts: row.attempts + 1, failureCode: null }).where(eq(securityOutbox.id, row.id));
  return 'done';
}
