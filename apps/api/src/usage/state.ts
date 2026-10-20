import { and, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { applyUsageEvent, endOfMarchJst, isStoppedState, nextEvaluationAt, reregistrationFiscalKey, stateOf, timeReasonFor, JST_OFFSET_MS } from 'shared';
import type { GrantFacts, UsageEvent, UsageReason, UsageState } from 'shared';
import type { RuntimeDriver } from 'platform';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { apps, grants, owners, studentVerifications, teamMembers, usageStates } from '../db/schema.js';
import { ownerGrantFilter } from '../grants/entitlements.js';
import { ensureAccountOwner } from '../teams/teams.js';
import type { Mailer } from '../mail/mailer.js';
import { ownerContact } from './owner-contact.js';

/**
 * 利用の状態（active / grace / suspended / blocked / frozen）を変える**唯一**の場所。
 * 状態は理由の集合から決まり（凍結 > ブロック > 停止 > 猶予 > 有効）、時間の理由は付与と時刻から毎回計算し直すので、
 * 年度の切り替え・月初・付与の期限が同じ日に重なっても、どの順で来ても結果は同じ（`shared/usage-state.ts` の純粋関数）。
 * 停止の実体は動的アプリのコンテナを止めること。データ・イメージ・DB は消さない。再開は次のアクセスで waker が起こす。
 */
export interface TransitionOptions {
  now?: Date;
  /** 渡されると、遷移後の状態が停止系（停止・ブロック・凍結）のときに、そのオーナーの動的アプリのコンテナを止める。 */
  driver?: Pick<RuntimeDriver, 'stop'>;
  /** 猶予・停止に入ったときの通知。 */
  mailer?: Mailer;
  emailKey?: Buffer;
}

export interface TransitionResult {
  previous: UsageState;
  state: UsageState;
  reasons: UsageReason[];
  changed: boolean;
  stoppedApps: number;
}

const TIME_GRANT_KINDS = ['student', 'starter'] as const;

async function loadGrantFacts(tx: Tx, ownerId: string): Promise<GrantFacts[]> {
  const mine = await ownerGrantFilter(tx, ownerId);
  const rows = await tx.select({ endsAt: grants.endsAt, suspendOn: grants.suspendOn, revokedAt: grants.revokedAt }).from(grants)
    .where(and(mine, inArray(grants.kind, [...TIME_GRANT_KINDS])));
  return rows.map((r) => ({ endsAt: r.endsAt, suspendOn: r.suspendOn, revoked: r.revokedAt !== null }));
}

/** 現在の状態（行がなければ active）。システム側で読む。 */
export async function readUsageState(db: Db | Tx, ownerId: string): Promise<UsageState> {
  const [r] = await withSystem(db, (tx) => tx.select({ state: usageStates.state }).from(usageStates).where(eq(usageStates.ownerId, ownerId)));
  return r?.state ?? 'active';
}

export async function transitionUsageState(db: Db, ownerId: string, event: UsageEvent, opts: TransitionOptions = {}): Promise<TransitionResult> {
  const at = opts.now ?? new Date();
  const out = await withSystem(db, async (tx) => {
    await tx.insert(usageStates).values({ ownerId }).onConflictDoNothing();
    const [row] = await tx.select().from(usageStates).where(eq(usageStates.ownerId, ownerId)).for('update');
    if (!row) throw new Error('usage state row missing');
    const facts = await loadGrantFacts(tx, ownerId);
    const next = applyUsageEvent({ reasons: row.reasons as UsageReason[], paid: row.paid }, event, timeReasonFor(facts, at));
    const state = stateOf(next.reasons);
    const live = facts.filter((g) => !g.revoked);
    const last = live.length > 0 ? live.reduce((a, g) => (g.endsAt > a.endsAt ? g : a)) : null;
    await tx.update(usageStates).set({
      state, reasons: next.reasons as string[], paid: next.paid,
      validUntil: last?.endsAt ?? null, suspendOn: last ? (last.suspendOn ?? new Date(last.endsAt.getTime() + 1)) : null,
      nextEvaluateAt: next.paid ? null : nextEvaluationAt(facts, at), updatedAt: at,
    }).where(eq(usageStates.ownerId, ownerId));
    return { previous: row.state, state, reasons: next.reasons as UsageReason[], suspendOn: last?.suspendOn ?? null };
  });

  let stoppedApps = 0;
  if (opts.driver && isStoppedState(out.state)) stoppedApps = await stopOwnerDynamicApps(db, opts.driver, ownerId);
  if (out.state !== out.previous && (out.state === 'grace' || out.state === 'suspended') && opts.mailer && opts.emailKey) {
    await notifyState(db, ownerId, out.state, out.suspendOn, opts.mailer, opts.emailKey);
  }
  return { previous: out.previous, state: out.state, reasons: out.reasons, changed: out.state !== out.previous, stoppedApps };
}

/** そのオーナーの動的アプリのコンテナを止める（データ・イメージ・DB は残す）。止めた数を返す。 */
export async function stopOwnerDynamicApps(db: Db, driver: Pick<RuntimeDriver, 'stop'>, ownerId: string): Promise<number> {
  const list = await withSystem(db, (tx) => tx.select({ id: apps.id }).from(apps).where(and(eq(apps.ownerId, ownerId), eq(apps.kind, 'dynamic'))));
  let n = 0;
  for (const { id } of list) {
    try { await driver.stop(id); n++; } catch (e) { console.error('usage state: stop failed', id, e); }
  }
  return n;
}

const jstDate = (locale: Locale, d: Date): string => {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  const [y, m, day] = [j.getUTCFullYear(), j.getUTCMonth() + 1, j.getUTCDate()];
  return locale === 'ja' ? `${y}年${m}月${day}日` : `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${day}, ${y}`;
};

async function notifyState(db: Db, ownerId: string, state: 'grace' | 'suspended', suspendOn: Date | null, mailer: Mailer, emailKey: Buffer): Promise<void> {
  try {
    const target = await ownerContact(db, ownerId, emailKey);
    if (!target) return;
    const params = { suspendOn: suspendOn ? jstDate(target.locale, new Date(suspendOn.getTime() - 1)) : '' };
    await mailer.sendMail(target.email, t(target.locale, `usage.${state}Subject`), t(target.locale, `usage.${state}Body`, params));
  } catch (e) {
    console.error('usage state mail failed', ownerId, e);
  }
}

/** 日付から使うイベント（どれでも結果は同じ。ログと意図のため）。 */
export function eventForDate(now: Date): UsageEvent {
  const j = new Date(now.getTime() + JST_OFFSET_MS);
  if (j.getUTCMonth() === 3 && j.getUTCDate() === 1) return 'fiscal_year_rollover';
  if (j.getUTCDate() === 1) return 'month_start_reset';
  return 'grant_expired';
}

/**
 * 評価の時期が来たオーナー（`next_evaluate_at` が過ぎた、または期限の切れた付与があるのにまだ評価していない）を評価する。
 * ワーカーが毎時呼ぶ。返り値は評価した数。
 */
export async function evaluateDueOwners(db: Db, opts: TransitionOptions = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const due = new Set<string>();
  await withSystem(db, async (tx) => {
    for (const r of await tx.select({ id: usageStates.ownerId }).from(usageStates).where(and(lte(usageStates.nextEvaluateAt, now), eq(usageStates.paid, false)))) due.add(r.id);
    // 期限が切れたのに行がない（まだ一度も評価していない）オーナー。
    const ended = await tx.select({ kind: grants.targetKind, id: grants.targetId }).from(grants)
      .where(and(inArray(grants.kind, [...TIME_GRANT_KINDS]), isNull(grants.revokedAt), lt(grants.endsAt, now)));
    const accountIds = ended.filter((g) => g.kind === 'account').map((g) => g.id);
    const ownerIds = ended.filter((g) => g.kind === 'owner').map((g) => g.id);
    const candidates = new Set<string>(ownerIds);
    if (accountIds.length > 0) {
      for (const r of await tx.select({ id: owners.id }).from(owners).where(inArray(owners.accountId, accountIds))) candidates.add(r.id);
      for (const r of await tx.select({ id: owners.id }).from(owners).innerJoin(teamMembers, and(eq(teamMembers.teamId, owners.teamId), eq(teamMembers.role, 'owner'))).where(inArray(teamMembers.accountId, accountIds))) candidates.add(r.id);
    }
    if (candidates.size > 0) {
      const have = new Set((await tx.select({ id: usageStates.ownerId }).from(usageStates).where(inArray(usageStates.ownerId, [...candidates]))).map((r) => r.id));
      for (const id of candidates) if (!have.has(id)) due.add(id);
    }
  });
  const event = eventForDate(now);
  for (const ownerId of due) {
    try { await transitionUsageState(db, ownerId, event, { ...opts, now }); } catch (e) { console.error('usage state: evaluate failed', ownerId, e); }
  }
  return due.size;
}

/**
 * 3 月（JST）に、年度末が期限の Student の人へ翌年度の再登録の受付開始を案内する（年度ごとに 1 回だけ）。
 * 登録されている卒業予定年を過ぎた人には、卒業予定年を過ぎた旨の案内（日英）にする。返り値は送った数。
 */
export async function sendReregistrationNotices(db: Db, opts: { now?: Date; mailer: Mailer; emailKey: Buffer }): Promise<number> {
  const now = opts.now ?? new Date();
  const key = reregistrationFiscalKey(now);
  if (!key) return 0;
  const j = new Date(now.getTime() + JST_OFFSET_MS);
  const year = j.getUTCFullYear();
  const deadline = new Date(Date.UTC(year, 4, 1) - JST_OFFSET_MS - 1); // 4/30 の終わり（5/1 の停止の直前）
  const accounts_ = await withSystem(db, (tx) => tx.select({ id: grants.targetId }).from(grants)
    .where(and(eq(grants.kind, 'student'), eq(grants.targetKind, 'account'), isNull(grants.revokedAt), sql`${grants.endsAt} >= ${now.toISOString()}::timestamptz`, lte(grants.endsAt, endOfMarchJst(year)))));
  let sent = 0;
  for (const { id: accountId } of accounts_) {
    const ownerId = await ensureAccountOwner(db, accountId);
    await withSystem(db, (tx) => tx.insert(usageStates).values({ ownerId }).onConflictDoNothing());
    const won = await withSystem(db, (tx) => tx.update(usageStates).set({ reregNotifiedFor: key })
      .where(and(eq(usageStates.ownerId, ownerId), sql`${usageStates.reregNotifiedFor} IS DISTINCT FROM ${key}`)).returning({ id: usageStates.ownerId }));
    if (won.length === 0) continue;
    try {
      const target = await ownerContact(db, ownerId, opts.emailKey);
      if (!target) continue;
      const [v] = await withSystem(db, (tx) => tx.select({ year: studentVerifications.expectedGraduationYear }).from(studentVerifications)
        .where(and(eq(studentVerifications.accountId, accountId), eq(studentVerifications.status, 'approved'))).orderBy(sql`${studentVerifications.reviewedAt} DESC NULLS LAST`).limit(1));
      const params = { deadline: jstDate(target.locale, deadline), year: String(v?.year ?? '') };
      const kind = v && v.year <= year ? 'graduated' : 'reregister';
      await opts.mailer.sendMail(target.email, t(target.locale, `usage.${kind}Subject`), t(target.locale, `usage.${kind}Body`, params));
      sent++;
    } catch (e) {
      console.error('re-registration notice failed', ownerId, e);
    }
  }
  return sent;
}
