import { ENVELOPE_VERSION, buildAad, type IdEnvelope } from './envelope.js';
import { hybridEncapsulate } from './hybrid-kem.js';
import { parseRecipientPublicKey } from './keys.js';

const b = (u: Uint8Array): Uint8Array<ArrayBuffer> => u as Uint8Array<ArrayBuffer>;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export async function encryptIdImage(input: {
  image: Uint8Array;
  recipientPublicKey: Uint8Array;
  uploadId: string;
  accountId: string;
}): Promise<IdEnvelope> {
  if (input.image.length === 0 || input.image.length > MAX_IMAGE_BYTES) throw new Error('image: size out of range');
  const aad = buildAad(ENVELOPE_VERSION, input.uploadId, input.accountId);
  const { key, ephemeralPublicKey, kemCiphertext } = await hybridEncapsulate(parseRecipientPublicKey(input.recipientPublicKey), aad);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: b(nonce), additionalData: b(aad) },
    key,
    b(input.image),
  );
  return { version: ENVELOPE_VERSION, ephemeralPublicKey, kemCiphertext, nonce, ciphertext: new Uint8Array(ct) };
}

/**
 * ブラウザ専用：canvas に描き直して EXIF 等を落とし、3MB 以下の JPEG/WebP にする。
 * 変換できない形式（HEIC など）はエラー。
 */
export async function sanitizeIdImage(file: Blob): Promise<Uint8Array> {
  const g = globalThis as unknown as {
    createImageBitmap?: (b: Blob) => Promise<{ width: number; height: number; close(): void }>;
    OffscreenCanvas?: new (w: number, h: number) => {
      getContext(t: '2d'): { drawImage(i: unknown, x: number, y: number, w: number, h: number): void } | null;
      convertToBlob(o: { type: string; quality: number }): Promise<Blob>;
    };
  };
  if (!g.createImageBitmap || !g.OffscreenCanvas) throw new Error('image: canvas unavailable');
  let bmp;
  try {
    bmp = await g.createImageBitmap(file);
  } catch {
    throw new Error('image: unsupported format');
  }
  let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new g.OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('image: canvas unavailable');
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    if (blob.size <= MAX_IMAGE_BYTES) {
      bmp.close();
      return new Uint8Array(await blob.arrayBuffer());
    }
    scale *= 0.7;
  }
  bmp.close();
  throw new Error('image: too large');
}
