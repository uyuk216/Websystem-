import { and, eq, gt, isNull, lte, ne, lt, sql } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { waitHealthy } from 'platform';
import { validateBoostRequest, type BoostRequestError } from 'shared';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { apps, eventBoosts, grants } from '../db/schema.js';
import { UUID } from '../auth/cross-device.js';
import { mayManage } from '../apps/apps.js';
import { runLimitsFor } from '../apps/run-limits.js';
import { buildRunSpec, type DynamicRuntime } from '../ingest/dynamic.js';
import { jstDate } from '../mail/format-date.js';
import type { Mailer } from '../mail/mailer.js';
import { ownerContact } from '../usage/owner-contact.js';
import { resolveEntitlements } from './entitlements.js';

/** 承認時に運営者が上げ幅を指定しなかったときの既定値。 */
export const BOOST_DEFAULTS = { extraTransferBytes: 20 * 1024 ** 3, extraMemoryMb: 512 } as const;
const MAX_EXTRA_TRANSFER_BYTES = 1024 ** 4;
const MAX_EXTRA_MEMORY_MB = 8192;

export type RequestBoostError = BoostRequestError | 'not_found' | 'forbidden' | 'not_dynamic' | 'plan_required' | 'overlap';

/**
 * イベントブーストの申請（アプリ単位）。動的アプリの管理者が、開始の 3 日前までに最大 7 日で申請できる（`validateBoostRequest`）。
 * 重なる期間の申請（却下を除く）は受け付けない。
 */
export async function requestEventBoost(
  db: Db, accountId: string, appId: string, raw: Record<string, unknown> | null, now: Date = new Date(),
): Promise<{ ok: { boostId: string } } | { error: RequestBoostError }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  const input = validateBoostRequest(raw, now);
  if ('error' in input) return input;
  const { eventName, startsAt, endsAt, expectedVisits } = input.ok;
  const app = await withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId, kind: apps.kind }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    return a;
  });
  if ('error' in app) return app;
  if (app.kind !== 'dynamic') return { error: 'not_dynamic' };
  // 申請の時点でプランがあること（開始日に付与が残っているかは承認時に運営者が見る）。
  if ((await resolveEntitlements(db, app.ownerId, now)).plan === 'none') return { error: 'plan_required' };
  return withAccount(db, accountId, async (tx) => {
    // 同じアプリの申請を直列にして、重なりの確認と作成の間に別の申請が入らないようにする。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`boost:${appId}`}, 0))`);
    const overlap = await tx.select({ id: eventBoosts.id }).from(eventBoosts).where(and(
      eq(eventBoosts.appId, appId), ne(eventBoosts.status, 'rejected'), lt(eventBoosts.startsAt, endsAt), gt(eventBoosts.endsAt, startsAt))).limit(1);
    if (overlap.length > 0) return { error: 'overlap' as const };
    const [row] = await tx.insert(eventBoosts).values({ appId, ownerId: app.ownerId, requestedBy: accountId, eventName, startsAt, endsAt, expectedVisits }).returning({ id: eventBoosts.id });
    return { ok: { boostId: row!.id } };
  });
}

export async function listEventBoosts(db: Db, accountId: string, appId: string) {
  if (!UUID.test(appId)) return [];
  return withAccount(db, accountId, (tx) => tx.select({
    id: eventBoosts.id, eventName: eventBoosts.eventName, startsAt: eventBoosts.startsAt, endsAt: eventBoosts.endsAt,
    expectedVisits: eventBoosts.expectedVisits, status: eventBoosts.status, rejectReason: eventBoosts.rejectReason,
  }).from(eventBoosts).where(eq(eventBoosts.appId, appId)).orderBy(eventBoosts.startsAt));
}

export async function listPendingEventBoosts(db: Db) {
  return withSystem(db, (tx) => tx.select().from(eventBoosts).where(eq(eventBoosts.status, 'requested')).orderBy(eventBoosts.createdAt));
}

interface ReviewOpts { reviewedBy: string; now?: Date; mailer?: Mailer; emailKey?: Buffer }
export type ReviewBoostError = 'not_found' | 'not_requested' | 'expired' | 'invalid_amount' | 'reason';

/**
 * 承認。運営者が上げ幅（転送量・メモリ）を調整する。アプリ宛ての付与（`event_boost`）を作り、期間中だけ `resolveEntitlements(..., { appId })` が
 * 転送量の上限・メモリを上乗せしてスリープをオフにする。期間が終われば付与の期限で自動的に元に戻る。
 * 異常検知の急増基準を緩める値 `anomalyThresholdMultiplier` は付与の `params` に持つだけ（使うのはフェーズ 6）。
 */
export async function approveEventBoost(
  db: Db, boostId: string, adj: { extraTransferBytes?: number; extraMemoryMb?: number; anomalyThresholdMultiplier?: number }, opts: ReviewOpts,
): Promise<{ ok: { grantId: string } } | { error: ReviewBoostError }> {
  const now = opts.now ?? new Date();
  const extraTransferBytes = adj.extraTransferBytes ?? BOOST_DEFAULTS.extraTransferBytes;
  const extraMemoryMb = adj.extraMemoryMb ?? BOOST_DEFAULTS.extraMemoryMb;
  const multiplier = adj.anomalyThresholdMultiplier ?? 2;
  const okInt = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!okInt(extraTransferBytes, MAX_EXTRA_TRANSFER_BYTES) || !okInt(extraMemoryMb, MAX_EXTRA_MEMORY_MB) || !(multiplier >= 1 && multiplier <= 100)) return { error: 'invalid_amount' };
  const r = await withSystem(db, async (tx) => {
    const [b] = await tx.select().from(eventBoosts).where(eq(eventBoosts.id, boostId)).for('update');
    if (!b) return { error: 'not_found' as const };
    if (b.status !== 'requested') return { error: 'not_requested' as const };
    if (b.endsAt.getTime() <= now.getTime()) return { error: 'expired' as const };
    const [g] = await tx.insert(grants).values({
      targetKind: 'app', targetId: b.appId, kind: 'event_boost',
      params: { extraTransferBytes, extraMemoryMb, sleepOff: true, anomalyThresholdMultiplier: multiplier },
      startsAt: b.startsAt, endsAt: b.endsAt, suspendOn: null, reason: `event boost: ${b.eventName}`, approvedBy: opts.reviewedBy,
    }).returning({ id: grants.id });
    await tx.update(eventBoosts).set({ status: 'approved', extraTransferBytes, extraMemoryMb, grantId: g!.id, reviewedBy: opts.reviewedBy, reviewedAt: now }).where(eq(eventBoosts.id, boostId));
    return { ok: { grantId: g!.id, ownerId: b.ownerId, eventName: b.eventName, startsAt: b.startsAt, endsAt: b.endsAt } };
  });
  if ('error' in r) return r;
  const { ok } = r;
  await mailBoost(db, ok.ownerId, opts, 'approved', (l) => ({ eventName: ok.eventName, startsAt: jstDate(l, ok.startsAt), endsAt: jstDate(l, new Date(ok.endsAt.getTime() - 1)) }));
  return { ok: { grantId: ok.grantId } };
}

export async function rejectEventBoost(db: Db, boostId: string, reason: string, opts: ReviewOpts): Promise<{ ok: true } | { error: ReviewBoostError }> {
  const text = reason.trim();
  if (text.length < 1 || text.length > 500) return { error: 'reason' };
  const now = opts.now ?? new Date();
  const [row] = await withSystem(db, (tx) => tx.update(eventBoosts).set({ status: 'rejected', rejectReason: text, reviewedBy: opts.reviewedBy, reviewedAt: now })
    .where(and(eq(eventBoosts.id, boostId), eq(eventBoosts.status, 'requested'))).returning({ ownerId: eventBoosts.ownerId, eventName: eventBoosts.eventName }));
  if (!row) {
    const [exists] = await withSystem(db, (tx) => tx.select({ id: eventBoosts.id }).from(eventBoosts).where(eq(eventBoosts.id, boostId)));
    return { error: exists ? 'not_requested' : 'not_found' };
  }
  await mailBoost(db, row.ownerId, opts, 'rejected', () => ({ eventName: row.eventName, reason: text }));
  return { ok: true };
}

async function mailBoost(db: Db, ownerId: string, opts: ReviewOpts, kind: 'approved' | 'rejected', params: (l: Locale) => Record<string, string>): Promise<void> {
  if (!opts.mailer || !opts.emailKey) return;
  try {
    const target = await ownerContact(db, ownerId, opts.emailKey);
    if (!target) return;
    await opts.mailer.sendMail(target.email, t(target.locale, `boost.${kind}Subject`), t(target.locale, `boost.${kind}Body`, params(target.locale)));
  } catch (e) {
    console.error('event boost mail failed', e);
  }
}

/**
 * 期間の頭と終わりに、動いているコンテナを作り直して新しい上限（メモリ）に切り替える。
 * 頭: 承認済みで開始時刻を過ぎ、まだ反映していないもの。終わり: 承認済みで終了時刻を過ぎ、まだ戻していないもの。
 * 眠っているアプリは何もしない（次に起こすときに、その時点のプランの上限で起動する）。作り直しは対象アプリの起動ロックの下で行う。
 * スリープの再開とトラフィックの上限は付与の期限で自動的に戻るので、ここでは触らない。返り値は作り直した数。
 */
export async function reconcileEventBoosts(db: Db, rt: DynamicRuntime, now: Date = new Date()): Promise<number> {
  const due = await withSystem(db, async (tx) => {
    const starting = await tx.select({ id: eventBoosts.id, appId: eventBoosts.appId, kind: sql<'apply'>`'apply'` }).from(eventBoosts)
      .where(and(eq(eventBoosts.status, 'approved'), isNull(eventBoosts.appliedAt), lte(eventBoosts.startsAt, now), gt(eventBoosts.endsAt, now)));
    const ended = await tx.select({ id: eventBoosts.id, appId: eventBoosts.appId, kind: sql<'restore'>`'restore'` }).from(eventBoosts)
      .where(and(eq(eventBoosts.status, 'approved'), isNull(eventBoosts.restoredAt), lte(eventBoosts.endsAt, now)));
    return [...starting, ...ended];
  });
  if (due.length === 0) return 0;
  const running = new Set((await rt.driver.runningCount()).map((r) => r.appId));
  let n = 0;
  for (const b of due) {
    try {
      if (running.has(b.appId) && (await recreateApp(db, rt, b.appId, now))) n++;
      await withSystem(db, (tx) => tx.update(eventBoosts).set(b.kind === 'apply' ? { appliedAt: now } : { restoredAt: now, appliedAt: sql`COALESCE(${eventBoosts.appliedAt}, ${now.toISOString()}::timestamptz)` })
        .where(eq(eventBoosts.id, b.id)));
    } catch (e) {
      console.error('event boost reconcile failed', b.id, e); // 印を付けないので次回に再試行
    }
  }
  return n;
}

/** 動いているコンテナを止めて、`now` 時点の上限で起動し直す（ヘルスチェックに通らなければ止めて眠った状態に戻し、次のアクセスで通常の起動に任せる）。 */
async function recreateApp(db: Db, rt: DynamicRuntime, appId: string, now: Date): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const [a] = await withSystem(db, (tx) => tx.select({ active: apps.activeDeploymentId, ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId)));
    if (!a?.active) return false;
    const spec = await buildRunSpec(db, rt, appId, a.active, now);
    if (!spec) return false;
    await rt.driver.stopDeployment(appId, a.active);
    await rt.driver.start({ ...spec, limits: await runLimitsFor(db, a.ownerId, appId, now) });
    const health = await waitHealthy(rt.driver, appId, a.active, rt.health);
    if (!health.ok) {
      await rt.driver.stopDeployment(appId, a.active).catch(() => undefined);
      console.error('event boost: recreated container was not healthy; left asleep', appId);
    }
    return true;
  };
  return rt.lock ? rt.lock(appId, run) : run();
}
