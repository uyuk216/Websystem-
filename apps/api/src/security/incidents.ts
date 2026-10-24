import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { maxSeverity, planFor, severityRank } from 'shared';
import type { SecuritySignal, Severity } from 'shared';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { accounts, apps, securityAudit, securityBlocks, securityIncidents } from '../db/schema.js';
import { reconcileAccountSecurity } from './reconcile.js';
import { enqueueOutbox } from './outbox.js';
import { assertValidSignal, SignalRejected } from './signals.js';

export interface SignalResult {
  incidentId: string;
  /** 同じ (source, sourceEventId) を既に受けていて、重大度も上がらなかった。何も変えていない。 */
  duplicate: boolean;
  escalated: boolean;
  severity: Severity;
  /** この呼び出しで新しく作ったブロック理由。 */
  blockCreated: boolean;
}

/** 追記専用のシステム監査連鎖へ 1 行足す。呼び出しの transaction 内で書くので、失敗すれば事件ごと rollback する。 */
export async function appendSecurityAudit(tx: Tx, incidentId: string, action: string, detail: Record<string, string | number | boolean>): Promise<void> {
  const [row] = await tx.insert(securityAudit).values({ seq: 0, /* trigger が決める */ incidentId, action, detail }).returning({ seq: securityAudit.seq });
  await enqueueOutbox(tx, { incidentId, kind: 'deliver_audit', effectKey: `deliver_audit:${row!.seq}`, payload: { seq: row!.seq } });
}

/** 連鎖が壊れていれば最初の seq、正しければ null。 */
export async function verifySecurityAudit(db: Db): Promise<number | null> {
  const rows = await db.execute<{ bad: string | null }>(sql`select security_audit_verify() as bad`);
  const bad = rows[0]?.bad;
  return bad === null || bad === undefined ? null : Number(bad);
}

/** 送信者が名乗った対象を、実際の記録と照合する（実在しない・オーナーが違う対象は拒否）。 */
async function assertTrustedTarget(tx: Tx, t: SecuritySignal['target']): Promise<void> {
  if (t.kind === 'app') {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, t.appId)).for('update');
    if (!a || (t.ownerId !== undefined && t.ownerId !== a.ownerId)) throw new SignalRejected('untrusted_target');
  } else if (t.kind === 'account') {
    const [a] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, t.accountId)).for('update');
    if (!a) throw new SignalRejected('untrusted_target');
  }
}

/**
 * 自動対処を決める**唯一**の入口。高 = アプリ遮断 + コンテナ停止、中 = アプリ遮断、低 = 運営通知のみ。
 * 事件・ブロック理由・outbox・システム監査を 1 transaction で確定する（どれかが失敗すれば全部戻る）。
 * (source, sourceEventId) の重複は何もしない。同じ事件の重大度が上がったときだけ対処を強める。
 * ここから既存のブロックを解除することは無い（低い判定が高い判定を弱めない）。
 */
export async function handleSecuritySignal(db: Db, signal: SecuritySignal, opts: { now?: Date } = {}): Promise<SignalResult> {
  assertValidSignal(signal);
  const now = opts.now ?? new Date();
  return withSystem(db, async (tx) => {
    await assertTrustedTarget(tx, signal.target);
    const t = signal.target;
    const ids = { appId: t.kind === 'app' ? t.appId : null, accountId: t.kind === 'account' ? t.accountId : null, ipHash: t.kind === 'ip' ? t.ipHash : null };
    const [created] = await tx.insert(securityIncidents).values({
      source: signal.source, sourceEventId: signal.sourceEventId, ruleVersion: signal.ruleVersion, severity: signal.severity,
      targetKind: t.kind, ...ids, reasonCode: signal.reasonCode, evidence: signal.evidence, evidenceDigest: signal.evidenceDigest,
      occurredAt: signal.occurredAt, updatedAt: now,
    }).onConflictDoNothing().returning();

    let incident = created;
    let escalated = false;
    if (!incident) {
      // 先に入れた transaction の commit を待ってここへ来る。行を掴んで重大度を比べる（同時の昇格は直列になる）。
      const [existing] = await tx.select().from(securityIncidents)
        .where(and(eq(securityIncidents.source, signal.source), eq(securityIncidents.sourceEventId, signal.sourceEventId))).for('update');
      if (!existing) throw new Error('security incident vanished');
      if (existing.targetKind !== t.kind || existing.appId !== ids.appId || existing.accountId !== ids.accountId || existing.ipHash !== ids.ipHash || existing.reasonCode !== signal.reasonCode) {
        throw new SignalRejected('untrusted_target');
      }
      if (severityRank(signal.severity) <= severityRank(existing.severity)) {
        return { incidentId: existing.id, duplicate: true, escalated: false, severity: existing.severity, blockCreated: false };
      }
      const severity = maxSeverity(existing.severity, signal.severity);
      [incident] = await tx.update(securityIncidents).set({ severity, status: 'open', updatedAt: now, ruleVersion: signal.ruleVersion, evidence: signal.evidence, evidenceDigest: signal.evidenceDigest }).where(eq(securityIncidents.id, existing.id)).returning();
      escalated = true;
    }
    if (!incident) throw new Error('security incident missing');

    const plan = planFor(incident.severity, incident.targetKind);
    await appendSecurityAudit(tx, incident.id, escalated ? 'incident.escalated' : 'incident.recorded', {
      source: incident.source, ruleVersion: incident.ruleVersion, severity: incident.severity, targetKind: incident.targetKind,
      reasonCode: incident.reasonCode, evidenceDigest: incident.evidenceDigest,
    });

    let blockCreated = false;
    if (plan.block) {
      // 事件ごと・理由ごとに有効なブロックは 1 行（部分一意索引）。既にあれば足さない。
      const rows = await tx.insert(securityBlocks).values({
        incidentId: incident.id, targetKind: incident.targetKind, appId: incident.appId, accountId: incident.accountId,
        ipHash: incident.ipHash, reasonCode: incident.reasonCode, createdAt: now,
      }).onConflictDoNothing().returning({ id: securityBlocks.id });
      blockCreated = rows.length > 0;
      if (blockCreated) {
        await appendSecurityAudit(tx, incident.id, 'block.created', { targetKind: incident.targetKind, reasonCode: incident.reasonCode });
        // commit されたときに、各 edge へ「再照合して」と知らせる（中身は無い。取りこぼしても定期の再照合が拾う）。
        await tx.execute(sql`select pg_notify('security_block', '')`);
      }
    }
    if (incident.accountId) await reconcileAccountSecurity(tx as unknown as Db, incident.accountId);
    if (plan.stopContainer && incident.appId) {
      await enqueueOutbox(tx, { incidentId: incident.id, kind: 'stop_app', effectKey: `stop_app:${incident.id}`, payload: { appId: incident.appId }, now });
    }
    if (plan.notifyOperator) {
      await enqueueOutbox(tx, { incidentId: incident.id, kind: 'notify_operator', effectKey: `notify_operator:${incident.id}:${incident.severity}`, payload: { severity: incident.severity }, priority: incident.source === 'honeytoken' ? 100 : 0, now });
    }
    if (incident.targetKind !== 'ip' && incident.severity !== 'low') await enqueueOutbox(tx, { incidentId: incident.id, kind: 'notify_owner', effectKey: `notify_owner:${incident.id}:${incident.severity}`, priority: incident.source === 'honeytoken' ? 100 : 0, now });
    return { incidentId: incident.id, duplicate: false, escalated, severity: incident.severity, blockCreated };
  });
}

export interface BlockQuery { appId?: string; accountId?: string; ipHash?: string }

/** 有効なブロック理由（解除されていないもの）。指定した対象のどれかに当たる行。何も指定しなければ空。 */
export async function activeBlocks(db: Db | Tx, q: BlockQuery) {
  const conds = [
    q.appId ? and(eq(securityBlocks.targetKind, 'app'), eq(securityBlocks.appId, q.appId)) : undefined,
    q.accountId ? and(eq(securityBlocks.targetKind, 'account'), eq(securityBlocks.accountId, q.accountId)) : undefined,
    q.ipHash ? and(eq(securityBlocks.targetKind, 'ip'), eq(securityBlocks.ipHash, q.ipHash)) : undefined,
  ].filter((c) => c !== undefined);
  if (conds.length === 0) return [];
  return withSystem(db, (tx) => tx.select().from(securityBlocks).where(and(isNull(securityBlocks.releasedAt), or(...conds))));
}
