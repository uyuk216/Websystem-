/**
 * 利用の状態遷移の規則（フェーズ 5 Task 7）。副作用のない純粋関数だけ。DB を触る 1 か所の入口は
 * `apps/api/src/usage/state.ts` の `transitionUsageState`。
 *
 * 状態は「理由の集合」から決まる。優先順位は 凍結 > ブロック > 停止 > 猶予 > 有効。
 * 解除は自分の理由を外すだけなので、上位の別の理由が残っていれば状態は戻らない。
 */

export const USAGE_STATES = ['active', 'grace', 'suspended', 'blocked', 'frozen'] as const;
export type UsageState = (typeof USAGE_STATES)[number];

/** 理由。`grace` / `not_reregistered` / `grant_revoked` は時刻と付与から計算される（時間の理由）。`manual_*` は運営者の操作。 */
export const USAGE_REASONS = ['grace', 'not_reregistered', 'grant_revoked', 'manual_block', 'manual_freeze'] as const;
export type UsageReason = (typeof USAGE_REASONS)[number];
export const TIME_REASONS: readonly UsageReason[] = ['grace', 'not_reregistered', 'grant_revoked'];

const REASON_STATE: Record<UsageReason, UsageState> = {
  grace: 'grace', not_reregistered: 'suspended', grant_revoked: 'suspended', manual_block: 'blocked', manual_freeze: 'frozen',
};
const PRIORITY: Record<UsageState, number> = { active: 0, grace: 1, suspended: 2, blocked: 3, frozen: 4 };

/** 理由の集合から状態を決める（優先順位が最も高い理由の状態）。 */
export function stateOf(reasons: Iterable<UsageReason>): UsageState {
  let best: UsageState = 'active';
  for (const r of reasons) if (PRIORITY[REASON_STATE[r]] > PRIORITY[best]) best = REASON_STATE[r];
  return best;
}

/** 動的アプリのコンテナを止めておく状態（データ・イメージは残す）。猶予は動かしたまま。 */
export const isStoppedState = (s: UsageState): boolean => s === 'suspended' || s === 'blocked' || s === 'frozen';

export const USAGE_EVENTS = [
  'fiscal_year_rollover', 'month_start_reset', 'grant_expired', 'grant_revoked', 'reregistered',
  'manual_block', 'manual_unblock', 'manual_freeze', 'manual_unfreeze',
  /** フェーズ 7 の予約。いまは「有料になった」印を付けて時間の理由を外すだけ。 */
  'pro_started',
] as const;
export type UsageEvent = (typeof USAGE_EVENTS)[number];

const TIME_EVENTS: readonly UsageEvent[] = ['fiscal_year_rollover', 'month_start_reset', 'grant_expired', 'grant_revoked', 'reregistered'];
export const isTimeEvent = (e: UsageEvent): boolean => TIME_EVENTS.includes(e);

export interface GrantFacts {
  endsAt: Date;
  suspendOn: Date | null;
  revoked: boolean;
}

/**
 * 付与の事実と時刻から「時間の理由」を決める。付与（Student / Starter）が一度もなければ null（そもそも無料プランに入っていない）。
 * 有効な付与が 1 つでもあれば null。なければ、取り消されていない付与のうち最も遅く終わるものを見て、
 * 停止日（`suspendOn`、無ければ終了の直後）を過ぎていれば `not_reregistered`、まだなら `grace`。取り消されたものしかなければ `grant_revoked`。
 * イベントの種類（年度の切り替え・月初・期限切れ…）には依存しない。だから同じ日に重なっても結果は同じ。
 */
export function timeReasonFor(grants: readonly GrantFacts[], at: Date): UsageReason | null {
  if (grants.length === 0) return null;
  const live = grants.filter((g) => !g.revoked);
  if (live.some((g) => g.endsAt.getTime() >= at.getTime())) return null;
  if (live.length === 0) return 'grant_revoked';
  const last = live.reduce((a, g) => (g.endsAt > a.endsAt ? g : a));
  const suspendOn = last.suspendOn ?? new Date(last.endsAt.getTime() + 1);
  return at.getTime() >= suspendOn.getTime() ? 'not_reregistered' : 'grace';
}

export interface UsageSnapshot {
  reasons: readonly UsageReason[];
  /** 有料になった（フェーズ 7）。時間の理由は付かない。 */
  paid: boolean;
}

/**
 * イベントを 1 つ適用した結果（理由の集合と有料の印）。時間のイベントは時間の理由を計算し直すだけ（`timeReason` は
 * `timeReasonFor` の結果）。手動のイベントは自分の理由を足す／外すだけ。
 */
export function applyUsageEvent(prev: UsageSnapshot, event: UsageEvent, timeReason: UsageReason | null): UsageSnapshot {
  const reasons = new Set(prev.reasons);
  let paid = prev.paid;
  const dropTime = () => { for (const r of TIME_REASONS) reasons.delete(r); };
  switch (event) {
    case 'manual_block': reasons.add('manual_block'); break;
    case 'manual_unblock': reasons.delete('manual_block'); break;
    case 'manual_freeze': reasons.add('manual_freeze'); break;
    case 'manual_unfreeze': reasons.delete('manual_freeze'); break;
    case 'pro_started': paid = true; dropTime(); break;
    default: // 時間のイベント
      dropTime();
      if (!paid && timeReason) reasons.add(timeReason);
  }
  return { reasons: USAGE_REASONS.filter((r) => reasons.has(r)), paid };
}

/** 次に評価する日時（時間の理由が変わりうる最も近い時刻）。無ければ null。 */
export function nextEvaluationAt(grants: readonly GrantFacts[], at: Date): Date | null {
  const live = grants.filter((g) => !g.revoked);
  if (live.length === 0) return null;
  const last = live.reduce((a, g) => (g.endsAt > a.endsAt ? g : a));
  if (last.endsAt.getTime() >= at.getTime()) return new Date(last.endsAt.getTime() + 1); // 期限の直後に猶予へ
  const suspendOn = last.suspendOn ?? new Date(last.endsAt.getTime() + 1);
  return suspendOn.getTime() > at.getTime() ? suspendOn : null;
}

/** 翌年度の再登録の受付は 3 月 1 日（JST）から。受付開始の案内（メール）を出す年度のキー（例 'FY2026'）。3 月だけ、それ以外は null。 */
export function reregistrationFiscalKey(at: Date): string | null {
  const j = new Date(at.getTime() + 9 * 3600_000);
  return j.getUTCMonth() + 1 === 3 ? `FY${j.getUTCFullYear() - 1}` : null;
}
