/** JST（UTC+9、夏時間なし）の年度の境目。Student の有効期限（3/31）と停止日（5/1）の計算はここだけで行う。 */
export const JST_OFFSET_MS = 9 * 3600_000;

/** その年の 3/31 の終わり（JST 23:59:59.999）。 */
export const endOfMarchJst = (year: number): Date => new Date(Date.UTC(year, 3, 1) - JST_OFFSET_MS - 1);

/** その年の 5/1 00:00 JST。 */
export const startOfMayJst = (year: number): Date => new Date(Date.UTC(year, 4, 1) - JST_OFFSET_MS);

/** 有効期限（3/31）に対する停止日 = 同じ年の 5/1 00:00 JST（猶予は 4 月いっぱい）。 */
export function suspendDateFor(validUntil: Date): Date {
  return startOfMayJst(new Date(validUntil.getTime() + JST_OFFSET_MS).getUTCFullYear());
}
