import { and, eq, isNull, sql } from 'drizzle-orm';
import { suspendDateFor } from 'shared';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { grants } from '../db/schema.js';

/**
 * Student の付与。アカウント宛てで、同じアカウントに有効な Student は 1 つだけ（再登録は期限の更新）。
 * 有効期限 `validUntil`（3/31）と停止日（その年の 5/1 JST）は shared の日付ヘルパーで決める。
 * 学生証の承認と同じトランザクション（`tx`）の中で呼ぶ。失敗したら承認ごと巻き戻る。
 */
export async function grantStudent(tx: Tx | Db, accountId: string, validUntil: Date, opts: { approvedBy?: string; reason?: string; startsAt?: Date } = {}): Promise<void> {
  const startsAt = opts.startsAt ?? new Date();
  const values = {
    targetKind: 'account' as const, targetId: accountId, kind: 'student' as const, params: {}, startsAt, endsAt: validUntil,
    suspendOn: suspendDateFor(validUntil), reason: opts.reason ?? 'student verification', approvedBy: opts.approvedBy ?? 'system',
  };
  await withSystem(tx, (t) => t.insert(grants).values(values).onConflictDoUpdate({
    target: [grants.targetKind, grants.targetId],
    targetWhere: sql`${grants.kind} = 'student' AND ${grants.revokedAt} IS NULL`,
    set: { startsAt: sql`least(${grants.startsAt}, excluded.starts_at)`, endsAt: values.endsAt, suspendOn: values.suspendOn, reason: values.reason, approvedBy: values.approvedBy },
  }));
}

/** 付与の取り消し（以後 `resolveEntitlements` に出ない）。すでに取り消されていれば false。 */
export async function revokeGrant(db: Db | Tx, grantId: string, at: Date = new Date()): Promise<boolean> {
  const r = await withSystem(db, (tx) => tx.update(grants).set({ revokedAt: at }).where(and(eq(grants.id, grantId), isNull(grants.revokedAt))).returning({ id: grants.id }));
  return r.length > 0;
}
