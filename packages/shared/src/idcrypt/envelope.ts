export const ENVELOPE_VERSION = 1;

export interface IdEnvelope {
  version: number;
  /** X25519 一時公開鍵（32 バイト） */
  ephemeralPublicKey: Uint8Array;
  /** ML-KEM-768 の暗号文 */
  kemCiphertext: Uint8Array;
  /** AES-GCM の nonce（12 バイト） */
  nonce: Uint8Array;
  /** AES-GCM 暗号文（タグ込み） */
  ciphertext: Uint8Array;
}

const X_LEN = 32;
const KEM_CT_LEN = 1088;
const NONCE_LEN = 12;

/** 版(1) | 一時公開鍵(32) | KEM暗号文(1088) | nonce(12) | 暗号文 */
export function serializeEnvelope(e: IdEnvelope): Uint8Array {
  const out = new Uint8Array(1 + X_LEN + KEM_CT_LEN + NONCE_LEN + e.ciphertext.length);
  out[0] = e.version;
  out.set(e.ephemeralPublicKey, 1);
  out.set(e.kemCiphertext, 1 + X_LEN);
  out.set(e.nonce, 1 + X_LEN + KEM_CT_LEN);
  out.set(e.ciphertext, 1 + X_LEN + KEM_CT_LEN + NONCE_LEN);
  return out;
}

export function parseEnvelope(bytes: Uint8Array): IdEnvelope {
  const head = 1 + X_LEN + KEM_CT_LEN + NONCE_LEN;
  if (bytes.length <= head) throw new Error('envelope: too short');
  return {
    version: bytes[0]!,
    ephemeralPublicKey: bytes.slice(1, 1 + X_LEN),
    kemCiphertext: bytes.slice(1 + X_LEN, 1 + X_LEN + KEM_CT_LEN),
    nonce: bytes.slice(1 + X_LEN + KEM_CT_LEN, head),
    ciphertext: bytes.slice(head),
  };
}

const enc = new TextEncoder();
/** 認証付きデータ：版・uploadId・accountId に暗号文を束縛する */
export function buildAad(version: number, uploadId: string, accountId: string): Uint8Array {
  return enc.encode(`ys-idcrypt|v${version}|${uploadId}|${accountId}`);
}
