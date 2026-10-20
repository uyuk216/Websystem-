import { and, eq, inArray, isNotNull, isNull, lte, lt } from 'drizzle-orm';
import { withSystem, type Db } from '../db/client.js';
import { studentVerifications, verificationUploads } from '../db/schema.js';
import type { IdBlobStore } from './blob-store.js';
export type { IdBlobStore };
import { notifyAccount, type ReviewDeps } from './review.js';

export interface PurgeResult {
  /** 期限（提出から 7 日）切れで expired にした申請。 */
  expired: number;
  /** 暗号文の側で期限が切れていた、または本体 DB から見て孤児だった暗号文。 */
  blobsDeleted: number;
  /** 使われないまま期限切れのトークンの行。 */
  staleUploads: number;
}

const ORPHAN_GRACE_MS = 60 * 60_000;

/**
 * 毎時の掃除（ワーカーの `verification.purge`）。
 * 1. 提出から 7 日以内に審査されなかった申請を expired にし、暗号文を削除して再提出のメールを送る。
 *    削除に失敗した申請は expired にしない（次回に再試行する）。
 * 2. 暗号文の DB に残っている孤児（承認済み・差し戻し済み・期限切れなのに残っている／本体 DB に提出の行がない／暗号文自身の期限切れ）を削除する。
 * 3. 使われないまま期限が切れた提出トークンの行を消す。
 */
export async function purgeVerifications(db: Db, deps: Pick<ReviewDeps, 'mailer' | 'emailKey'> & { store: IdBlobStore }, now: Date = new Date()): Promise<PurgeResult> {
  let expired = 0;
  let blobsDeleted = 0;

  // 1. 期限切れの申請
  const due = await withSystem(db, (tx) => tx.select({ verificationId: verificationUploads.verificationId, accountId: studentVerifications.accountId })
    .from(verificationUploads)
    .innerJoin(studentVerifications, eq(studentVerifications.id, verificationUploads.verificationId))
    .where(and(eq(studentVerifications.status, 'pending'), isNotNull(verificationUploads.tokenUsedAt), lte(verificationUploads.expiresAt, now))));
  const dueIds = [...new Map(due.map((d) => [d.verificationId, d.accountId])).entries()];
  for (const [verificationId, accountId] of dueIds) {
    try {
      const done = await withSystem(db, async (tx) => {
        const [v] = await tx.update(studentVerifications).set({ status: 'expired', reviewedAt: now })
          .where(and(eq(studentVerifications.id, verificationId), eq(studentVerifications.status, 'pending'))).returning({ id: studentVerifications.id });
        if (!v) return false;
        const uploads = await tx.select({ id: verificationUploads.id }).from(verificationUploads).where(eq(verificationUploads.verificationId, verificationId));
        await tx.update(verificationUploads).set({ blobRef: null }).where(eq(verificationUploads.verificationId, verificationId));
        // 削除は最後。失敗したら例外でこの申請の expired も巻き戻る。
        blobsDeleted += await deps.store.deleteBlobs(uploads.map((u) => u.id));
        return true;
      });
      if (done) {
        expired++;
        await notifyAccount(db, deps, accountId, 'expired');
      }
    } catch (e) {
      console.error('verification purge: expiry failed', verificationId, e);
    }
  }

  // 2. 孤児の暗号文
  const blobs = await deps.store.listBlobs();
  if (blobs.length > 0) {
    const rows = await withSystem(db, (tx) => tx.select({ uploadId: verificationUploads.id, status: studentVerifications.status })
      .from(verificationUploads)
      .innerJoin(studentVerifications, eq(studentVerifications.id, verificationUploads.verificationId))
      .where(inArray(verificationUploads.id, blobs.map((b) => b.uploadId))));
    const status = new Map(rows.map((r) => [r.uploadId, r.status]));
    const orphans = blobs.filter((b) => {
      if (b.expiresAt <= now) return true;
      const s = status.get(b.uploadId);
      if (s === undefined) return now.getTime() - b.createdAt.getTime() > ORPHAN_GRACE_MS;
      return s !== 'pending';
    }).map((b) => b.uploadId);
    if (orphans.length > 0) blobsDeleted += await deps.store.deleteBlobs(orphans);
  }

  const staleUploads = await purgeStaleUploads(db, now);

  return { expired, blobsDeleted, staleUploads };
}

/** 使われないまま期限が切れた提出トークンの行を消す（本体 DB だけで完結する）。 */
export async function purgeStaleUploads(db: Db, now: Date = new Date()): Promise<number> {
  const stale = await withSystem(db, (tx) => tx.delete(verificationUploads)
    .where(and(isNull(verificationUploads.tokenUsedAt), lt(verificationUploads.tokenExpiresAt, now))).returning({ id: verificationUploads.id }));
  return stale.length;
}
