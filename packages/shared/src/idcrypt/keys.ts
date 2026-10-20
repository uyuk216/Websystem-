import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { MLKEM_PK_LEN, MLKEM_SK_LEN, X25519_LEN, x25519Generate } from './hybrid-kem.js';

export interface RecipientPublicKey {
  x25519: Uint8Array;
  mlkem: Uint8Array;
}
export interface RecipientSecretKey {
  x25519Seed: Uint8Array;
  mlkem: Uint8Array;
}

/** テスト・開発用。本番の秘密鍵は YubiKey 内にあり、ここでは生成しない。 */
export async function generateRecipientKeyPair(): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
  const x = await x25519Generate();
  const k = ml_kem768.keygen();
  const publicKey = new Uint8Array(X25519_LEN + MLKEM_PK_LEN);
  publicKey.set(x.publicKey, 0);
  publicKey.set(k.publicKey, X25519_LEN);
  const secretKey = new Uint8Array(X25519_LEN + MLKEM_SK_LEN);
  secretKey.set(x.seed, 0);
  secretKey.set(k.secretKey, X25519_LEN);
  return { publicKey, secretKey };
}

export function parseRecipientPublicKey(bytes: Uint8Array): RecipientPublicKey {
  if (bytes.length !== X25519_LEN + MLKEM_PK_LEN) throw new Error('recipient public key: invalid length');
  return { x25519: bytes.slice(0, X25519_LEN), mlkem: bytes.slice(X25519_LEN) };
}

export function parseRecipientSecretKey(bytes: Uint8Array): RecipientSecretKey {
  if (bytes.length !== X25519_LEN + MLKEM_SK_LEN) throw new Error('recipient secret key: invalid length');
  return { x25519Seed: bytes.slice(0, X25519_LEN), mlkem: bytes.slice(X25519_LEN) };
}
