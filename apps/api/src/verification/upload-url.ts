import { createHash, randomBytes } from 'node:crypto';
import type { Locale } from 'i18n';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOKEN_RE = new RegExp(`^(${UUID})\\.(${UUID})\\.[A-Za-z0-9_-]{43}$`, 'i');

/**
 * Submission token: `<uploadId>.<accountId>.<256-bit secret>`. The ids let the page bind its ciphertext (AAD) to this
 * upload; they grant nothing. Only the hash of the whole token is stored, and the intake looks the row up by that hash.
 */
export function generateUploadToken(uploadId: string, accountId: string): string {
  return `${uploadId}.${accountId}.${randomBytes(32).toString('base64url')}`;
}

export function hashUploadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isUploadTokenShape(token: unknown): token is string {
  return typeof token === 'string' && token.length <= 200 && TOKEN_RE.test(token);
}

/** The dedicated upload origin's page. The token is in the query string once; the page strips it from the address bar. */
export function buildUploadUrl(uploadOrigin: string, locale: Locale, token: string): string {
  const u = new URL(`/${locale}/submit`, uploadOrigin);
  u.searchParams.set('token', token);
  return u.toString();
}
