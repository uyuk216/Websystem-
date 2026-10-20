import type { PiiSql } from './pool.js';

export interface BlobMeta {
  uploadId: string;
  accountId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface FinalizeReviewInput {
  /** 審査した提出。審査の記録はこの ID で残す。 */
  uploadId: string;
  accountId: string;
  operatorId: string;
  result: 'approved' | 'rejected';
  /** 同じ申請に属する、消す暗号文（審査した提出を含む）。 */
  deleteUploadIds: string[];
}

/**
 * 暗号文の削除側（pii_admin 接続で使う）。削除と審査の記録は同じトランザクション。
 * 暗号文そのものは読み出さない（メタデータだけ）。復号は管理画面の別経路。
 */
export interface IdBlobStore {
  /** 審査の記録を追記し、暗号文を削除する。失敗したら throw（呼び出し側は承認を確定させない）。消した件数を返す。 */
  finalizeReview(input: FinalizeReviewInput): Promise<number>;
  deleteBlobs(uploadIds: string[]): Promise<number>;
  listBlobs(): Promise<BlobMeta[]>;
}

export function createIdBlobStore(sql: PiiSql): IdBlobStore {
  return {
    async finalizeReview(input) {
      return sql.begin(async (tx) => {
        await tx`INSERT INTO verification_reviews (upload_id, account_id, operator_id, result)
                 VALUES (${input.uploadId}, ${input.accountId}, ${input.operatorId}, ${input.result})`;
        const rows = await tx`DELETE FROM student_id_blobs WHERE upload_id = ANY(${input.deleteUploadIds}::uuid[]) RETURNING upload_id`;
        // 承認なのに暗号文がない（すでに消えた）場合は記録ごと巻き戻し、承認させない。
        if (input.result === 'approved' && rows.length === 0) throw new Error('ciphertext not found');
        return rows.length;
      });
    },
    async deleteBlobs(uploadIds) {
      if (uploadIds.length === 0) return 0;
      const rows = await sql`DELETE FROM student_id_blobs WHERE upload_id = ANY(${uploadIds}::uuid[]) RETURNING upload_id`;
      return rows.length;
    },
    async listBlobs() {
      const rows = await sql`SELECT upload_id, account_id, created_at, expires_at FROM student_id_blobs`;
      return rows.map((r) => ({ uploadId: r.upload_id as string, accountId: r.account_id as string, createdAt: r.created_at as Date, expiresAt: r.expires_at as Date }));
    },
  };
}
