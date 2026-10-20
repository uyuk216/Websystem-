/**
 * 暗号文を消す側の窓口（実体は platform の `createIdBlobStore`。接続はワーカー／管理画面のサーバー側だけが持つ）。
 * apps/api はこの形だけを知っていて、保管先の DB には接続しない。
 */
export interface IdBlobStore {
  /** 審査の記録を追記し、暗号文を削除する。失敗したら throw。 */
  finalizeReview(input: {
    uploadId: string;
    accountId: string;
    operatorId: string;
    result: 'approved' | 'rejected';
    deleteUploadIds: string[];
  }): Promise<number>;
  deleteBlobs(uploadIds: string[]): Promise<number>;
  listBlobs(): Promise<{ uploadId: string; accountId: string; createdAt: Date; expiresAt: Date }[]>;
}
