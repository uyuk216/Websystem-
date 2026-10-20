import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { assessEligibility, type EligibilityVerdict } from 'shared';
import { decryptEmail } from '../crypto/email.js';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { accounts, studentVerifications, verificationUploads } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import type { IdBlobStore } from './blob-store.js';

/** 付与（Grant）の口。Task 6 の `grantStudent` を渡す。承認と同じトランザクションの中で呼ばれ、失敗したら承認は確定しない。 */
export type GrantStudent = (tx: Tx, accountId: string, validUntil: Date) => Promise<void>;

export interface ReviewDeps {
  store: IdBlobStore;
  grantStudent: GrantStudent;
  mailer?: Mailer;
  emailKey?: Buffer;
  now?: Date;
}

export type ReviewError = 'not_found' | 'not_pending' | 'no_submission' | 'not_enrolled' | 'new_year_doc_required' | 'delete_failed';

export interface PendingReview {
  verificationId: string;
  uploadId: string;
  accountId: string;
  schoolName: string;
  schoolKind: string;
  expectedGraduationYear: number;
  submittedExpiresAt: Date;
  eligibility: EligibilityVerdict;
}

/** 審査待ち（暗号文が届いていて、まだ決まっていない）の一覧。承認画面で「新年度のものか」のチェックを出すかの判定つき。 */
export async function listPendingReviews(db: Db, now: Date = new Date()): Promise<PendingReview[]> {
  const rows = await withSystem(db, (tx) => tx.select({
    verificationId: studentVerifications.id, accountId: studentVerifications.accountId, schoolName: studentVerifications.schoolName,
    schoolKind: studentVerifications.schoolKind, year: studentVerifications.expectedGraduationYear,
    uploadId: verificationUploads.id, expiresAt: verificationUploads.expiresAt, usedAt: verificationUploads.tokenUsedAt,
  }).from(verificationUploads)
    .innerJoin(studentVerifications, eq(studentVerifications.id, verificationUploads.verificationId))
    .where(and(eq(studentVerifications.status, 'pending'), isNotNull(verificationUploads.tokenUsedAt), gt(verificationUploads.expiresAt, now)))
    .orderBy(verificationUploads.tokenUsedAt));
  // 申請ごとに最新の提出だけを出す。
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.verificationId, r);
  return [...latest.values()].map((r) => ({
    verificationId: r.verificationId, uploadId: r.uploadId, accountId: r.accountId, schoolName: r.schoolName, schoolKind: r.schoolKind,
    expectedGraduationYear: r.year, submittedExpiresAt: r.expiresAt, eligibility: assessEligibility(r.year, now),
  }));
}

type Verification = typeof studentVerifications.$inferSelect;
type Upload = typeof verificationUploads.$inferSelect;
type Loaded = { error: 'not_found' | 'not_pending' | 'no_submission' } | { error?: undefined; v: Verification; uploads: Upload[]; reviewed: Upload };

async function loadPending(tx: Tx, verificationId: string): Promise<Loaded> {
  const [v] = await tx.select().from(studentVerifications).where(eq(studentVerifications.id, verificationId)).for('update');
  if (!v) return { error: 'not_found' as const };
  if (v.status !== 'pending') return { error: 'not_pending' as const };
  const uploads = await tx.select().from(verificationUploads).where(eq(verificationUploads.verificationId, verificationId)).orderBy(desc(verificationUploads.tokenUsedAt));
  const used = uploads.find((u) => u.tokenUsedAt);
  if (!used) return { error: 'no_submission' as const };
  return { v, uploads, reviewed: used };
}

async function contactOf(db: Db, accountId: string, emailKey: Buffer): Promise<{ email: string; locale: Locale } | null> {
  const [a] = await withSystem(db, (tx) => tx.select({ emailEnc: accounts.emailEnc, locale: accounts.locale }).from(accounts).where(eq(accounts.id, accountId)));
  return a ? { email: decryptEmail(a.emailEnc, emailKey), locale: a.locale === 'en' ? 'en' : 'ja' } : null;
}

/** 通知メール。送れなくても審査の結果は変えない（ログだけ残す）。 */
export async function notifyAccount(db: Db, deps: Pick<ReviewDeps, 'mailer' | 'emailKey'>, accountId: string, kind: 'approved' | 'rejected' | 'expired', params: Record<string, string> = {}): Promise<void> {
  if (!deps.mailer || !deps.emailKey) return;
  try {
    const c = await contactOf(db, accountId, deps.emailKey);
    if (!c) return;
    await deps.mailer.sendMail(c.email, t(c.locale, `verification.${kind}Subject`), t(c.locale, `verification.${kind}Body`, params));
  } catch (e) {
    console.error('verification mail failed', accountId, e);
  }
}

const dateJa = (d: Date): string => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 承認：status = approved + 有効期限（3/31）+ Student の付与 + 暗号文の削除を 1 つのトランザクションで行う。
 * 暗号文の削除は最後に行い、失敗（または暗号文がない）なら例外でトランザクションごと巻き戻す = 承認は確定しない。
 * 逆に削除のあとでコミットに失敗しても、残るのは「審査待ちのまま暗号文がない」状態で、申請者は再提出できる（画像が残ることはない）。
 */
export async function approveVerification(db: Db, deps: ReviewDeps, args: { verificationId: string; operatorId: string; newFiscalYearDocConfirmed: boolean }): Promise<{ ok: { validUntil: Date } } | { error: ReviewError }> {
  const now = deps.now ?? new Date();
  let result: { ok: { validUntil: Date; accountId: string } } | { error: ReviewError };
  try {
    result = await withSystem(db, async (tx) => {
      const p = await loadPending(tx, args.verificationId);
      if (p.error) return { error: p.error };
      const { v, uploads, reviewed } = p;
      const verdict = assessEligibility(v.expectedGraduationYear, now);
      if (!verdict.enrolled) return { error: 'not_enrolled' as const };
      if (verdict.requiresNewFiscalYearDoc && !args.newFiscalYearDocConfirmed) return { error: 'new_year_doc_required' as const };
      await tx.update(studentVerifications).set({ status: 'approved', validUntil: verdict.validUntil, reviewedAt: now, rejectReason: null }).where(eq(studentVerifications.id, v.id));
      await deps.grantStudent(tx, v.accountId, verdict.validUntil);
      await tx.update(verificationUploads).set({ blobRef: null }).where(eq(verificationUploads.verificationId, v.id));
      try {
        await deps.store.finalizeReview({ uploadId: reviewed.id, accountId: v.accountId, operatorId: args.operatorId, result: 'approved', deleteUploadIds: uploads.map((u) => u.id) });
      } catch (e) {
        console.error('verification approve: ciphertext deletion failed', v.id, e);
        throw new DeleteFailed();
      }
      return { ok: { validUntil: verdict.validUntil, accountId: v.accountId } };
    });
  } catch (e) {
    if (e instanceof DeleteFailed) return { error: 'delete_failed' };
    throw e;
  }
  if ('error' in result) return result;
  await notifyAccount(db, deps, result.ok.accountId, 'approved', { validUntil: dateJa(result.ok.validUntil) });
  return { ok: { validUntil: result.ok.validUntil } };
}

class DeleteFailed extends Error {}

/** 差し戻し：理由を通知し、暗号文を削除する（再提出できる）。削除に失敗したら差し戻しも確定させない。 */
export async function rejectVerification(db: Db, deps: ReviewDeps, args: { verificationId: string; operatorId: string; reason: string }): Promise<{ ok: true } | { error: ReviewError | 'reason_required' }> {
  const reason = args.reason.trim();
  if (reason.length < 1 || reason.length > 500) return { error: 'reason_required' };
  const now = deps.now ?? new Date();
  let accountId: string;
  try {
    const r = await withSystem(db, async (tx) => {
      const p = await loadPending(tx, args.verificationId);
      if (p.error) return { error: p.error };
      const { v, uploads, reviewed } = p;
      await tx.update(studentVerifications).set({ status: 'rejected', rejectReason: reason, reviewedAt: now }).where(eq(studentVerifications.id, v.id));
      await tx.update(verificationUploads).set({ blobRef: null }).where(eq(verificationUploads.verificationId, v.id));
      try {
        await deps.store.finalizeReview({ uploadId: reviewed.id, accountId: v.accountId, operatorId: args.operatorId, result: 'rejected', deleteUploadIds: uploads.map((u) => u.id) });
      } catch (e) {
        console.error('verification reject: ciphertext deletion failed', v.id, e);
        throw new DeleteFailed();
      }
      return { accountId: v.accountId };
    });
    if (r.error) return { error: r.error };
    accountId = r.accountId;
  } catch (e) {
    if (e instanceof DeleteFailed) return { error: 'delete_failed' };
    throw e;
  }
  await notifyAccount(db, deps, accountId, 'rejected', { reason });
  return { ok: true };
}
