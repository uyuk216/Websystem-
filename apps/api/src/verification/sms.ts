import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { normalizePhone } from 'shared';
import { withSystem, type Db } from '../db/client.js';
import { smsHashes } from '../db/schema.js';

/**
 * SMS 認証の差し替え口。実際の送信プロバイダーはフェーズ 8。ここでは電話番号を保存しない:
 * 保存するのは HMAC のハッシュだけで、重複（同じ番号で複数のアカウント）の確認にだけ使う。
 */
export interface SmsVerifier {
  /** 番号（E.164）にコードを送る。 */
  send(phone: string): Promise<void>;
  /** 届いたコードが正しいか。 */
  check(phone: string, code: string): Promise<boolean>;
}

/** プロバイダー未設定のときの実装: 何も送らず、常に使えないと答える。 */
export const unavailableSmsVerifier: SmsVerifier = {
  async send() { throw new Error('sms_unavailable'); },
  async check() { return false; },
};

export const hashPhone = (phone: string, key: Buffer): string => createHmac('sha256', key).update(phone).digest('hex');

export type SmsError = 'invalid' | 'phone_in_use' | 'unavailable';

/** 番号を正規化し、他のアカウントですでに使われていないことを確かめてからコードを送る。 */
export async function requestSmsCode(db: Db, accountId: string, rawPhone: unknown, deps: { verifier: SmsVerifier; hashKey: Buffer }): Promise<{ ok: true } | { error: SmsError }> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { error: 'invalid' };
  if (await usedByOther(db, accountId, hashPhone(phone, deps.hashKey))) return { error: 'phone_in_use' };
  try {
    await deps.verifier.send(phone);
  } catch {
    return { error: 'unavailable' }; // 番号はログに出さない
  }
  return { ok: true };
}

/** コードを確かめ、正しければハッシュだけを保存する（同じ番号は別のアカウントに使えない）。 */
export async function confirmSmsCode(db: Db, accountId: string, rawPhone: unknown, code: unknown, deps: { verifier: SmsVerifier; hashKey: Buffer }): Promise<{ ok: true } | { error: SmsError }> {
  const phone = normalizePhone(rawPhone);
  if (!phone || typeof code !== 'string' || !/^\d{4,10}$/.test(code)) return { error: 'invalid' };
  const hash = hashPhone(phone, deps.hashKey);
  if (await usedByOther(db, accountId, hash)) return { error: 'phone_in_use' };
  let good = false;
  try {
    good = await deps.verifier.check(phone, code);
  } catch {
    return { error: 'unavailable' };
  }
  if (!good) return { error: 'invalid' };
  const inserted = await withSystem(db, (tx) => tx.insert(smsHashes).values({ hash, accountId }).onConflictDoNothing().returning({ h: smsHashes.hash }));
  if (inserted.length === 0 && (await usedByOther(db, accountId, hash))) return { error: 'phone_in_use' }; // 同時に別のアカウントが先に使った
  return { ok: true };
}

const usedByOther = async (db: Db, accountId: string, hash: string): Promise<boolean> => {
  const [r] = await withSystem(db, (tx) => tx.select({ accountId: smsHashes.accountId }).from(smsHashes).where(eq(smsHashes.hash, hash)));
  return !!r && r.accountId !== accountId;
};

export const hasSmsVerified = async (db: Db, accountId: string): Promise<boolean> =>
  (await withSystem(db, (tx) => tx.select({ h: smsHashes.hash }).from(smsHashes).where(and(eq(smsHashes.accountId, accountId))).limit(1))).length > 0;
