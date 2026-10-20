/**
 * 学生証の審査ルール（フェーズ 5 Task 4）。日付は JST（UTC+9、夏時間なし）で判定する。
 * - 3 月の提出は「翌年度（4 月から）の在学」を卒業予定年で判定する（卒業予定年 = その年の 3 月に卒業）。
 * - 4 月以降は新年度の学生証か在学証明書を要求する（承認画面にチェックを出し、確認なしでは承認できない）。
 * - 有効期限は年度末の 3/31。3 月に承認した場合は翌年度末（新年度の再登録）。
 */
const JST_MS = 9 * 3600_000;

const jstParts = (d: Date): { year: number; month: number } => {
  const j = new Date(d.getTime() + JST_MS);
  return { year: j.getUTCFullYear(), month: j.getUTCMonth() + 1 };
};

/** その年の 3/31 の終わり（JST 23:59:59.999）。 */
export const endOfMarchJst = (year: number): Date => new Date(Date.UTC(year, 3, 1) - JST_MS - 1);

export interface EligibilityVerdict {
  /** 卒業予定年から見て、判定の対象の年度に在学しているか。 */
  enrolled: boolean;
  /** 新年度（4 月以降）のものか、承認画面で確認が必要か。 */
  requiresNewFiscalYearDoc: boolean;
  validUntil: Date;
}

export function assessEligibility(expectedGraduationYear: number, now: Date = new Date()): EligibilityVerdict {
  const { year, month } = jstParts(now);
  // 1〜2 月: 今年度（卒業予定年が今年以降なら在学）。3 月: 翌年度の在学（卒業予定年が来年以降）。4 月以降: 新年度（卒業予定年が来年以降）。
  const enrolled = month <= 2 ? expectedGraduationYear >= year : expectedGraduationYear > year;
  const requiresNewFiscalYearDoc = month >= 4;
  const validUntil = endOfMarchJst(month <= 2 ? year : year + 1);
  return { enrolled, requiresNewFiscalYearDoc, validUntil };
}
