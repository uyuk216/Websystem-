import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

export function normalizeEmail(raw: string): string {
  return raw.trim().normalize('NFKC').toLowerCase();
}

export function hashEmail(normalized: string, key: Buffer): string {
  return createHmac('sha256', key).update(normalized).digest('hex');
}

/** Returns base64(iv | tag | ciphertext). */
export function encryptEmail(normalized: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([c.update(normalized, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptEmail(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('invalid ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN), { authTagLength: TAG_LEN });
  d.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
}
