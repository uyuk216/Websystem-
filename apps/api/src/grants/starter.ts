import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { STARTER_DEFAULT_MIN_GITHUB_AGE_DAYS, STARTER_MAX_PERIOD_DAYS, STARTER_NOTICE_DAYS, validateStarterInput, type StarterInputError } from 'shared';
import type { RuntimeDriver } from 'platform';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { grants, githubInstallationLinks, starterApplications, starterNotices } from '../db/schema.js';
import { ensureAccountOwner } from '../teams/teams.js';
import type { Mailer } from '../mail/mailer.js';
import { jstDate } from '../mail/format-date.js';
import { ownerContact } from '../usage/owner-contact.js';
import { transitionUsageState } from '../usage/state.js';
import { githubAgeDays, type GithubAccountLookup } from '../verification/github-age.js';
import { hasSmsVerified } from '../verification/sms.js';
import { readBoolSetting, readNumberSetting } from './settings.js';

/** `platform_settings` のキー（管理画面から変えられる。変更は Task 5 の記録に残る）。 */
export const STARTER_SETTING_KEYS = { minGithubAgeDays: 'starter.minGithubAgeDays', requireSms: 'starter.requireSms' } as const;

export type ApplyError = StarterInputError | 'github_not_linked' | 'github_not_found' | 'github_too_new' | 'sms_required' | 'already_used' | 'already_applied';

const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: string; cause?: { code?: string } } | null);
  return code?.code === '23505' || code?.cause?.code === '23505';
};

/**
 * Starter Grant の申請。メール認証済み（アカウントがあること）・GitHub 連携済み・GitHub アカウントの作成日が閾値以上、
 * （設定で必要なら）SMS 認証済み。1 人 1 回: 過去に Starter を受けた人、進行中の申請がある人は受け付けない（同時に出しても 1 件だけ）。
 */
export async function applyStarter(
  db: Db, accountId: string, raw: Record<string, unknown> | null, deps: { githubAge: GithubAccountLookup; now?: Date },
): Promise<{ ok: { applicationId: string } } | { error: ApplyError }> {
  const now = deps.now ?? new Date();
  const input = validateStarterInput(raw);
  if ('error' in input) return input;
  const { project, githubLogin, introduction } = input.ok;

  const used = await withSystem(db, (tx) => tx.select({ id: grants.id }).from(grants).where(and(eq(grants.kind, 'starter'), eq(grants.targetKind, 'account'), eq(grants.targetId, accountId))).limit(1));
  if (used.length > 0) return { error: 'already_used' };
  const linked = await withAccount(db, accountId, (tx) => tx.select({ i: githubInstallationLinks.installationId }).from(githubInstallationLinks).limit(1));
  if (linked.length === 0) return { error: 'github_not_linked' };
  const created = await deps.githubAge.createdAt(githubLogin);
  if (!created) return { error: 'github_not_found' };
  const minDays = await readNumberSetting(db, STARTER_SETTING_KEYS.minGithubAgeDays, STARTER_DEFAULT_MIN_GITHUB_AGE_DAYS);
  if (githubAgeDays(created, now) < minDays) return { error: 'github_too_new' };
  if ((await readBoolSetting(db, STARTER_SETTING_KEYS.requireSms, false)) && !(await hasSmsVerified(db, accountId))) return { error: 'sms_required' };

  try {
    const [row] = await withAccount(db, accountId, (tx) => tx.insert(starterApplications)
      .values({ accountId, project, githubLogin, introduction, githubCreatedAt: created }).returning({ id: starterApplications.id }));
    return { ok: { applicationId: row!.id } };
  } catch (e) {
    if (isUniqueViolation(e)) return { error: 'already_applied' };
    throw e;
  }
}

export interface StarterStatus {
  application: { status: 'pending' | 'approved' | 'rejected'; rejectReason: string | null } | null;
  grant: { endsAt: string; daysLeft: number } | null;
}

/** 本人の申請の状態と Starter の残り日数（画面の表示用）。 */
export async function getStarterStatus(db: Db, accountId: string, now: Date = new Date()): Promise<StarterStatus> {
  return withAccount(db, accountId, async (tx) => {
    const [app] = await tx.select().from(starterApplications).where(eq(starterApplications.accountId, accountId)).orderBy(desc(starterApplications.createdAt)).limit(1);
    const [g] = await tx.select().from(grants).where(and(eq(grants.kind, 'starter'), eq(grants.targetKind, 'account'), eq(grants.targetId, accountId), isNull(grants.revokedAt), gt(grants.endsAt, now))).limit(1);
    return {
      application: app ? { status: app.status, rejectReason: app.rejectReason } : null,
      grant: g ? { endsAt: g.endsAt.toISOString(), daysLeft: Math.max(0, Math.ceil((g.endsAt.getTime() - now.getTime()) / 86_400_000)) } : null,
    };
  });
}

export async function listPendingStarterApplications(db: Db) {
  return withSystem(db, (tx) => tx.select().from(starterApplications).where(eq(starterApplications.status, 'pending')).orderBy(starterApplications.createdAt));
}

export type ReviewStarterError = 'not_found' | 'not_pending' | 'invalid_period' | 'already_granted';

interface ReviewOpts { approvedBy: string; now?: Date; mailer?: Mailer; emailKey?: Buffer; driver?: Pick<RuntimeDriver, 'stop'> }

/**
 * 承認。運営者が期間（`endsAt`）を決める。申請の更新と付与の作成は 1 トランザクションで、Starter は 1 人 1 回
 * （`grants_starter_once_idx`）なので、同時に承認しても付与は 1 つだけ。終了は自動課金なし: 停止日は終了の直後（`suspend_on = ends_at + 1ms`）。
 */
export async function approveStarter(db: Db, applicationId: string, endsAt: Date, opts: ReviewOpts): Promise<{ ok: { grantId: string; ownerId: string } } | { error: ReviewStarterError }> {
  const now = opts.now ?? new Date();
  if (!(endsAt.getTime() > now.getTime()) || endsAt.getTime() - now.getTime() > STARTER_MAX_PERIOD_DAYS * 86_400_000) return { error: 'invalid_period' };
  let r: { accountId: string; grantId: string } | { error: 'not_found' | 'not_pending' };
  try {
    r = await withSystem(db, async (tx) => {
      const [a] = await tx.select().from(starterApplications).where(eq(starterApplications.id, applicationId)).for('update');
      if (!a) return { error: 'not_found' as const };
      if (a.status !== 'pending') return { error: 'not_pending' as const };
      const [g] = await tx.insert(grants).values({
        targetKind: 'account', targetId: a.accountId, kind: 'starter', params: {}, startsAt: now, endsAt,
        suspendOn: new Date(endsAt.getTime() + 1), reason: 'starter grant', approvedBy: opts.approvedBy,
      }).returning({ id: grants.id });
      await tx.update(starterApplications).set({ status: 'approved', reviewedBy: opts.approvedBy, reviewedAt: now, grantId: g!.id }).where(eq(starterApplications.id, applicationId));
      return { accountId: a.accountId, grantId: g!.id };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { error: 'already_granted' };
    throw e;
  }
  if ('error' in r) return r;
  const ownerId = await ensureAccountOwner(db, r.accountId);
  // 猶予・停止の理由が残っていれば計算し直す（Starter が有効なら外れる）。コンテナは止めない。
  await transitionUsageState(db, ownerId, 'reregistered', { now, driver: opts.driver }).catch((e: unknown) => console.error('starter: usage state failed', e));
  await mailOwner(db, ownerId, opts, 'approved', { endsAt: (l) => jstDate(l, new Date(endsAt.getTime() - 1)) });
  return { ok: { grantId: r.grantId, ownerId } };
}

/** 差し戻し（理由つき）。再申請できる。 */
export async function rejectStarter(db: Db, applicationId: string, reason: string, opts: ReviewOpts): Promise<{ ok: true } | { error: 'not_found' | 'not_pending' | 'reason' }> {
  const text = reason.trim();
  if (text.length < 1 || text.length > 500) return { error: 'reason' };
  const now = opts.now ?? new Date();
  const [row] = await withSystem(db, (tx) => tx.update(starterApplications).set({ status: 'rejected', rejectReason: text, reviewedBy: opts.approvedBy, reviewedAt: now })
    .where(and(eq(starterApplications.id, applicationId), eq(starterApplications.status, 'pending'))).returning({ accountId: starterApplications.accountId }));
  if (!row) {
    const [exists] = await withSystem(db, (tx) => tx.select({ id: starterApplications.id }).from(starterApplications).where(eq(starterApplications.id, applicationId)));
    return { error: exists ? 'not_pending' : 'not_found' };
  }
  await mailOwner(db, await ensureAccountOwner(db, row.accountId), opts, 'rejected', { reason: () => text });
  return { ok: true };
}

async function mailOwner(db: Db, ownerId: string, opts: ReviewOpts, kind: 'approved' | 'rejected', params: Record<string, (l: Locale) => string>): Promise<void> {
  if (!opts.mailer || !opts.emailKey) return;
  try {
    const target = await ownerContact(db, ownerId, opts.emailKey);
    if (!target) return;
    const p = Object.fromEntries(Object.entries(params).map(([k, f]) => [k, f(target.locale)]));
    await opts.mailer.sendMail(target.email, t(target.locale, `starter.${kind}Subject`), t(target.locale, `starter.${kind}Body`, p));
  } catch (e) {
    console.error('starter mail failed', e);
  }
}

/**
 * 終了の 14 日前と 3 日前の予告（付与ごと・種類ごとに 1 回だけ。残りが 3 日を切った付与には 14 日前の予告は送らない）。
 * 「先に記録した者が送る」ので、複数のワーカーが同時に走っても重複しない。メールが失敗したら記録を消して次回に再試行する。返り値は送った数。
 */
export async function sendStarterNotices(db: Db, opts: { now?: Date; mailer: Mailer; emailKey: Buffer }): Promise<number> {
  const now = opts.now ?? new Date();
  const horizon = new Date(now.getTime() + STARTER_NOTICE_DAYS.d14 * 86_400_000);
  const list = await withSystem(db, (tx) => tx.select({ id: grants.id, accountId: grants.targetId, startsAt: grants.startsAt, endsAt: grants.endsAt }).from(grants)
    .where(and(eq(grants.kind, 'starter'), eq(grants.targetKind, 'account'), isNull(grants.revokedAt), gt(grants.endsAt, now), lte(grants.endsAt, horizon))));
  let sent = 0;
  for (const g of list) {
    const left = g.endsAt.getTime() - now.getTime();
    const kind = left <= STARTER_NOTICE_DAYS.d3 * 86_400_000 ? 'd3' : 'd14';
    // 期間が 14 日以下の付与には「14 日前」の予告は意味がないので送らない（3 日前だけ）。
    if (kind === 'd14' && g.endsAt.getTime() - g.startsAt.getTime() <= STARTER_NOTICE_DAYS.d14 * 86_400_000) continue;
    const won = await withSystem(db, (tx) => tx.insert(starterNotices).values({ grantId: g.id, kind }).onConflictDoNothing().returning({ g: starterNotices.grantId }));
    if (won.length === 0) continue;
    try {
      const ownerId = await ensureAccountOwner(db, g.accountId);
      const target = await ownerContact(db, ownerId, opts.emailKey);
      if (!target) continue;
      const key = kind === 'd3' ? 'notice3' : 'notice14';
      await opts.mailer.sendMail(target.email, t(target.locale, `starter.${key}Subject`), t(target.locale, `starter.${key}Body`, { endsAt: jstDate(target.locale, new Date(g.endsAt.getTime() - 1)) }));
      sent++;
    } catch (e) {
      console.error('starter notice failed', g.id, e);
      await withSystem(db, (tx) => tx.delete(starterNotices).where(and(eq(starterNotices.grantId, g.id), eq(starterNotices.kind, kind)))).catch(() => undefined);
    }
  }
  return sent;
}
