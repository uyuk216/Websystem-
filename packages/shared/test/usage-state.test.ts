import { describe, expect, it } from 'vitest';
import {
  TIME_REASONS, USAGE_EVENTS, USAGE_REASONS, applyUsageEvent, isStoppedState, nextEvaluationAt, reregistrationFiscalKey, stateOf, timeReasonFor,
  type GrantFacts, type UsageEvent, type UsageReason, type UsageState,
} from '../src/index.js';

const jst = (s: string) => new Date(`${s}+09:00`);
const R = (...r: UsageReason[]): UsageReason[] => r;

describe('stateOf: 優先順位 凍結 > ブロック > 停止 > 猶予 > 有効', () => {
  const rows: [UsageReason[], UsageState][] = [
    [R(), 'active'],
    [R('grace'), 'grace'],
    [R('not_reregistered'), 'suspended'],
    [R('grant_revoked'), 'suspended'],
    [R('manual_block'), 'blocked'],
    [R('manual_freeze'), 'frozen'],
    [R('grace', 'manual_block'), 'blocked'],
    [R('not_reregistered', 'manual_block'), 'blocked'],
    [R('manual_block', 'manual_freeze'), 'frozen'],
    [R('grace', 'not_reregistered', 'manual_block', 'manual_freeze'), 'frozen'],
  ];
  it.each(rows)('%j -> %s', (reasons, state) => expect(stateOf(reasons)).toBe(state));
  it('猶予は動かしたまま、停止・ブロック・凍結はコンテナを止める', () => {
    expect((['active', 'grace', 'suspended', 'blocked', 'frozen'] as const).map(isStoppedState)).toEqual([false, false, true, true, true]);
  });
});

describe('applyUsageEvent: 全イベント x 全理由の組み合わせ表', () => {
  const subsets = (): UsageReason[][] => {
    const out: UsageReason[][] = [];
    for (let m = 0; m < 1 << USAGE_REASONS.length; m++) out.push(USAGE_REASONS.filter((_, i) => m & (1 << i)));
    return out;
  };
  const MANUAL: Partial<Record<UsageEvent, [UsageReason, 'add' | 'remove']>> = {
    manual_block: ['manual_block', 'add'], manual_unblock: ['manual_block', 'remove'],
    manual_freeze: ['manual_freeze', 'add'], manual_unfreeze: ['manual_freeze', 'remove'],
  };
  const timeReasons: (UsageReason | null)[] = [null, ...TIME_REASONS];

  it('手動のイベントは自分の理由だけを足す／外す。ほかの理由（時間の理由・もう一方の手動）は変えない', () => {
    for (const from of subsets()) for (const [event, [reason, op]] of Object.entries(MANUAL) as [UsageEvent, [UsageReason, 'add' | 'remove']][]) for (const tr of timeReasons) {
      const expected = new Set(from);
      if (op === 'add') expected.add(reason); else expected.delete(reason);
      const got = applyUsageEvent({ reasons: from, paid: false }, event, tr);
      expect(new Set(got.reasons), `${from} + ${event}`).toEqual(expected);
      expect(got.paid).toBe(false);
    }
  });

  it('時間のイベントは時間の理由を計算し直すだけ。手動の理由は変えず、イベントの種類で結果は変わらない', () => {
    const time = USAGE_EVENTS.filter((e) => !(e in MANUAL) && e !== 'pro_started');
    expect(time).toEqual(['fiscal_year_rollover', 'month_start_reset', 'grant_expired', 'grant_revoked', 'reregistered']);
    for (const from of subsets()) for (const tr of timeReasons) {
      const expected = new Set(from.filter((r) => !TIME_REASONS.includes(r)));
      if (tr) expected.add(tr);
      for (const e of time) expect(new Set(applyUsageEvent({ reasons: from, paid: false }, e, tr).reasons), `${from} + ${e}`).toEqual(expected);
    }
  });

  it('上位の別の理由が残る間は、解除しても戻らない', () => {
    // 停止中に凍結 -> 再登録しても凍結のまま -> 凍結を解除して初めて有効
    let s = applyUsageEvent({ reasons: R('not_reregistered'), paid: false }, 'manual_freeze', 'not_reregistered');
    expect(stateOf(s.reasons)).toBe('frozen');
    s = applyUsageEvent(s, 'reregistered', null);
    expect(stateOf(s.reasons)).toBe('frozen');
    s = applyUsageEvent(s, 'manual_unfreeze', null);
    expect(stateOf(s.reasons)).toBe('active');
    // ブロック中に期限切れ -> ブロックを解除すると停止（猶予ではなく）に戻る
    s = applyUsageEvent({ reasons: R('manual_block'), paid: false }, 'grant_expired', 'not_reregistered');
    expect(stateOf(s.reasons)).toBe('blocked');
    s = applyUsageEvent(s, 'manual_unblock', 'not_reregistered');
    expect(stateOf(s.reasons)).toBe('suspended');
    // 凍結 -> ブロックの順に足しても、凍結を解除してもブロックが残る
    s = applyUsageEvent(applyUsageEvent({ reasons: R(), paid: false }, 'manual_freeze', null), 'manual_block', null);
    expect(stateOf(applyUsageEvent(s, 'manual_unfreeze', null).reasons)).toBe('blocked');
  });

  it('pro_started（フェーズ 7 の予約）: 有料の印を付け、時間の理由を外し、以後付けない。手動の理由は残る', () => {
    const s = applyUsageEvent({ reasons: R('grace', 'manual_block'), paid: false }, 'pro_started', null);
    expect(s).toEqual({ reasons: R('manual_block'), paid: true });
    expect(applyUsageEvent(s, 'grant_expired', 'not_reregistered').reasons).toEqual(R('manual_block'));
  });
});

describe('timeReasonFor / nextEvaluationAt', () => {
  const g = (ends: string, suspend: string | null = null, revoked = false): GrantFacts => ({ endsAt: jst(ends), suspendOn: suspend ? jst(suspend) : null, revoked });
  const student = g('2027-03-31T23:59:59', '2027-05-01T00:00:00');
  it('付与がなければ理由なし。期限内は理由なし、期限の最後の瞬間までは有効', () => {
    expect(timeReasonFor([], jst('2027-06-01T00:00:00'))).toBeNull();
    expect(timeReasonFor([student], jst('2027-03-31T23:59:59'))).toBeNull();
  });
  it('3/31 の後は猶予、5/1 00:00 から停止', () => {
    expect(timeReasonFor([student], jst('2027-04-01T00:00:00'))).toBe('grace');
    expect(timeReasonFor([student], jst('2027-04-30T23:59:59'))).toBe('grace');
    expect(timeReasonFor([student], jst('2027-05-01T00:00:00'))).toBe('not_reregistered');
  });
  it('再登録（新しい付与）で理由が消える。取り消しだけが残っていれば grant_revoked', () => {
    expect(timeReasonFor([student, g('2028-03-31T23:59:59', '2028-05-01T00:00:00')], jst('2027-06-01T00:00:00'))).toBeNull();
    expect(timeReasonFor([g('2027-03-31T23:59:59', null, true)], jst('2027-01-01T00:00:00'))).toBe('grant_revoked');
    expect(timeReasonFor([g('2027-03-31T23:59:59', null, true), student], jst('2027-02-01T00:00:00'))).toBeNull();
  });
  it('停止日がない付与（Starter）は終了の直後から停止', () => {
    expect(timeReasonFor([g('2027-02-01T00:00:00')], jst('2027-02-01T00:00:01'))).toBe('not_reregistered');
  });
  it('次の評価は期限の直後、猶予中は停止日。停止後・付与なしは無し', () => {
    expect(nextEvaluationAt([student], jst('2027-01-01T00:00:00'))).toEqual(new Date(jst('2027-03-31T23:59:59').getTime() + 1));
    expect(nextEvaluationAt([student], jst('2027-04-10T00:00:00'))).toEqual(jst('2027-05-01T00:00:00'));
    expect(nextEvaluationAt([student], jst('2027-05-02T00:00:00'))).toBeNull();
    expect(nextEvaluationAt([], jst('2027-05-02T00:00:00'))).toBeNull();
  });
  it('再登録の案内は 3 月（JST）だけ', () => {
    expect(reregistrationFiscalKey(jst('2027-03-01T00:00:00'))).toBe('FY2026');
    expect(reregistrationFiscalKey(jst('2027-02-28T23:59:59'))).toBeNull();
    expect(reregistrationFiscalKey(jst('2027-04-01T00:00:00'))).toBeNull();
  });
});
