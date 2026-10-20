/** 個人情報 DB（別 DB・別ロール）の構成。ID は本体 DB と共有する UUID だけで、外部キーは張らない。 */
export const PII_ROLES = { admin: 'pii_admin', ingest: 'pii_ingest' } as const;

export const PII_TABLES = ['student_id_blobs', 'verification_reviews'] as const;

export interface StudentIdBlobRow {
  upload_id: string;
  account_id: string;
  ciphertext: Buffer;
  size_bytes: number;
  created_at: Date;
  expires_at: Date;
}

export interface VerificationReviewRow {
  id: string;
  upload_id: string;
  account_id: string;
  operator_id: string;
  result: 'approved' | 'rejected';
  reviewed_at: Date;
}

/** バックアップ対象外のテーブル（暗号文は審査後すぐ消えるため、バックアップに残さない）。DB 側でもテーブルのコメントに目印を付ける。 */
export const PII_BACKUP_EXCLUDED_TABLES = ['student_id_blobs'] as const;
export const PII_BACKUP_EXCLUDE_MARKER = 'backup:exclude';
