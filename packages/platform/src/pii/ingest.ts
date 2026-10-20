import type { PiiSql } from './pool.js';

/** 3MB の画像 + 封筒のヘッダー（版 1 + 一時公開鍵 32 + KEM 1088 + nonce 12）+ GCM タグ 16 に少し余裕を足した上限。 */
export const MAX_INGEST_BYTES = 3 * 1024 * 1024 + 1200 + 64;
const ENVELOPE_HEAD = 1 + 32 + 1088 + 12;
const ENVELOPE_VERSION = 1;

export interface IngestToken {
  uploadId: string;
  accountId: string;
  expiresAt: Date;
}

export interface IngestDeps {
  /** pii_ingest ロールの接続。暗号文の追記（INSERT）しかできない。 */
  sql: PiiSql;
  /** 提出トークンを 1 回限りで消費し、発行時に結び付けた uploadId / accountId を返す。無効なら null、通信失敗は throw。 */
  consumeToken(token: string): Promise<IngestToken | null>;
  /** ログは本文を含まない。渡すのは出来事とサイズだけ。 */
  log?(entry: { event: string; status: number; size?: number }): void;
}

export interface IngestInput {
  token: string | null;
  contentType: string | null;
  body: Uint8Array;
}

export interface IngestResult {
  status: 204 | 400 | 401 | 409 | 413 | 415 | 503;
  error?: string;
}

/**
 * 取り込み口：ブラウザ内で暗号化された封筒を受け取り、個人情報 DB に追記するだけ。
 * 封筒の中身は読めない（運営者の秘密鍵が要る）。形が封筒として正しいことと大きさだけを確認する。
 * uploadId / accountId はトークンから決まり、リクエストの他の部分からは一切読まない。
 */
export async function handleIdUpload(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const size = input.body.length;
  const done = (r: IngestResult): IngestResult => {
    deps.log?.({ event: 'id-upload', status: r.status, size });
    return r;
  };
  if (!input.token) return done({ status: 401, error: 'invalid_token' });
  if (input.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/octet-stream') return done({ status: 415, error: 'unsupported_type' });
  if (size > MAX_INGEST_BYTES) return done({ status: 413, error: 'too_large' });
  if (size <= ENVELOPE_HEAD + 16 || input.body[0] !== ENVELOPE_VERSION) return done({ status: 400, error: 'invalid_envelope' });

  let consumed: IngestToken | null;
  try {
    consumed = await deps.consumeToken(input.token);
  } catch {
    return done({ status: 503, error: 'unavailable' });
  }
  if (!consumed) return done({ status: 401, error: 'invalid_token' });
  try {
    await deps.sql`INSERT INTO student_id_blobs (upload_id, account_id, ciphertext, size_bytes, expires_at)
                   VALUES (${consumed.uploadId}, ${consumed.accountId}, ${Buffer.from(input.body)}, ${size}, ${consumed.expiresAt})`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return done({ status: 409, error: 'already_uploaded' });
    return done({ status: 503, error: 'unavailable' });
  }
  return done({ status: 204 });
}
