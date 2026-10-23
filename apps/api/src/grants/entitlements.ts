import { and, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { buildEntitlements, isLimitSettingKey, validLimitValue, type BoostParams, type Entitlements, type LimitOverrides } from 'shared';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { grants, owners, platformSettings, teamMembers } from '../db/schema.js';

/** `platform_settings` の上限の上書き（`limits.*` のキーだけ、値が妥当なものだけ）。システム側（owner ロール）で読む。 */
export async function loadLimitOverrides(db: Db | Tx): Promise<LimitOverrides> {
  const rows = await withSystem(db, (tx) => tx.select({ key: platformSettings.key, value: platformSettings.value }).from(platformSettings));
  const out: LimitOverrides = {};
  for (const r of rows) if (isLimitSettingKey(r.key) && validLimitValue(r.value)) out[r.key] = r.value;
  return out;
}

const asBoost = (p: unknown): BoostParams => {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const n = (v: unknown): number | undefined => (validLimitValue(v) ? v : undefined);
  return { extraTransferBytes: n(o.extraTransferBytes), extraMemoryMb: n(o.extraMemoryMb), sleepOff: o.sleepOff === true };
};

/**
 * オーナー宛ての付与の絞り込み。個人オーナー = そのアカウントの付与とオーナー宛て。チームオーナー = チームの owner ロールのメンバーの付与（チームは彼らのプランを引き継ぐ）とオーナー宛て。
 */
export async function ownerGrantFilter(tx: Tx, ownerId: string, appId?: string) {
  const [o] = await tx.select({ accountId: owners.accountId, teamId: owners.teamId }).from(owners).where(eq(owners.id, ownerId));
  const accountIds = o?.accountId ? [o.accountId]
    : o?.teamId ? (await tx.select({ id: teamMembers.accountId }).from(teamMembers).where(and(eq(teamMembers.teamId, o.teamId), eq(teamMembers.role, 'owner')))).map((m) => m.id) : [];
  // アプリ宛て（イベントブースト）は `appId` を渡したときだけ含める。オーナー全体の上限にはアプリ宛てを混ぜない。
  const forApp = appId ? [and(eq(grants.targetKind, 'app'), eq(grants.targetId, appId))] : [];
  return or(
    and(eq(grants.targetKind, 'owner'), eq(grants.targetId, ownerId)),
    ...(accountIds.length > 0 ? [and(eq(grants.targetKind, 'account'), inArray(grants.targetId, accountIds))] : []),
    ...forApp,
  );
}

/**
 * オーナー（個人 or チーム）の、`at` 時点のプランと上限。付与なし = 「なし」（動的アプリは動かせない）。
 * 付与はアカウント宛て（個人オーナーのとき）とオーナー宛て。有効 = 取り消されておらず `starts_at <= at <= ends_at`（`ends_at` は最後の瞬間。Student は 3/31 23:59:59.999 JST）（期限切れで自動的に「なし」に戻る）。
 * `appId` を渡すと、そのアプリ宛てのイベントブーストも上乗せする（アプリ単位の転送量・メモリ・スリープ）。
 * システム側（owner ロール）で読むので、利用者のトランザクション（withAccount）の外から呼ぶこと。
 */
export async function resolveEntitlements(db: Db | Tx, ownerId: string, at: Date = new Date(), opts: { appId?: string } = {}): Promise<Entitlements> {
  const [rows, overrides] = await Promise.all([
    withSystem(db, async (tx) => {
      const mine = await ownerGrantFilter(tx, ownerId, opts.appId);
      return tx.select().from(grants).where(and(mine, isNull(grants.revokedAt), lte(grants.startsAt, at), gte(grants.endsAt, at), inArray(grants.kind, ['student', 'starter', 'event_boost'])));
    }),
    loadLimitOverrides(db),
  ]);
  const base = rows.filter((g) => g.kind === 'student' || g.kind === 'starter');
  const latest = base.reduce<(typeof base)[number] | null>((a, g) => (!a || g.endsAt > a.endsAt ? g : a), null);
  return buildEntitlements({
    student: base.some((g) => g.kind === 'student'),
    starter: base.some((g) => g.kind === 'starter'),
    boosts: rows.filter((g) => g.kind === 'event_boost').map((g) => asBoost(g.params)),
    overrides, endsAt: latest?.endsAt ?? null, suspendOn: latest?.suspendOn ?? null,
  });
}
