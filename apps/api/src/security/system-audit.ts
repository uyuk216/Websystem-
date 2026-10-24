import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { AuditConflictError, type AuditStorage } from 'platform';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { adminAuditLog, auditDeliveries, securityAudit } from '../db/schema.js';
import { verifyAuditChain } from '../admin/audit-log.js';
import type { OutboxHandlers } from './actions.js';
import {
  GENESIS, adminBatchRow, buildBatch, buildCheckpoint, canonicalJson, checkpointKey, parseJson, sha256, systemBatchRow,
  type AuditBatch, type AuditStream, type BatchRow, type Checkpoint,
} from './audit-export.js';
import { verifySecurityAudit } from './incidents.js';
import type { PublicationPolicy } from './safe-browsing.js';

export interface AuditDeps {
  storage: AuditStorage;
  /** 保持期間（COMPLIANCE の retain-until = 事件行の作成時刻 + これ）。未承認のうちは設定されない。 */
  retentionMs: number;
  batchSize?: number;
  now?: () => Date;
}
const nowOf = (d: AuditDeps): Date => (d.now ?? (() => new Date()))();

async function loadRows(tx: Tx, stream: AuditStream, from: number, to: number): Promise<BatchRow[]> {
  if (stream === 'security') {
    const rows = await tx.select().from(securityAudit).where(and(gte(securityAudit.seq, from), lte(securityAudit.seq, to))).orderBy(asc(securityAudit.seq));
    return rows.map((r) => systemBatchRow({ ...r, detail: r.detail as Record<string, unknown> }));
  }
  const rows = await tx.select().from(adminAuditLog).where(and(gte(adminAuditLog.seq, from), lte(adminAuditLog.seq, to))).orderBy(asc(adminAuditLog.seq));
  return rows.map((r) => adminBatchRow({ ...r, detail: r.detail as Record<string, unknown> }));
}
type Delivery = typeof auditDeliveries.$inferSelect;

/** 次に配送すべき範囲を確定する。直列化（advisory lock）し、前回途中の範囲があればそれを固定のまま使う（batch ID と digest を変えない）。 */
async function planNext(db: Db, stream: AuditStream, deps: AuditDeps): Promise<Delivery | null | 'busy'> {
  return withSystem(db, async (tx) => {
    const got = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${'audit_export:' + stream})) as ok`);
    if (!got[0]?.ok) return 'busy' as const;
    const [open] = await tx.select().from(auditDeliveries).where(and(eq(auditDeliveries.stream, stream), isNull(auditDeliveries.deliveredAt))).orderBy(asc(auditDeliveries.fromSeq)).limit(1);
    if (open) return open;
    const [last] = await tx.select().from(auditDeliveries).where(and(eq(auditDeliveries.stream, stream), isNotNull(auditDeliveries.deliveredAt))).orderBy(desc(auditDeliveries.toSeq)).limit(1);
    const from = (last?.toSeq ?? 0) + 1;
    const rows = await loadRows(tx, stream, from, from + (deps.batchSize ?? 200) - 1);
    if (rows.length === 0) return null;
    if (rows[0]!.seq !== from) throw new Error('audit_gap'); // 欠番：先へ進めず運営へ知らせる
    const b = buildBatch(stream, rows, last?.digest ?? GENESIS);
    const [created] = await tx.insert(auditDeliveries).values({ stream, fromSeq: b.batch.fromSeq, toSeq: b.batch.toSeq, prevBatchDigest: b.batch.prevBatchDigest, digest: b.digest, objectKey: b.key }).returning();
    return created!;
  });
}

async function recordFailure(db: Db, id: string, code: string): Promise<void> {
  await withSystem(db, (tx) => tx.update(auditDeliveries).set({ attempts: sql`${auditDeliveries.attempts} + 1`, failureCode: code }).where(eq(auditDeliveries.id, id)));
}
const codeOf = (e: unknown): string => (e instanceof AuditConflictError ? 'conflict' : e instanceof Error && /^[a-z_]{3,40}$/.test(e.message) ? e.message : e instanceof Error ? e.name : 'delivery_failed');

/** 範囲 1 つを Object Lock に送り、版と保持を確認し、checkpoint も同様に送って確認する。冪等（応答喪失・二重 worker・crash 後の再実行）。 */
async function deliver(db: Db, d: Delivery, deps: AuditDeps): Promise<void> {
  const storage = deps.storage;
  const retainUntil = d.createdAt.getTime() + deps.retentionMs;
  const rows = await withSystem(db, (tx) => loadRows(tx, d.stream, d.fromSeq, d.toSeq));
  const b = buildBatch(d.stream, rows, d.prevBatchDigest);
  if (b.digest !== d.digest || b.key !== d.objectKey) throw new Error('audit_changed'); // 配送前に DB の行が変わった
  const ref = await storage.append(b.key, b.body, b.digest, retainUntil);
  const ret = await storage.verifyRetention(b.key, ref.versionId);
  if (!ret || ret.mode !== 'COMPLIANCE' || ret.retainUntil < retainUntil - 60_000) throw new Error('retention_failed');
  const back = await storage.readVersion(b.key, ref.versionId);
  if (!back || sha256(back) !== b.digest) throw new Error('readback_failed');
  const cp = buildCheckpoint(b.batch, b.key, b.digest, ref.versionId, d.createdAt);
  const cref = await storage.append(cp.key, cp.body, cp.digest, retainUntil);
  const cret = await storage.verifyRetention(cp.key, cref.versionId);
  if (!cret || cret.mode !== 'COMPLIANCE' || cret.retainUntil < retainUntil - 60_000) throw new Error('retention_failed');
  await withSystem(db, (tx) => tx.update(auditDeliveries).set({ objectVersion: ref.versionId, retainUntil: new Date(ret.retainUntil), checkpointVersion: cref.versionId, deliveredAt: nowOf(deps), failureCode: null })
    .where(and(eq(auditDeliveries.id, d.id), isNull(auditDeliveries.deliveredAt))));
}

/** 1 本の stream を未配送がなくなるまで（最大 `maxBatches` 本）配送する。S3 障害でも DB 側の防御と outbox は影響を受けない（例外で再試行に回る）。 */
export async function exportAuditStream(db: Db, stream: AuditStream, deps: AuditDeps, maxBatches = 20): Promise<{ delivered: number; busy: boolean }> {
  if (!deps.storage.installed) throw new Error('not_installed');
  let delivered = 0;
  for (let i = 0; i < maxBatches; i++) {
    const plan = await planNext(db, stream, deps);
    if (plan === 'busy') return { delivered, busy: true };
    if (plan === null) return { delivered, busy: false };
    try { await deliver(db, plan, deps); } catch (e) { await recordFailure(db, plan.id, codeOf(e)); throw e; }
    delivered++;
  }
  return { delivered, busy: false };
}

export async function deliveredThrough(db: Db, stream: AuditStream): Promise<number> {
  const [r] = await withSystem(db, (tx) => tx.select({ to: auditDeliveries.toSeq }).from(auditDeliveries).where(and(eq(auditDeliveries.stream, stream), isNotNull(auditDeliveries.deliveredAt))).orderBy(desc(auditDeliveries.toSeq)).limit(1));
  return r?.to ?? 0;
}

/** outbox `deliver_audit`：その seq が Object Lock に載るまで配送する。載らなければ例外＝outbox の再試行（配送済みの偽装はしない）。 */
export function auditDeliveryHandlers(db: Db, deps: AuditDeps): OutboxHandlers {
  return {
    deliver_audit: async (payload) => {
      const seq = payload.seq;
      if (typeof seq !== 'number') throw new TypeError('deliver_audit payload without seq');
      for (let i = 0; i < 20 && (await deliveredThrough(db, 'security')) < seq; i++) {
        const r = await exportAuditStream(db, 'security', deps, 5);
        if (r.busy) throw new Error('export_busy');
      }
      if ((await deliveredThrough(db, 'security')) < seq) throw new Error('not_delivered');
    },
  };
}

export interface WormVerification { ok: boolean; issues: string[]; checkpointSeq: number; dbHeadSeq: number; undelivered: number }

/**
 * 独立した読み取り用の AuditStorage で、Object Lock 側の checkpoint と DB を突き合わせる。
 * 行の改ざん・欠番・末尾切り捨て・古い DB への復元・版の取り違え・保持違反を検知する。DB 内の連鎖が通るだけでは「配送済み」と見なさない。
 */
export async function verifyAgainstWorm(db: Db, stream: AuditStream, reader: AuditStorage): Promise<WormVerification> {
  const issues: string[] = [];
  const bad = stream === 'security' ? await verifySecurityAudit(db) : await verifyAuditChain(db);
  if (bad !== null) issues.push(`db_chain_broken:${bad}`);
  const dbHead = await withSystem(db, async (tx) => {
    const t = stream === 'security' ? securityAudit : adminAuditLog;
    const [h] = await tx.select({ seq: t.seq, hash: t.hash }).from(t).orderBy(desc(t.seq)).limit(1);
    return h ?? null;
  });
  const dbHeadSeq = dbHead?.seq ?? 0;
  if (!reader.installed) return { ok: false, issues: [...issues, 'not_installed'], checkpointSeq: 0, dbHeadSeq, undelivered: dbHeadSeq };
  const oldest = async (key: string): Promise<{ body: Uint8Array; versionId: string } | null> => {
    const vs = await reader.versions(key);
    if (vs.length === 0) return null;
    if (vs.length > 1) issues.push(`extra_version:${key}`);
    const body = await reader.readVersion(key, vs[0]!);
    return body ? { body, versionId: vs[0]! } : null;
  };
  const cpKeys = await reader.list(`${stream}/checkpoints/`);
  let checkpointSeq = 0;
  if (cpKeys.length === 0) {
    if (dbHeadSeq > 0) issues.push('no_checkpoint');
    return { ok: issues.length === 0, issues, checkpointSeq, dbHeadSeq, undelivered: dbHeadSeq };
  }
  const latest = await oldest(cpKeys.at(-1)!);
  if (!latest) issues.push('checkpoint_unreadable');
  const cp = latest ? parseJson<Checkpoint>(latest.body) : null;
  if (cp) {
    checkpointSeq = cp.headSeq;
    if (cpKeys.at(-1) !== checkpointKey(stream, cp.headSeq)) issues.push('checkpoint_key_mismatch');
    if (dbHeadSeq < cp.headSeq) issues.push('db_behind_checkpoint'); // 末尾切り捨て、または古い DB への復元
    else {
      const row = await withSystem(db, (tx) => loadRows(tx, stream, cp.headSeq, cp.headSeq));
      if (row[0]?.hash !== cp.headHash) issues.push('head_hash_mismatch');
    }
  }
  // 全 batch を最古の版から読み、連続性・前 digest・各行の hash と匿名 payload を DB と照合する。
  const batchKeys = await reader.list(`${stream}/batches/`);
  let prevTo = 0; let prevDigest = GENESIS; let lastTo = 0;
  for (const key of batchKeys) {
    const got = await oldest(key);
    if (!got) { issues.push(`batch_unreadable:${key}`); continue; }
    const digest = sha256(got.body);
    const batch = parseJson<AuditBatch>(got.body);
    if (canonicalJson(batch) !== new TextDecoder().decode(got.body)) issues.push(`batch_not_canonical:${key}`);
    if (batch.fromSeq !== prevTo + 1) issues.push(`gap_before:${batch.fromSeq}`);
    if (batch.prevBatchDigest !== prevDigest) issues.push(`prev_digest_mismatch:${batch.fromSeq}`);
    const ret = await reader.verifyRetention(key, got.versionId);
    if (!ret || ret.mode !== 'COMPLIANCE') issues.push(`retention_invalid:${key}`);
    if (dbHeadSeq >= batch.toSeq) {
      const rows = await withSystem(db, (tx) => loadRows(tx, stream, batch.fromSeq, batch.toSeq));
      if (canonicalJson(rows) !== canonicalJson(batch.rows)) issues.push(`row_mismatch:${batch.fromSeq}-${batch.toSeq}`);
    }
    prevTo = batch.toSeq; prevDigest = digest; lastTo = batch.toSeq;
  }
  if (cp && (lastTo !== cp.headSeq || prevDigest !== cp.batchDigest)) issues.push('checkpoint_batch_mismatch');
  const rec = await withSystem(db, (tx) => tx.select().from(auditDeliveries).where(and(eq(auditDeliveries.stream, stream), isNotNull(auditDeliveries.deliveredAt))));
  for (const r of rec) { const vs = await reader.versions(r.objectKey); if (vs[0] !== r.objectVersion) issues.push(`version_mismatch:${r.fromSeq}`); }
  return { ok: issues.length === 0, issues, checkpointSeq, dbHeadSeq, undelivered: Math.max(dbHeadSeq - checkpointSeq, 0) };
}

export interface AuditDeliveryStatus {
  state: 'not_installed' | 'ok' | 'delayed' | 'critical';
  lastDeliveredAt: string | null; undelivered: number; oldestUndeliveredAgeMs: number | null; failureCodes: string[];
}
export interface AuditStatusOptions { delayMs?: number; criticalUndelivered?: number }
export async function auditDeliveryStatus(db: Db, stream: AuditStream, deps: Pick<AuditDeps, 'storage' | 'now'>, o: AuditStatusOptions = {}): Promise<AuditDeliveryStatus> {
  const now = nowOf(deps as AuditDeps);
  return withSystem(db, async (tx) => {
    const [last] = await tx.select().from(auditDeliveries).where(and(eq(auditDeliveries.stream, stream), isNotNull(auditDeliveries.deliveredAt))).orderBy(desc(auditDeliveries.toSeq)).limit(1);
    const t = stream === 'security' ? securityAudit : adminAuditLog;
    const pending = await tx.select({ seq: t.seq, createdAt: t.createdAt }).from(t).where(gte(t.seq, (last?.toSeq ?? 0) + 1)).orderBy(asc(t.seq));
    const failures = await tx.select({ code: auditDeliveries.failureCode }).from(auditDeliveries).where(and(eq(auditDeliveries.stream, stream), isNull(auditDeliveries.deliveredAt), isNotNull(auditDeliveries.failureCode)));
    const age = pending[0] ? now.getTime() - pending[0].createdAt.getTime() : null;
    const undelivered = pending.length;
    const state: AuditDeliveryStatus['state'] = !deps.storage.installed ? 'not_installed'
      : o.criticalUndelivered && undelivered >= o.criticalUndelivered ? 'critical'
      : (age !== null && age > (o.delayMs ?? 15 * 60_000)) || failures.length > 0 ? 'delayed' : 'ok';
    return { state, lastDeliveredAt: last?.deliveredAt?.toISOString() ?? null, undelivered, oldestUndeliveredAgeMs: age, failureCodes: [...new Set(failures.map((f) => f.code!))] };
  });
}

/** 配送遅延・未配送数・保持/読み戻し失敗を運営へ通知する（通知の送り口は注入）。未導入のときは通知せず状態だけが not_installed になる。 */
export async function alertAuditHealth(db: Db, stream: AuditStream, deps: Pick<AuditDeps, 'storage' | 'now'>, alerts: { notify(codes: string[]): Promise<void> }, o: AuditStatusOptions = {}): Promise<AuditDeliveryStatus> {
  const s = await auditDeliveryStatus(db, stream, deps, o);
  const codes: string[] = [];
  if (s.state === 'delayed' || s.state === 'critical') codes.push(`audit.${stream}.delivery_delayed`);
  if (s.state === 'critical') codes.push(`audit.${stream}.backlog_critical`);
  if (s.failureCodes.some((c) => c === 'retention_failed' || c === 'readback_failed' || c === 'conflict' || c === 'audit_changed')) codes.push(`audit.${stream}.retention_or_integrity_failed`);
  if (codes.length) await alerts.notify(codes);
  return s;
}

/** 配送がたまりすぎたか（導入済みで上限が設定されたときだけ true）。新規公開と管理変更を保留し、既存の遮断は維持する。 */
export async function auditBacklogHeld(db: Db, deps: Pick<AuditDeps, 'storage' | 'now'>, maxUndelivered: number): Promise<boolean> {
  if (!deps.storage.installed || maxUndelivered <= 0) return false;
  return (await auditDeliveryStatus(db, 'security', deps, { criticalUndelivered: maxUndelivered })).state === 'critical';
}

/** 公開判定の前段：配送がたまっている間は新規公開・ロールバックを保留（'pending'）にする。既存の公開バージョンと遮断はそのまま。 */
export function withAuditHold(policy: PublicationPolicy, isHeld: () => Promise<boolean>): PublicationPolicy {
  return { installed: policy.installed, async check(appId) { return (await isHeld().catch(() => false)) ? 'pending' : policy.check(appId); } };
}
