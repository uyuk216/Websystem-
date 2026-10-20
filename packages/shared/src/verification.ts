/** 学生証の提出（フェーズ 5 Task 3）で本体 DB とブラウザの両方が使う定数と入力検証。 */
export const SCHOOL_KINDS = ['junior_high', 'high_school', 'technical_college', 'vocational', 'university', 'graduate'] as const;
export type SchoolKind = (typeof SCHOOL_KINDS)[number];

/** 提出トークンは 10 分・1 回限り。暗号文は審査されなければ 7 日で消える。 */
export const UPLOAD_TOKEN_TTL_MS = 10 * 60_000;
export const UPLOAD_RETENTION_MS = 7 * 86_400_000;

export interface VerificationInput {
  schoolName: string;
  schoolKind: SchoolKind;
  expectedGraduationYear: number;
}

export type VerificationInputError = 'school_name' | 'school_kind' | 'graduation_year';

/** 学校名・種類・卒業（修了）予定年を検証する。卒業予定年は今年の前年から 10 年先まで。 */
export function validateVerificationInput(raw: Record<string, unknown> | null, now: Date = new Date()): { ok: VerificationInput } | { error: VerificationInputError } {
  const name = typeof raw?.schoolName === 'string' ? raw.schoolName.trim() : '';
  if (name.length < 1 || name.length > 100) return { error: 'school_name' };
  if (typeof raw?.schoolKind !== 'string' || !(SCHOOL_KINDS as readonly string[]).includes(raw.schoolKind)) return { error: 'school_kind' };
  const year = raw.expectedGraduationYear;
  const thisYear = now.getUTCFullYear();
  if (typeof year !== 'number' || !Number.isInteger(year) || year < thisYear - 1 || year > thisYear + 10) return { error: 'graduation_year' };
  return { ok: { schoolName: name, schoolKind: raw.schoolKind as SchoolKind, expectedGraduationYear: year } };
}
