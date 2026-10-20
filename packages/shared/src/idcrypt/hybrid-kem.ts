import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

const subtle = globalThis.crypto.subtle;
const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

export const X25519_LEN = 32;
export const MLKEM_PK_LEN = 1184;
export const MLKEM_SK_LEN = 2400;

const enc = new TextEncoder();
const b = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function x25519Public(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', b(raw), { name: 'X25519' }, false, []);
}

async function x25519Private(seed: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('pkcs8', b(concat(PKCS8_X25519_PREFIX, seed)), { name: 'X25519' }, false, ['deriveBits']);
}

export async function x25519Generate(): Promise<{ publicKey: Uint8Array; seed: Uint8Array }> {
  const kp = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  return { publicKey: pub, seed: pkcs8.slice(pkcs8.length - X25519_LEN) };
}

async function x25519Derive(priv: CryptoKey, pubRaw: Uint8Array): Promise<Uint8Array> {
  const bits = await subtle.deriveBits({ name: 'X25519', public: await x25519Public(pubRaw) }, priv, 256);
  return new Uint8Array(bits);
}

async function combine(x: Uint8Array, k: Uint8Array, ephPub: Uint8Array, kemCt: Uint8Array, aad: Uint8Array): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', b(concat(x, k)), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: b(concat(ephPub, kemCt)), info: b(concat(enc.encode('ys-idcrypt-hybrid'), aad)) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** X25519 + ML-KEM-768 のハイブリッド。どちらか片方が破られても鍵は守られる。 */
export async function hybridEncapsulate(
  recipientPublicKey: { x25519: Uint8Array; mlkem: Uint8Array },
  aad: Uint8Array,
): Promise<{ key: CryptoKey; ephemeralPublicKey: Uint8Array; kemCiphertext: Uint8Array }> {
  const eph = await x25519Generate();
  const ephPriv = await x25519Private(eph.seed);
  const x = await x25519Derive(ephPriv, recipientPublicKey.x25519);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientPublicKey.mlkem);
  const key = await combine(x, sharedSecret, eph.publicKey, cipherText, aad);
  return { key, ephemeralPublicKey: eph.publicKey, kemCiphertext: cipherText };
}

export async function hybridDecapsulate(
  secretKey: { x25519Seed: Uint8Array; mlkem: Uint8Array },
  ephemeralPublicKey: Uint8Array,
  kemCiphertext: Uint8Array,
  aad: Uint8Array,
): Promise<CryptoKey> {
  const x = await x25519Derive(await x25519Private(secretKey.x25519Seed), ephemeralPublicKey);
  const k = ml_kem768.decapsulate(kemCiphertext, secretKey.mlkem);
  return combine(x, k, ephemeralPublicKey, kemCiphertext, aad);
}
