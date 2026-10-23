/** Starter Grant（フェーズ 5 Task 8）の申請の入力検証と、不正対策の既定値。 */
export const STARTER_DEFAULT_MIN_GITHUB_AGE_DAYS = 90;
/** 運営者が決められる期間の上限。 */
export const STARTER_MAX_PERIOD_DAYS = 366;
/** 終了の予告（残り日数）。 */
export const STARTER_NOTICE_DAYS = { d14: 14, d3: 3 } as const;

export interface StarterInput {
  project: string;
  githubLogin: string;
  introduction: string;
}
export type StarterInputError = 'project' | 'github_login' | 'introduction';

/** GitHub のユーザー名: 英数字とハイフン、先頭は英数字、最大 39 文字。 */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function validateStarterInput(raw: Record<string, unknown> | null): { ok: StarterInput } | { error: StarterInputError } {
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const project = s(raw?.project);
  if (project.length < 1 || project.length > 1000) return { error: 'project' };
  const githubLogin = s(raw?.githubLogin);
  if (!GITHUB_LOGIN_RE.test(githubLogin)) return { error: 'github_login' };
  const introduction = s(raw?.introduction);
  if (introduction.length < 1 || introduction.length > 2000) return { error: 'introduction' };
  return { ok: { project, githubLogin, introduction } };
}

/** 電話番号を E.164（+ と 8〜15 桁）に正規化する。空白・ハイフン・括弧は取り除く。不正なら null。 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.replace(/[\s\-()]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

/** イベントブースト（Task 9）: 期間は最大 7 日、開始の 3 日前までに申請。 */
export const EVENT_BOOST_MAX_DAYS = 7;
export const EVENT_BOOST_LEAD_DAYS = 3;
export const EVENT_BOOST_MAX_VISITS = 100_000_000;

export interface BoostRequestInput {
  eventName: string;
  startsAt: Date;
  endsAt: Date;
  expectedVisits: number;
}
export type BoostRequestError = 'event_name' | 'period' | 'too_long' | 'too_late' | 'expected_visits';

export function validateBoostRequest(raw: Record<string, unknown> | null, now: Date): { ok: BoostRequestInput } | { error: BoostRequestError } {
  const name = typeof raw?.eventName === 'string' ? raw.eventName.trim() : '';
  if (name.length < 1 || name.length > 100) return { error: 'event_name' };
  const date = (v: unknown): Date | null => {
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const startsAt = date(raw?.startsAt);
  const endsAt = date(raw?.endsAt);
  if (!startsAt || !endsAt || endsAt.getTime() <= startsAt.getTime()) return { error: 'period' };
  if (endsAt.getTime() - startsAt.getTime() > EVENT_BOOST_MAX_DAYS * 86_400_000) return { error: 'too_long' };
  if (startsAt.getTime() - now.getTime() < EVENT_BOOST_LEAD_DAYS * 86_400_000) return { error: 'too_late' };
  const visits = raw?.expectedVisits;
  if (typeof visits !== 'number' || !Number.isInteger(visits) || visits < 0 || visits > EVENT_BOOST_MAX_VISITS) return { error: 'expected_visits' };
  return { ok: { eventName: name, startsAt, endsAt, expectedVisits: visits } };
}
